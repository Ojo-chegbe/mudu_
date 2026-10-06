import { randomUUID } from 'node:crypto';
import { Rosters } from './rosters.ts';
import { notificationFeed, readNotifications } from './notifications.ts';
import { resultsDisposition } from './export-filename.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { identifier, object, parseAssessment, text } from '../../packages/exam-core/engine.ts';
import { DomainError } from '../../packages/exam-core/model.ts';
import { transaction } from './database.ts';
import { ExamStore } from './store.ts';
import type { Session } from './store.ts';
import { digest, hashPassword, RateLimiter, token, verifyPassword } from './security.ts';
import { IdentityService, accountPassword, emailAddress, registrationConfig } from './identity.ts';
import type { LocalDelivery } from './local-delivery.ts';
import { AssessmentEditing } from './assessment-editing.ts';
import { QuestionBank } from './question-bank.ts';
import { QuestionGeneration } from './question-generation.ts';
import { uploadDocument } from './document-upload.ts';
import { LiveMonitoring } from './monitoring.ts';
import { syncLinkedRosters } from './roster-admission.ts';
import { ExamControls } from './exam-controls.ts';
import type { CloudAuthProvider, CloudSession } from './supabase-auth.ts';
import { CloudAdministrators } from './cloud-administrators.ts';
import { CloudCandidates } from './cloud-candidates.ts';
import type { CloudRosterStorage } from './cloud-roster-storage.ts';
import { CloudRosters } from './cloud-rosters.ts';
import type { CloudRecords } from './cloud-records.ts';
import { CloudSync } from './cloud-sync.ts';
import type { CloudBankStorage } from './cloud-bank-storage.ts';
import { CloudQuestionBank } from './cloud-question-bank.ts';
import { CloudAuthoring } from './cloud-authoring.ts';
import type { AuthoringStorage } from './cloud-authoring-storage.ts';
import { LocalPreparation } from './local-preparation.ts';
import type { PreparationStorage } from './local-preparation-storage.ts';
import { onlineHttp } from './online-http.ts';
import type { OnlineExecution } from './online-execution.ts';
import { PasswordRecovery } from './password-recovery.ts';
import { WorkspaceConnection } from './workspace-connection.ts';
import { accountProfile, preferences, savePreferences } from './account-settings.ts';

interface HostOptions {
  online?: OnlineExecution;
  cloudPreparation?: PreparationStorage;
  preparationKey?: Buffer;
  onLocalPreparation?: (preparation: LocalPreparation) => void;
  cloudAuthoring?: AuthoringStorage;
  onCloudAuthoring?: (authoring: CloudAuthoring) => void;
  cloudRosters?: CloudRosterStorage;
  onCloudRosters?: (rosters: CloudRosters) => void;
  cloudBank?: CloudBankStorage;
  onCloudBank?: (bank: CloudQuestionBank) => void;
  cloudRecords?: CloudRecords;
  onCloudSync?: (sync: CloudSync) => void;
  cloudAuth?: { provider: CloudAuthProvider; sessionKey: Buffer };
  localDelivery?: LocalDelivery;
  candidateListener?: boolean;
  origin: string;
  webOrigin?: string;
  secure?: boolean;
  staticDir?: string;
  now?: () => number;
  identityMode?: 'primary' | 'replica';
}
const isLoopback = (address?: string) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '');
const cookieName = 'mudu_session';

function send(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json'))
    throw new DomainError('Use application/json.', 415);
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new DomainError('Request exceeds the 1 MB limit.', 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('Invalid JSON.');
  }
}
function rawSession(request: IncomingMessage) {
  return (
    (request.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1) ?? ''
  );
}
function csvCell(value: unknown) {
  let string = String(value ?? '');
  if (/^[\s]*[=+\-@]/.test(string) || /^[\t\r\n]/.test(string)) string = `'${string}`;
  return `"${string.replaceAll('"', '""')}"`;
}

export async function createHandler(db: DatabaseSync, options: HostOptions) {
  const releaseVersion = String(
    JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version,
  );
  const store = new ExamStore(db, options.now);
  const identity = new IdentityService(store);
  const bank = new QuestionBank(store);
  const monitoring = new LiveMonitoring(store);
  const controls = new ExamControls(store);
  const generation = new QuestionGeneration(store);
  const cloud = options.cloudAuth
    ? new CloudAdministrators(store, options.cloudAuth.provider, options.cloudAuth.sessionKey)
    : null;
  const cloudCandidates = options.cloudAuth
    ? new CloudCandidates(store, options.cloudAuth.sessionKey)
    : null;
  const connection = new WorkspaceConnection(store, cloud);
  const localDevice = (request: IncomingMessage) =>
    isLoopback(request.socket.remoteAddress) &&
    !options.candidateListener &&
    options.identityMode !== 'replica';
  const cloudSignedIn = (request: IncomingMessage) =>
    Boolean(
      db
        .prepare('SELECT 1 FROM provider_sessions WHERE token_hash=?')
        .get(digest(rawSession(request))),
    ) && connection.online(rawSession(request));
  const limiter = new RateLimiter();
  const recovery = options.cloudAuth
    ? new PasswordRecovery(store, options.cloudAuth.provider, options.cloudAuth.sessionKey)
    : null;
  const cloudSync =
    cloud &&
    options.cloudRecords &&
    !options.candidateListener &&
    options.identityMode !== 'replica'
      ? new CloudSync(store, cloud, options.cloudRecords)
      : null;
  if (cloudSync) options.onCloudSync?.(cloudSync);
  const cloudBank =
    cloud && options.cloudBank && !options.candidateListener && options.identityMode !== 'replica'
      ? new CloudQuestionBank(store, cloud, options.cloudBank)
      : null;
  if (cloudBank) options.onCloudBank?.(cloudBank);
  const cloudRosters =
    cloud &&
    options.cloudRosters &&
    !options.candidateListener &&
    options.identityMode !== 'replica'
      ? new CloudRosters(store, cloud, options.cloudRosters)
      : null;
  if (cloudRosters) options.onCloudRosters?.(cloudRosters);
  const authoring = new CloudAuthoring(
    store,
    cloud,
    !options.candidateListener && options.identityMode !== 'replica'
      ? (options.cloudAuthoring ?? null)
      : null,
  );
  options.onCloudAuthoring?.(authoring);
  const preparation = new LocalPreparation(
    store,
    authoring,
    cloud,
    options.candidateListener || options.identityMode === 'replica'
      ? null
      : (options.cloudPreparation ?? null),
    options.preparationKey ?? options.cloudAuth?.sessionKey ?? null,
  );
  options.onLocalPreparation?.(preparation);
  const dummyHash = await hashPassword(token());
  const origins = new Set([options.origin, ...(options.webOrigin ? [options.webOrigin] : [])]);
  const hosts = new Set([...origins].map((origin) => new URL(origin).host));
  let authoringBusy = false;
  store.reconcile();
  transaction(db, () => syncLinkedRosters(store, 'system'));
  function requirePrimaryIdentity() {
    if (options.identityMode === 'replica')
      throw new DomainError(
        'Account and registration changes belong to the primary MUDU service. Use your existing identity; this Host does not create another account.',
        409,
      );
  }

  function requireSession(request: IncomingMessage, role?: Session['role']): Session {
    const session = store.session(rawSession(request));
    if (!session) throw new DomainError('Please sign in again.', 401, 'UNAUTHENTICATED');
    if (session.account_id && !preparation.scope(rawSession(request))) requirePrimaryIdentity();
    if (role && session.role !== role)
      throw new DomainError('You do not have permission to do that.', 403);
    if (
      session.role === 'admin' &&
      !isLoopback(request.socket.remoteAddress) &&
      !(
        cloud &&
        options.secure &&
        !options.candidateListener &&
        db
          .prepare('SELECT 1 FROM provider_sessions WHERE token_hash=?')
          .get(digest(rawSession(request)))
      )
    )
      throw new DomainError('Open administration on the Host computer.', 403);
    if (
      !['GET', 'HEAD'].includes(request.method ?? '') &&
      request.headers['x-csrf-token'] !== session.csrf
    )
      throw new DomainError('Request verification failed. Refresh and try again.', 403);
    return session;
  }
  function setSession(response: ServerResponse, raw: string) {
    response.setHeader(
      'Set-Cookie',
      `${cookieName}=${raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${options.secure ? '; Secure' : ''}`,
    );
  }

  return async function handler(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    try {
      if (!hosts.has(request.headers.host ?? ''))
        throw new DomainError('Unrecognized Host address.', 403);
      const url = new URL(request.url ?? '/', options.origin);
      const path = url.pathname;
      const method = request.method ?? 'GET';
      if (path.startsWith('/api/')) {
        const ip = request.socket.remoteAddress ?? 'unknown';
        const onlineRateSession = path.startsWith('/api/online/')
          ? store.session(rawSession(request))
          : null;
        limiter.take(
          onlineRateSession
            ? `online-request:${onlineRateSession.role}:${onlineRateSession.principal_id}`
            : `request:${ip}`,
          1200,
          60000,
        );
        if (!['GET', 'HEAD'].includes(method) && !origins.has(request.headers.origin ?? ''))
          throw new DomainError('Unrecognized request origin.', 403);
        if (path.startsWith('/api/password-recovery/')) {
          if (
            !recovery ||
            !options.cloudAuth?.provider.requestRecovery ||
            options.candidateListener ||
            options.identityMode === 'replica'
          )
            throw new DomainError(
              'Connected account recovery needs the main MUDU service and an internet connection.',
              503,
            );
          const raw =
            (request.headers.cookie ?? '')
              .split(';')
              .map((p) => p.trim())
              .find((p) => p.startsWith('mudu_recovery='))
              ?.slice('mudu_recovery='.length) ?? '';
          if (path === '/api/password-recovery/state' && method === 'GET') {
            const row = recovery.state(raw);
            return send(response, 200, {
              csrf: row.csrf,
              completed: row.completed === 1,
              uncertain: row.completed === 2,
              expiresAt: row.expires_at,
            });
          }
          if (method === 'POST') {
            limiter.take(`recovery:${ip}`, 20, 15 * 60000);
            const input = await body(request);
            if (path === '/api/password-recovery/request') {
              const email = emailAddress(input.email);
              limiter.take(`recovery-email:${digest(email)}`, 3, 15 * 60000);
              const role = input.role === 'candidate' ? 'candidate' : 'admin';
              const redirect = new URL('/account/recovery', options.webOrigin ?? options.origin);
              redirect.searchParams.set('role', role);
              await options.cloudAuth.provider.requestRecovery(email, redirect.href);
              return send(response, 200, { sent: true });
            }
            if (path === '/api/password-recovery/verify') {
              const tokenHash = text(input.tokenHash, 'Reset link', 256, 16);
              if (!/^[a-zA-Z0-9_-]+$/.test(tokenHash))
                throw new DomainError(
                  'This reset link is invalid. Request a new one.',
                  400,
                  'RECOVERY_EXPIRED',
                );
              const opened = await recovery.open(tokenHash, raw);
              response.setHeader(
                'Set-Cookie',
                `mudu_recovery=${opened.raw}; Path=/api/password-recovery; HttpOnly; SameSite=Strict; Max-Age=600${options.secure ? '; Secure' : ''}`,
              );
              return send(response, 200, {
                csrf: opened.csrf,
                expiresAt: opened.expiresAt,
                completed: false,
              });
            }
            if (path === '/api/password-recovery/complete') {
              await recovery.complete(
                raw,
                String(request.headers['x-csrf-token'] ?? ''),
                accountPassword(input.password, true),
              );
              return send(response, 200, { completed: true });
            }
          }
          throw new DomainError('Recovery endpoint not found.', 404);
        }
        const currentSession = store.session(rawSession(request));
        if (
          db
            .prepare('SELECT 1 FROM admin_device_sessions WHERE token_hash=?')
            .get(digest(rawSession(request))) &&
          (!isLoopback(ip) || options.candidateListener || options.identityMode === 'replica')
        )
          throw new DomainError('Offline access is available only on this Host computer.', 403);
        const offlineScope = currentSession && preparation.scope(rawSession(request));
        if (
          offlineScope &&
          ![
            '/api/auth',
            '/api/logout',
            '/api/local-connection',
            '/api/candidate/me',
            '/api/candidate/examinations',
            '/api/local-admission/login',
          ].includes(path) &&
          !new RegExp(
            `^/api/candidate/examinations/${offlineScope}/(?:state|heartbeat|announcements/read|start|submit|answers/[a-f0-9-]{36})$`,
          ).test(path)
        )
          throw new DomainError(
            'This examination access is limited to your prepared local run.',
            403,
          );
        if (path === '/api/local-admission/login' && method === 'POST') {
          if (currentSession?.role === 'admin')
            throw new DomainError('Use a separate browser profile for candidate sign-in.', 409);
          limiter.take(`local-admission:${ip}`, 30, 15 * 60000);
          const input = await body(request);
          limiter.take(`local-pass:${digest(String(input.credential ?? ''))}`, 10, 15 * 60000);
          const session = preparation.login(input);
          setSession(response, session.raw);
          return send(response, 200, { csrf: session.csrf, runId: session.runId });
        }
        if (path === '/api/workspace/connection' && ['GET', 'POST'].includes(method)) {
          requireSession(request, 'admin');
          const raw = rawSession(request);
          if (method === 'POST') {
            if (!localDevice(request))
              throw new DomainError('Connection mode belongs to this Host computer.', 403);
            return send(
              response,
              200,
              await connection.change(raw, (await body(request)).mode, true),
            );
          }
          if (db.prepare('SELECT 1 FROM provider_sessions WHERE token_hash=?').get(digest(raw)))
            await connection.verify(raw, localDevice(request));
          return send(response, 200, connection.status(raw));
        }
        if (path === '/api/candidate/local-passes' && method === 'GET') {
          const session = requireSession(request, 'candidate');
          if (!session.account_id) throw new DomainError('Sign in to your candidate account.', 401);
          return send(response, 200, {
            passes: await preparation.candidatePasses(session.account_id, () => {
              if (requireSession(request, 'candidate').account_id !== session.account_id)
                throw new DomainError('Please sign in again.', 401);
            }),
          });
        }
        const passDownload = path.match(/^\/api\/candidate\/local-passes\/([a-f0-9-]{36})$/);
        if (passDownload && method === 'GET') {
          const session = requireSession(request, 'candidate');
          if (!session.account_id) throw new DomainError('Sign in to your candidate account.', 401);
          return send(
            response,
            200,
            await preparation.candidatePass(session.account_id, passDownload[1], () => {
              if (requireSession(request, 'candidate').account_id !== session.account_id)
                throw new DomainError('Please sign in again.', 401);
            }),
          );
        }
        const preparationAction = path.match(
          /^\/api\/local-preparations\/([a-f0-9-]{36})\/(retry|cancel|members|replacement)$/,
        );
        if (preparationAction) {
          if (!isLoopback(ip) || options.candidateListener)
            throw new DomainError('Manage local preparation on the Host computer.', 403);
          const admin = requireSession(request, 'admin'),
            [, id, action] = preparationAction;
          const revalidate = () => {
            if (requireSession(request, 'admin').principal_id !== admin.principal_id)
              throw new DomainError('Please sign in again.', 401);
          };
          if (action === 'members' && method === 'GET')
            return send(response, 200, { members: preparation.members(admin.principal_id, id) });
          if (method === 'POST') {
            const input = await body(request);
            revalidate();
            if (action === 'retry') {
              await preparation.retry(admin.principal_id, id, revalidate);
              return send(response, 200, { ok: true });
            }
            if (action === 'cancel') {
              preparation.cancel(admin.principal_id, id, input.reason);
              return send(response, 200, { ok: true });
            }
            if (action === 'replacement')
              return send(
                response,
                200,
                preparation.replace(
                  admin.principal_id,
                  id,
                  text(input.accountId, 'Candidate', 36),
                  input.reason,
                  input.operationId,
                ),
              );
          }
        }
        const prepareSource = path.match(
          /^\/api\/assessments\/([a-f0-9-]{36})\/local-preparation$/,
        );
        if (prepareSource) {
          if (!isLoopback(ip) || options.candidateListener)
            throw new DomainError('Prepare local delivery on the Host computer.', 403);
          const admin = requireSession(request, 'admin'),
            id = prepareSource[1];
          if (method === 'GET')
            return send(response, 200, preparation.status(admin.principal_id, id));
          if (method === 'POST') {
            const input = await body(request);
            await authoring.ensure(admin.principal_id, true, id);
            await cloudRosters?.ensure(admin.principal_id, true);
            if (requireSession(request, 'admin').principal_id !== admin.principal_id)
              throw new DomainError('Please sign in again.', 401);
            transaction(db, () => syncLinkedRosters(store, admin.principal_id));
            return send(
              response,
              200,
              await preparation.prepare(admin.principal_id, id, input, () => {
                if (requireSession(request, 'admin').principal_id !== admin.principal_id)
                  throw new DomainError('Please sign in again.', 401);
              }),
            );
          }
        }
        if (
          currentSession &&
          db
            .prepare('SELECT 1 FROM provider_sessions WHERE token_hash=?')
            .get(digest(rawSession(request)))
        ) {
          const localRun = path.match(
            /^\/api\/assessments\/([a-f0-9-]{36})(?:\/(?:launch|end|monitor|controls|results\.csv|review\/[a-f0-9-]{36}))?$/,
          )?.[1];
          const localRecovery = path.match(
            /^\/api\/local-preparations\/([a-f0-9-]{36})\/(members|replacement)$/,
          )?.[1];
          // Preparation grants the existing local session narrowly scoped delivery
          // authority. It is not authorization to use cloud management offline.
          const localAuthority =
            currentSession.role === 'admin' &&
            isLoopback(ip) &&
            Boolean(
              localRun
                ? db
                    .prepare(
                      "SELECT 1 FROM local_preparations WHERE run_id=? AND owner_id=? AND state IN ('ready','completed')",
                    )
                    .get(localRun, currentSession.principal_id)
                : localRecovery
                  ? db
                      .prepare(
                        "SELECT 1 FROM local_preparations WHERE id=? AND owner_id=? AND state IN ('ready','completed')",
                      )
                      .get(localRecovery, currentSession.principal_id)
                  : false,
            );
          // Bootstrap reports the locally issued session, not fresh provider authorization.
          // Public sign-in must work even when an existing cloud session cannot be verified.
          if (
            !localAuthority &&
            ![
              '/api/auth',
              '/api/logout',
              '/api/admin/login',
              '/api/admin/device/login',
              '/api/admin/setup',
              '/api/admin/cloud/login',
              '/api/admin/cloud/signup',
              '/api/candidate/account/login',
              '/api/candidate/account/signup',
              '/api/candidate/cloud/login',
              '/api/candidate/cloud/signup',
            ].includes(path)
          ) {
            if (!cloud || options.candidateListener)
              throw new DomainError('Open your cloud workspace to use this account.', 503);
            if (currentSession.role === 'admin')
              await connection.verify(rawSession(request), localDevice(request));
            else await cloud.verify(rawSession(request));
          }
        }
        if (
          currentSession?.role === 'admin' &&
          connection.status(rawSession(request)).state === 'offline' &&
          (path.startsWith('/api/online/') ||
            (method === 'POST' &&
              (/\/online$/.test(path) ||
                ['/api/question-bank/generate', '/api/assessments/generate'].includes(path))))
        )
          throw new DomainError(
            'This feature needs an online connection. Your local workspace remains available.',
            409,
            'WORKSPACE_OFFLINE',
          );

        if (path.startsWith('/api/account/')) {
          const account = requireSession(request);
          if (
            options.candidateListener ||
            options.identityMode === 'replica' ||
            (account.role === 'candidate' && !account.account_id)
          )
            throw new DomainError('Open account settings on the main MUDU service.', 403);
          const connected =
            account.role === 'admin'
              ? Boolean(
                  db
                    .prepare('SELECT 1 FROM admin_provider_identities WHERE administrator_id=?')
                    .get(account.principal_id),
                )
              : Boolean(
                  db
                    .prepare('SELECT 1 FROM candidate_provider_identities WHERE account_id=?')
                    .get(account.account_id),
                );
          if (path === '/api/account/preferences') {
            if (method === 'GET') return send(response, 200, preferences(store, account));
            if (method === 'POST')
              return send(response, 200, savePreferences(store, account, await body(request)));
          }
          if (path === '/api/account/profile') {
            if (method === 'GET')
              return send(
                response,
                200,
                accountProfile(
                  store,
                  account,
                  !connected || Boolean(options.cloudAuth?.provider.updateName),
                ),
              );
            if (method === 'POST') {
              const name = text((await body(request)).name, 'Your name', 100);
              let updatedIdentity: CloudSession | void = undefined;
              if (connected) {
                if (!cloudSignedIn(request) || !options.cloudAuth?.provider.updateName || !cloud)
                  throw new DomainError(
                    'Reconnect online to update your MUDU profile.',
                    409,
                    'WORKSPACE_OFFLINE',
                  );
                updatedIdentity = await options.cloudAuth.provider.updateName(
                  await cloud.currentCredentials(rawSession(request)),
                  name,
                );
              }
              transaction(db, () => {
                if (requireSession(request).principal_id !== account.principal_id)
                  throw new DomainError('Please sign in again.', 401);
                if (updatedIdentity)
                  cloud!.retainCurrentCredentials(rawSession(request), updatedIdentity);
                db.prepare(
                  account.role === 'admin'
                    ? 'UPDATE administrators SET name=? WHERE id=?'
                    : 'UPDATE accounts SET name=? WHERE id=?',
                ).run(name, account.principal_id);
                store.event(null, account.principal_id, 'profile_updated');
              });
              return send(response, 200, accountProfile(store, account, true));
            }
          }
          if (path === '/api/account/sessions' && method === 'POST') {
            limiter.take(`account-sessions:${ip}`, 10, 15 * 60000);
            const input = await body(request);
            if (connected) {
              if (!cloudSignedIn(request) || !cloud)
                throw new DomainError('Reconnect online to manage account sessions.', 409);
              const current = await cloud.currentCredentials(rawSession(request));
              const verified = await options.cloudAuth!.provider.signIn(
                current.email,
                accountPassword(input.password),
              );
              if (verified.userId !== current.userId)
                throw new DomainError('Account verification failed.', 401);
            } else {
              const row = db
                .prepare(
                  account.role === 'admin'
                    ? 'SELECT password_hash FROM administrators WHERE id=?'
                    : 'SELECT password_hash FROM accounts WHERE id=?',
                )
                .get(account.principal_id);
              if (
                !(await verifyPassword(
                  accountPassword(input.password),
                  String(row?.password_hash ?? dummyHash),
                ))
              )
                throw new DomainError('Check your account password.', 401);
            }
            transaction(db, () => {
              requireSession(request);
              db.prepare(
                'DELETE FROM sessions WHERE role=? AND principal_id=? AND token_hash<>?',
              ).run(account.role, account.principal_id, digest(rawSession(request)));
              store.event(null, account.principal_id, 'other_host_sessions_revoked');
            });
            return send(response, 200, { saved: true });
          }
          if (path === '/api/account/diagnostics' && method === 'GET') {
            response.setHeader(
              'Content-Disposition',
              'attachment; filename="mudu-diagnostics.json"',
            );
            return send(response, 200, {
              generatedAt: new Date().toISOString(),
              version: releaseVersion,
              schema: db.prepare('PRAGMA user_version').get()?.user_version,
              connection: account.role === 'admin' ? connection.status(rawSession(request)) : null,
              preferences: preferences(store, account),
              features: {
                cloudAuthoring: Boolean(options.cloudAuthoring),
                cloudQuestionBank: Boolean(cloudBank),
                cloudRosters: Boolean(cloudRosters),
                cloudResults: Boolean(cloudSync),
                onlineDelivery: Boolean(options.online),
                questionGeneration: account.role === 'admin' && generation.availability().available,
                localDelivery: Boolean(
                  options.localDelivery &&
                  localDevice(request) &&
                  accountProfile(store, account, false).hostOperator,
                ),
              },
            });
          }
          throw new DomainError('Account setting not found.', 404);
        }
        if (
          await onlineHttp({
            request,
            response,
            path,
            method,
            store,
            cloud: cloud ?? null,
            authoring,
            rosters: cloudRosters,
            online: options.online,
            candidateListener: options.candidateListener,
            raw: rawSession(request),
            requireSession: (role) => requireSession(request, role),
            body: () => body(request),
            send: (status, value) => send(response, status, value),
          })
        )
          return;
        if (
          [
            '/api/candidate/cloud/login',
            '/api/candidate/cloud/signup',
            '/api/candidate/cloud/connect',
            '/api/candidate/cloud/connect/signup',
          ].includes(path) &&
          method === 'POST'
        ) {
          if (!cloudCandidates || options.candidateListener || options.identityMode === 'replica')
            throw new DomainError(
              'Cloud sign-in is not available on this local examination address.',
              409,
            );
          if (!options.secure && !isLoopback(request.socket.remoteAddress))
            throw new DomainError('Use the HTTPS address to sign in to your cloud account.', 403);
          limiter.take(`candidate-cloud-auth:${ip}`, 10, 15 * 60000);
          const input = await body(request);
          const email = emailAddress(input.email);
          limiter.take(`candidate-cloud-email:${digest(email)}`, 10, 15 * 60000);
          const password = accountPassword(input.password, path.endsWith('/signup'));
          let existing: string | undefined;
          if (path.includes('/connect')) {
            const local = requireSession(request, 'candidate');
            if (!local.account_id)
              throw new DomainError('Sign in to your existing candidate account first.', 401);
            const account = db
              .prepare('SELECT email,password_hash FROM accounts WHERE id=?')
              .get(local.account_id);
            if (!account || account.email !== email)
              throw new DomainError(
                'Use the same email address as your existing candidate account.',
                409,
              );
            if (
              db
                .prepare('SELECT 1 FROM candidate_provider_identities WHERE account_id=?')
                .get(local.account_id)
            )
              throw new DomainError(
                'This candidate account is already connected. Use cloud sign-in.',
                409,
              );
            if (
              !(await verifyPassword(
                accountPassword(input.localPassword),
                String(account.password_hash),
              ))
            )
              throw new DomainError('Check your existing local password.', 401);
            requireSession(request, 'candidate');
            existing = local.account_id;
          }
          let providerIdentity;
          if (path.endsWith('/signup')) {
            const name = existing
              ? identity.profile(existing).name
              : text(input.name, 'Full name', 100);
            const result = await options.cloudAuth!.provider.signUp(email, password, name);
            if (!result.session)
              return send(response, 202, {
                pending: true,
                message: 'Check your email to confirm your account, then sign in.',
              });
            providerIdentity = result.session;
          } else providerIdentity = await options.cloudAuth!.provider.signIn(email, password);
          // Network calls cannot authorize a session that expired or was revoked
          // while the provider was responding.
          if (existing && requireSession(request, 'candidate').account_id !== existing)
            throw new DomainError('Please sign in again.', 401);
          const opened = cloudCandidates.open(providerIdentity, existing);
          setSession(response, opened.raw);
          return send(response, path.endsWith('/signup') ? 201 : 200, { csrf: opened.csrf });
        }
        const ownedAssessment = path.match(/^\/api\/assessments\/([a-f0-9-]+)/);
        if (path === '/api/assessments' || ownedAssessment || path.startsWith('/api/authoring')) {
          const admin = requireSession(request, 'admin');
          const authoringId =
            ownedAssessment?.[1] ?? path.match(/^\/api\/authoring\/([a-f0-9-]{36})/)?.[1];
          const preparedRun =
            authoringId &&
            Boolean(db.prepare('SELECT 1 FROM local_preparations WHERE run_id=?').get(authoringId));
          if (
            authoringId &&
            !['GET', 'HEAD'].includes(method) &&
            /\/(registration|roster|admission)(\/|$)/.test(path) &&
            db.prepare('SELECT 1 FROM local_preparations WHERE run_id=?').get(authoringId)
          )
            throw new DomainError(
              'Candidate admission is pinned to this prepared run. Prepare another run to change its membership.',
              409,
            );
          if (
            !preparedRun &&
            (method === 'GET' ||
              (ownedAssessment &&
                !['monitor', 'controls', 'end'].some((action) => path.endsWith('/' + action))))
          )
            await authoring.ensure(
              admin.principal_id,
              url.searchParams.get('refresh') === '1',
              authoringId,
            );
          requireSession(request, 'admin');
          if (
            authoringId &&
            !['GET', 'HEAD'].includes(method) &&
            !path.endsWith('/resolve') &&
            !path.endsWith('/launch') &&
            !path.endsWith('/end') &&
            !path.endsWith('/controls')
          )
            authoring.assertWritable(admin.principal_id, authoringId);
          if (!['GET', 'HEAD'].includes(method))
            response.once('finish', () => {
              if (response.statusCode < 400) authoring.changed(admin.principal_id);
            });
        }
        if (path === '/api/authoring/status' && method === 'GET')
          return send(
            response,
            200,
            authoring.overview(requireSession(request, 'admin').principal_id),
          );
        if (path === '/api/authoring/retry' && method === 'POST') {
          const admin = requireSession(request, 'admin');
          await authoring.ensure(admin.principal_id, true);
          requireSession(request, 'admin');
          return send(response, 200, authoring.overview(admin.principal_id));
        }
        if (path === '/api/authoring/drafts' && method === 'GET')
          return send(response, 200, {
            drafts: authoring.listDrafts(requireSession(request, 'admin').principal_id),
          });
        const authoringMatch = path.match(
          /^\/api\/authoring\/([a-f0-9-]{36})(?:\/(resolve|recovery))?$/,
        );
        if (authoringMatch) {
          const admin = requireSession(request, 'admin'),
            [, id, action] = authoringMatch;
          if (action === 'resolve' && method === 'POST') {
            await authoring.resolve(admin.principal_id, id, () => {
              if (requireSession(request, 'admin').principal_id !== admin.principal_id)
                throw new DomainError('Please sign in again.', 401);
              if (request.headers['x-csrf-token'] !== requireSession(request, 'admin').csrf)
                throw new DomainError('Refresh the page before continuing.', 403);
            });
            return send(response, 200, authoring.overview(admin.principal_id));
          }
          if (action === 'recovery' && method === 'GET') {
            const payload = authoring.recovery(admin.principal_id, id);
            response.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Disposition': `attachment; filename="assessment-recovery-${id}.json"`,
            });
            return response.end(payload);
          }
          if (!action && method === 'GET')
            return send(response, 200, authoring.getDraft(admin.principal_id, id));
          if (!action && method === 'PUT') {
            const input = await body(request);
            requireSession(request, 'admin');
            return send(
              response,
              200,
              authoring.saveDraft(admin.principal_id, id, input.draft, input.expectedRevision),
            );
          }
          if (!action && method === 'DELETE') {
            const input = await body(request);
            requireSession(request, 'admin');
            authoring.discard(admin.principal_id, id, input.expectedRevision);
            return send(response, 200, { discarded: true });
          }
        }
        if (path === '/api/rosters' || path.startsWith('/api/rosters/')) {
          const admin = requireSession(request, 'admin');
          const rosterId = path.match(/^\/api\/rosters\/([a-f0-9-]{36})/)?.[1];
          await cloudRosters?.ensure(
            admin.principal_id,
            url.searchParams.get('refresh') === '1',
            rosterId,
          );
          requireSession(request, 'admin');
          if (!['GET', 'HEAD'].includes(method) && rosterId && !path.endsWith('/cloud/resolve'))
            cloudRosters?.assertWritable(admin.principal_id, rosterId);
          if (!['GET', 'HEAD'].includes(method))
            response.once('finish', () => {
              cloudRosters?.changed(admin.principal_id);
            });
        }
        if (ownedAssessment)
          store.assertOwner(ownedAssessment[1], requireSession(request, 'admin').principal_id);
        if (
          ['/api/local-delivery', '/api/local-delivery/stop', '/api/candidate-address'].includes(
            path,
          )
        ) {
          const operator = requireSession(request, 'admin');
          if (
            !isLoopback(request.socket.remoteAddress) ||
            !db
              .prepare('SELECT 1 FROM administrators WHERE id=? AND singleton=1')
              .get(operator.principal_id)
          )
            throw new DomainError(
              'Local delivery belongs to the administrator of this Host computer.',
              403,
            );
        }
        if (
          [
            '/api/admin/cloud/login',
            '/api/admin/cloud/signup',
            '/api/admin/cloud/connect',
            '/api/admin/cloud/connect/signup',
          ].includes(path) &&
          method === 'POST'
        ) {
          if (!options.secure && !isLoopback(request.socket.remoteAddress))
            throw new DomainError('Use the HTTPS workspace address to sign in.', 403);
          if (!cloud || options.candidateListener || options.identityMode === 'replica')
            throw new DomainError(
              'Cloud accounts are not available on this local examination address.',
              409,
            );
          limiter.take(`cloud-auth:${ip}`, 10, 15 * 60000);
          const input = await body(request),
            email = emailAddress(input.email);
          limiter.take(`cloud-email:${digest(email)}`, 10, 15 * 60000);
          const password = accountPassword(input.password, path.endsWith('/signup'));
          let existing: string | undefined;
          if (path === '/api/admin/cloud/connect' || path === '/api/admin/cloud/connect/signup') {
            const native = requireSession(request, 'admin');
            if (!isLoopback(request.socket.remoteAddress))
              throw new DomainError('Connect your workspace from the Host computer.', 403);
            const row = db
              .prepare('SELECT password_hash FROM administrators WHERE id=? AND singleton=1')
              .get(native.principal_id);
            if (
              !row ||
              !(await verifyPassword(
                accountPassword(input.hostPassword),
                String(row.password_hash),
              ))
            )
              throw new DomainError('Check your local Host password.', 401);
            requireSession(request, 'admin');
            existing = native.principal_id;
            if (
              path.endsWith('/signup') &&
              db
                .prepare('SELECT 1 FROM admin_provider_identities WHERE administrator_id=?')
                .get(existing)
            )
              throw new DomainError('This workspace is already connected to a cloud account.', 409);
          }
          if (path.endsWith('/signup')) {
            const created = await options.cloudAuth!.provider.signUp(
              email,
              password,
              text(input.name, 'Your name', 100),
            );
            if (!created.session)
              return send(response, 202, {
                pending: true,
                message: 'Check your email to confirm your account, then sign in.',
              });
            if (existing) requireSession(request, 'admin');
            const session = cloud.open(created.session, existing, isLoopback(ip));
            setSession(response, session.raw);
            return send(response, 201, { csrf: session.csrf });
          }
          const identity = await options.cloudAuth!.provider.signIn(email, password);
          if (existing) requireSession(request, 'admin');
          const session = cloud.open(identity, existing, isLoopback(ip));
          setSession(response, session.raw);
          return send(response, 200, { csrf: session.csrf });
        }

        if (path === '/api/admin/device-access' && method === 'POST') {
          if (
            !isLoopback(ip) ||
            options.candidateListener ||
            options.identityMode === 'replica' ||
            !cloud
          )
            throw new DomainError('Manage offline access on the Host computer.', 403);
          const admin = requireSession(request, 'admin');
          const binding = db
            .prepare(
              'SELECT provider_user_id,email FROM admin_provider_identities WHERE administrator_id=?',
            )
            .get(admin.principal_id);
          if (
            !binding ||
            !cloudSignedIn(request) ||
            !db
              .prepare('SELECT 1 FROM provider_sessions WHERE token_hash=?')
              .get(digest(rawSession(request)))
          )
            throw new DomainError(
              'Sign in to your MUDU account online to manage offline access.',
              401,
            );
          limiter.take(`device-access:${ip}`, 10, 15 * 60000);
          const input = await body(request);
          if (input.action !== 'enable' && input.action !== 'disable')
            throw new DomainError('Choose whether to enable or disable offline access.', 400);
          const verified = await options.cloudAuth!.provider.signIn(
            String(binding.email),
            accountPassword(input.accountPassword),
          );
          if (verified.userId !== binding.provider_user_id)
            throw new DomainError('The account could not be verified.', 401);
          const hash =
            input.action === 'disable'
              ? null
              : await hashPassword(text(input.devicePassword, 'Device password', 128, 12));
          transaction(db, () => {
            if (requireSession(request, 'admin').principal_id !== admin.principal_id)
              throw new DomainError('Please sign in again.', 401);
            db.prepare(
              'DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM admin_device_sessions WHERE administrator_id=?)',
            ).run(admin.principal_id);
            if (hash)
              db.prepare(
                'INSERT INTO admin_device_access VALUES(?,?,?) ON CONFLICT(administrator_id) DO UPDATE SET password_hash=excluded.password_hash,enabled_at=excluded.enabled_at',
              ).run(admin.principal_id, hash, store.now());
            else
              db.prepare('DELETE FROM admin_device_access WHERE administrator_id=?').run(
                admin.principal_id,
              );
            if (hash)
              db.prepare(
                "INSERT INTO account_preferences(principal_id,role,text_size,reduced_motion,notification_badge,offline_setup_completed) VALUES(?,'admin','normal','system',1,1) ON CONFLICT(role,principal_id) DO UPDATE SET offline_setup_completed=1",
              ).run(admin.principal_id);
            store.event(
              null,
              admin.principal_id,
              hash ? 'device_access_enabled' : 'device_access_disabled',
            );
          });
          return send(response, 200, { enabled: Boolean(hash) });
        }
        if (path === '/api/admin/device/login' && method === 'POST') {
          if (!isLoopback(ip) || options.candidateListener || options.identityMode === 'replica')
            throw new DomainError('Offline access is available only on this Host computer.', 403);
          limiter.take(`device-login:${ip}`, 10, 15 * 60000);
          const input = await body(request),
            email = emailAddress(input.email);
          limiter.take(`device-email:${digest(email)}`, 10, 15 * 60000);
          const row = db
            .prepare(
              'SELECT d.administrator_id,d.password_hash FROM admin_device_access d JOIN admin_provider_identities p ON p.administrator_id=d.administrator_id WHERE p.email=? COLLATE NOCASE',
            )
            .get(email);
          const valid = await verifyPassword(
            text(input.password, 'Device password', 128),
            String(row?.password_hash ?? dummyHash),
          );
          if (!row || !valid)
            throw new DomainError(
              'Check your email and device password. Offline access must be enabled on this computer first.',
              401,
            );
          const session = transaction(db, () => {
            const current = db
              .prepare('SELECT password_hash FROM admin_device_access WHERE administrator_id=?')
              .get(row.administrator_id);
            if (current?.password_hash !== row.password_hash)
              throw new DomainError('Offline access changed. Try signing in again.', 401);
            const value = store.createSession('admin', String(row.administrator_id), null);
            db.prepare('INSERT INTO admin_device_sessions VALUES(?,?)').run(
              digest(value.raw),
              row.administrator_id,
            );
            store.event(null, String(row.administrator_id), 'device_signed_in');
            return value;
          });
          setSession(response, session.raw);
          return send(response, 200, { csrf: session.csrf });
        }

        if (path.startsWith('/api/cloud-sync/')) {
          const admin = requireSession(request, 'admin');
          if (options.candidateListener)
            throw new DomainError('Open the administrator workspace to synchronize records.', 403);
          const signedIn = cloudSignedIn(request);
          if (path === '/api/cloud-sync/status' && method === 'GET') {
            if (!cloudSync)
              return send(response, 200, {
                available: false,
                connected: false,
                signedIn: false,
                items: [],
                ready: [],
              });
            void cloudSync.pump();
            return send(response, 200, cloudSync.status(admin.principal_id, signedIn));
          }
          if (!cloudSync)
            throw new DomainError(
              'Cloud synchronization is not configured on this service.',
              503,
              'CLOUD_SETUP_REQUIRED',
            );
          if (path === '/api/cloud-sync/queue' && method === 'POST') {
            const input = await body(request);
            requireSession(request, 'admin');
            const ids = cloudSync.enqueue(admin.principal_id, input.assessmentIds);
            void cloudSync.pump();
            return send(response, 202, { ids });
          }
          const retryId = path.match(/^\/api\/cloud-sync\/jobs\/([a-f0-9-]{36})\/retry$/)?.[1];
          if (retryId && method === 'POST') {
            cloudSync.retry(admin.principal_id, retryId);
            void cloudSync.pump();
            return send(response, 200, { queued: true });
          }
          if (path === '/api/cloud-sync/records' && method === 'GET') {
            const offset = Number(url.searchParams.get('offset') ?? 0);
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
              throw new DomainError('Invalid page.');
            return send(response, 200, {
              records: await cloudSync.list(admin.principal_id, offset),
            });
          }
          const cloudRecord = path.match(
            /^\/api\/cloud-sync\/records\/([a-f0-9-]{36})(\/results.csv)?$/,
          );
          if (cloudRecord && method === 'GET') {
            const record = await cloudSync.read(admin.principal_id, cloudRecord[1]);
            if (!cloudRecord[2]) return send(response, 200, record);
            const rows: unknown[][] = [
              ['Candidate ID', 'Name', 'Score', 'Percentage', 'Status', 'Submission time'],
            ];
            for (const c of record.candidates)
              rows.push([
                c.identifier,
                c.name,
                c.grade?.totalScore ?? '',
                c.grade?.percentage ?? '',
                c.grade?.pendingManual ? 'Needs manual review' : c.status,
                c.submittedAt ? new Date(c.submittedAt).toISOString() : '',
              ]);
            response.writeHead(200, {
              'Content-Type': 'text/csv; charset=utf-8',
              'Content-Disposition': resultsDisposition(record.assessment.title),
            });
            return response.end(
              '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n'),
            );
          }
          throw new DomainError('Page not found.', 404);
        }
        if (path === '/api/health' && method === 'GET') {
          db.prepare('SELECT 1').get();
          return send(response, 200, { status: 'ok', mode: 'local', serverNow: store.now() });
        }
        if (path === '/api/local-delivery' && method === 'GET') {
          requireSession(request, 'admin');
          if (!options.localDelivery)
            throw new DomainError('Local delivery management is not available on this Host.', 503);
          return send(response, 200, options.localDelivery.status());
        }
        if (path === '/api/local-delivery' && method === 'POST') {
          const session = requireSession(request, 'admin');
          if (!options.localDelivery)
            throw new DomainError('Local delivery management is not available on this Host.', 503);
          if (
            db
              .prepare(
                "SELECT 1 FROM sittings WHERE deadline > ? UNION ALL SELECT 1 FROM attempts WHERE status='active' AND deadline > ? LIMIT 1",
              )
              .get(store.now(), store.now())
          )
            throw new DomainError(
              'Finish active examinations before changing local delivery.',
              409,
            );
          limiter.take(`local-setup:${ip}`, 10, 60000);
          await options.localDelivery.configure(await body(request));
          store.event(null, session.principal_id, 'local_delivery_configured');
          return send(response, 200, options.localDelivery.status());
        }
        if (path === '/api/local-delivery/stop' && method === 'POST') {
          requireSession(request, 'admin');
          if (options.candidateListener)
            throw new DomainError('Open administration on the Host workspace address.', 403);
          if (!options.localDelivery)
            throw new DomainError('Local delivery management is not available.', 503);
          if (
            db
              .prepare(
                "SELECT 1 FROM sittings WHERE deadline > ? UNION ALL SELECT 1 FROM attempts WHERE status='active' AND deadline > ? LIMIT 1",
              )
              .get(store.now(), store.now())
          )
            throw new DomainError(
              'Finish active examinations before stopping local delivery.',
              409,
            );
          await options.localDelivery.stop();
          return send(response, 200, options.localDelivery.status());
        }
        if (path === '/api/candidate-address' && method === 'GET') {
          requireSession(request, 'admin');
          const managed = options.localDelivery?.status();
          const external =
            options.secure &&
            !['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(
              new URL(options.origin).hostname,
            );
          return send(response, 200, {
            origin:
              url.searchParams.get('purpose') === 'roster' && cloudRosters && external
                ? options.origin
                : (managed?.origin ?? (external ? options.origin : null)),
          });
        }
        if (path === '/api/local-connection' && method === 'POST') {
          if (!options.candidateListener || !options.localDelivery)
            throw new DomainError('Open the candidate address shown on the Host.', 409);
          if (isLoopback(ip))
            throw new DomainError(
              'Run this check on another device connected to the examination Wi-Fi.',
              409,
            );
          limiter.take(`connection-check:${ip}`, 20, 60000);
          options.localDelivery.connection(ip);
          return send(response, 200, { connected: true });
        }
        if (path === '/api/auth' && method === 'GET') {
          const storedSession = store.session(rawSession(request));
          const session =
            storedSession?.account_id &&
            !preparation.scope(rawSession(request)) &&
            (options.identityMode === 'replica' ||
              ((!cloud || options.candidateListener) &&
                Boolean(
                  db
                    .prepare('SELECT 1 FROM provider_sessions WHERE token_hash=?')
                    .get(digest(rawSession(request))),
                )))
              ? undefined
              : storedSession;
          const admin = db
            .prepare('SELECT name FROM administrators WHERE id=?')
            .get(session?.principal_id ?? '');
          // Keep an active, explicitly trusted local workspace open. Expired or
          // revoked sessions cannot be revived, and remote/candidate lifetimes stay unchanged.
          if (
            session?.role === 'admin' &&
            localDevice(request) &&
            connection.hasGrant(rawSession(request)) &&
            session.expires_at - store.now() < 6 * 60 * 60 * 1000
          ) {
            db.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=? AND expires_at>?').run(
              store.now() + 12 * 60 * 60 * 1000,
              digest(rawSession(request)),
              store.now(),
            );
            setSession(response, rawSession(request));
          }
          const local = db
            .prepare('SELECT id,password_hash FROM administrators WHERE singleton=1')
            .get();
          return send(response, 200, {
            onlineAvailable: Boolean(options.online && !options.candidateListener),
            connection:
              session?.role === 'admin' ? connection.status(rawSession(request)) : undefined,
            preferences: preferences(store, session),
            deviceAccessAvailable:
              isLoopback(ip) && !options.candidateListener && options.identityMode !== 'replica',
            deviceAccessEnabled: Boolean(
              session?.role === 'admin' &&
              db
                .prepare('SELECT 1 FROM admin_device_access WHERE administrator_id=?')
                .get(session.principal_id),
            ),
            deviceAccessConfigured: Boolean(
              session?.role === 'admin' &&
              db
                .prepare(
                  "SELECT 1 FROM account_preferences WHERE principal_id=? AND role='admin' AND offline_setup_completed=1",
                )
                .get(session.principal_id),
            ),
            deviceSignedIn: Boolean(
              session?.role === 'admin' &&
              db
                .prepare('SELECT 1 FROM admin_device_sessions WHERE token_hash=?')
                .get(digest(rawSession(request))),
            ),
            configured: Boolean(db.prepare('SELECT 1 FROM administrators LIMIT 1').get()),
            offlineAdmissionAvailable: preparation.available(),
            offlineAdmission: Boolean(session && preparation.scope(rawSession(request))),
            candidateCloudAvailable:
              Boolean(cloudCandidates) &&
              !options.candidateListener &&
              options.identityMode !== 'replica',
            candidateCloudConnected: Boolean(
              session?.account_id &&
              db
                .prepare('SELECT 1 FROM candidate_provider_identities WHERE account_id=?')
                .get(session.account_id),
            ),
            candidateCloudSignedIn: Boolean(
              session?.account_id &&
              db
                .prepare('SELECT 1 FROM provider_sessions WHERE token_hash=?')
                .get(digest(rawSession(request))),
            ),
            localConfigured: Boolean(String(local?.password_hash ?? '').startsWith('scrypt:')),
            cloudSignedIn: session?.role === 'admin' && cloudSignedIn(request),
            cloudAvailable:
              Boolean(cloud) && !options.candidateListener && options.identityMode !== 'replica',
            cloudConnected: Boolean(
              session?.role === 'admin' &&
              db
                .prepare('SELECT 1 FROM admin_provider_identities WHERE administrator_id=?')
                .get(session.principal_id),
            ),
            adminId: session?.role === 'admin' ? session.principal_id : null,
            hostOperator: Boolean(session?.role === 'admin' && local?.id === session.principal_id),
            role: session?.role ?? null,
            csrf: session?.csrf ?? null,
            name: session?.account_id
              ? identity.profile(session.account_id).name
              : session?.role === 'admin'
                ? admin?.name
                : null,
            accountId: session?.account_id ?? null,
            identityMode: options.identityMode ?? 'primary',
          });
        }
        if (path === '/api/notifications') {
          const session = requireSession(request);
          if (method === 'POST') {
            readNotifications(db, session, (await body(request)).ids, store.now());
            return send(response, 200, { saved: true });
          }
          if (method === 'GET') {
            store.reconcile();
            return send(response, 200, notificationFeed(db, session));
          }
        }
        if (path === '/api/admin/setup' && method === 'POST') {
          if (!isLoopback(request.socket.remoteAddress))
            throw new DomainError('Set up MUDU on the Host computer.', 403);
          limiter.take(`setup:${ip}`, 5, 15 * 60000);
          if (db.prepare('SELECT id FROM administrators WHERE singleton=1').get())
            throw new DomainError('This Host has already been set up.', 409);
          const input = await body(request);
          const name = text(input.name, 'Your name', 100);
          const password = text(input.password, 'Password', 128, 12);
          const hash = await hashPassword(password);
          const session = transaction(db, () => {
            if (db.prepare('SELECT id FROM administrators WHERE singleton=1').get())
              throw new DomainError('This Host has already been set up.', 409);
            const id = randomUUID();
            db.prepare('INSERT INTO administrators VALUES(?,?,?,1)').run(id, name, hash);
            store.event(null, id, 'host_initialized');
            return store.createSession('admin', id, null);
          });
          setSession(response, session.raw);
          return send(response, 201, { csrf: session.csrf });
        }
        if (path === '/api/admin/login' && method === 'POST') {
          if (!isLoopback(request.socket.remoteAddress))
            throw new DomainError('Open administration on the Host computer.', 403);
          limiter.take(`admin-login:${ip}`, 10, 15 * 60000);
          const input = await body(request);
          const password = text(input.password, 'Password', 128);
          const admin = db
            .prepare('SELECT id,password_hash FROM administrators WHERE singleton=1')
            .get();
          const valid = await verifyPassword(password, String(admin?.password_hash ?? dummyHash));
          if (!admin || !valid) throw new DomainError('The password is incorrect.', 401);
          const session = transaction(db, () => {
            const value = store.createSession('admin', String(admin.id), null);
            store.event(null, String(admin.id), 'admin_signed_in');
            return value;
          });
          setSession(response, session.raw);
          return send(response, 200, { csrf: session.csrf });
        }
        if (path === '/api/logout' && method === 'POST') {
          requireSession(request);
          db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(rawSession(request)));
          response.setHeader(
            'Set-Cookie',
            `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${options.secure ? '; Secure' : ''}`,
          );
          return send(response, 200, { ok: true });
        }
        if (
          ['/api/candidate/account/signup', '/api/candidate/account/login'].includes(path) &&
          method === 'POST'
        ) {
          if (options.identityMode === 'replica')
            throw new DomainError(
              'Use your existing MUDU account and prepared admission pass. This offline Host does not create accounts or accept your main password.',
              409,
            );
          if (!db.prepare('SELECT id FROM administrators').get())
            throw new DomainError('This workspace has not been set up yet.', 409);
          limiter.take(`account-auth:${ip}`, 20, 15 * 60000);
          const input = await body(request);
          let session;
          if (path.endsWith('/signup')) {
            limiter.take(`signup:${ip}`, 8, 15 * 60000);
            const email = emailAddress(input.email);
            const name = text(input.name, 'Full name', 160);
            const hash = await hashPassword(accountPassword(input.password, true));
            session = identity.createAccount({ email, name, hash });
          } else {
            const login = emailAddress(input.login);
            limiter.take(`account:${digest(login.toLowerCase())}`, 10, 15 * 60000);
            const row = identity.findLogin(login);
            const valid = await verifyPassword(
              accountPassword(input.password),
              typeof row?.password_hash === 'string' && row.password_hash.startsWith('scrypt:')
                ? row.password_hash
                : dummyHash,
            );
            if (!row || !valid)
              throw new DomainError(
                'Check your email and password. Use the same account you registered with on this Host.',
                401,
              );
            session = transaction(db, () => {
              const result = store.createSession('candidate', String(row.id), null, String(row.id));
              store.event(null, String(row.id), 'account_signed_in', {
                previousDeviceRevoked: true,
              });
              return result;
            });
          }
          setSession(response, session.raw);
          return send(response, path.endsWith('/signup') ? 201 : 200, { csrf: session.csrf });
        }
        if (path === '/api/question-bank' || path.startsWith('/api/question-bank/')) {
          const admin = requireSession(request, 'admin');
          if (options.candidateListener)
            throw new DomainError('Open the administrator workspace to manage questions.', 403);
          if (path === '/api/question-bank/cloud/status' && method === 'GET') {
            await cloudBank?.ensure(admin.principal_id);
            requireSession(request, 'admin');
            return send(
              response,
              200,
              cloudBank?.status(admin.principal_id) ?? {
                state: 'local',
                revision: 0,
                lastSyncedAt: null,
                message: null,
              },
            );
          }
          if (path === '/api/question-bank/cloud/resolve' && method === 'POST') {
            if (!cloudBank) throw new DomainError('Cloud question bank is not configured.', 409);
            const input = await body(request);
            if (!['both', 'cloud'].includes(String(input.choice)))
              throw new DomainError('Choose which copies to keep.');
            return send(
              response,
              200,
              await cloudBank.resolve(admin.principal_id, input.choice === 'both', () => {
                requireSession(request, 'admin');
              }),
            );
          }
          if (path === '/api/question-bank/cloud/recovery' && method === 'GET') {
            if (!cloudBank) throw new DomainError('Recovery copy not found.', 404);
            const snapshot = cloudBank.recovery(admin.principal_id);
            response.setHeader(
              'Content-Disposition',
              'attachment; filename="question-bank-recovery.json"',
            );
            return send(response, 200, snapshot);
          }
          await cloudBank?.ensure(admin.principal_id);
          requireSession(request, 'admin');
          if (method !== 'GET') {
            cloudBank?.assertWritable(admin.principal_id);
            // The snapshot itself is the durable outbox. Failed saves do not create cloud changes.
            cloudBank?.changed(admin.principal_id);
          }
          if (path === '/api/question-bank/projects' && method === 'GET')
            return send(response, 200, bank.projects(admin.principal_id, url.searchParams));
          if (path === '/api/question-bank/projects' && method === 'POST')
            return send(response, 200, bank.saveProject(admin.principal_id, await body(request)));
          const projectId = path.match(/^\/api\/question-bank\/projects\/([a-f0-9-]{36})$/)?.[1];
          if (projectId && method === 'GET')
            return send(response, 200, bank.project(admin.principal_id, projectId));
          if (path === '/api/question-bank/documents/extract' && method === 'POST') {
            const result = await uploadDocument(request, url.searchParams.get('name') ?? '');
            requireSession(request, 'admin');
            return send(response, 200, result);
          }
          if (path === '/api/question-bank' && method === 'GET')
            return send(response, 200, bank.list(admin.principal_id, url.searchParams));
          if (path === '/api/question-bank' && method === 'POST')
            return send(response, 200, bank.save(admin.principal_id, await body(request)));
          if (path === '/api/question-bank/select' && method === 'POST')
            return send(response, 200, {
              questions: bank.select(admin.principal_id, (await body(request)).selection),
            });
          if (path === '/api/question-bank/move' && method === 'POST')
            return send(response, 200, bank.move(admin.principal_id, await body(request)));
          if (path === '/api/question-bank/review' && method === 'POST')
            return send(
              response,
              200,
              bank.reviewSelection(admin.principal_id, await body(request)),
            );
          if (path === '/api/question-bank/ai/status' && method === 'GET')
            return send(response, 200, generation.availability());
          if (path === '/api/question-bank/generate' && method === 'POST')
            return send(
              response,
              200,
              await generation.generate(admin.principal_id, await body(request), () => {
                requireSession(request, 'admin');
                cloudBank?.assertWritable(admin.principal_id);
                cloudBank?.changed(admin.principal_id);
              }),
            );
          const jobId = path.match(/^\/api\/question-bank\/generations\/([a-f0-9-]{36})$/)?.[1];
          if (jobId && method === 'GET')
            return send(response, 200, generation.job(jobId, admin.principal_id));
          const questionId = path.match(/^\/api\/question-bank\/([a-f0-9-]{36})$/)?.[1];
          if (questionId && method === 'GET')
            return send(response, 200, bank.get(questionId, admin.principal_id));
          throw new DomainError('Question-bank route not found.', 404);
        }
        if (path === '/api/rosters' && method === 'GET') {
          const admin = requireSession(request, 'admin');
          return send(response, 200, { rosters: new Rosters(store).list(admin.principal_id) });
        }
        if (path === '/api/rosters/cloud/status' && method === 'GET') {
          const admin = requireSession(request, 'admin');
          return send(
            response,
            200,
            cloudRosters?.overview(admin.principal_id) ?? { enabled: false, rosters: [] },
          );
        }
        if (path === '/api/rosters/cloud/retry' && method === 'POST') {
          const admin = requireSession(request, 'admin');
          await cloudRosters?.ensure(admin.principal_id, true);
          requireSession(request, 'admin');
          return send(
            response,
            200,
            cloudRosters?.overview(admin.principal_id) ?? { enabled: false, rosters: [] },
          );
        }
        const rosterResolution = path.match(/^\/api\/rosters\/([a-f0-9-]{36})\/cloud\/resolve$/);
        const rosterRecovery = path.match(/^\/api\/rosters\/([a-f0-9-]{36})\/cloud\/recovery$/);
        if (rosterRecovery && method === 'GET') {
          const admin = requireSession(request, 'admin');
          if (!cloudRosters) throw new DomainError('Cloud rosters are not configured.', 409);
          const payload = cloudRosters.recovery(admin.principal_id, rosterRecovery[1]);
          response.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': `attachment; filename="roster-${rosterRecovery[1]}-recovery.json"`,
          });
          return response.end(payload);
        }
        if (rosterResolution && method === 'POST') {
          const admin = requireSession(request, 'admin');
          if (!cloudRosters) throw new DomainError('Cloud rosters are not configured.', 409);
          await cloudRosters.resolve(admin.principal_id, rosterResolution[1], () => {
            requireSession(request, 'admin');
          });
          return send(
            response,
            200,
            new Rosters(store).get(rosterResolution[1], admin.principal_id),
          );
        }
        if (path === '/api/candidate/rosters' && method === 'GET') {
          const session = requireSession(request, 'candidate');
          if (!session.account_id) throw new DomainError('Sign in with your MUDU account.', 401);
          const localGroups = db
            .prepare(
              'SELECT r.name,r.token,m.status FROM roster_members m JOIN rosters r ON r.id=m.roster_id WHERE m.account_id=? ORDER BY r.name',
            )
            .all(session.account_id);
          const connected = Boolean(
            db
              .prepare('SELECT 1 FROM provider_sessions WHERE token_hash=?')
              .get(digest(rawSession(request))),
          );
          const groups =
            cloudRosters && connected
              ? await cloudRosters.candidateGroups(session.account_id, () => {
                  requireSession(request, 'candidate');
                })
              : [];
          const merged = new Map(localGroups.map((r) => [String(r.token), r]));
          for (const g of groups)
            merged.set(g.token, { name: g.name, token: g.token, status: g.member.status });
          return send(response, 200, { rosters: [...merged.values()] });
        }
        const enrolment = path.match(/^\/api\/rosters\/([a-f0-9-]{36})\/enrol$/);
        const cancelInvite = path.match(
          /^\/api\/rosters\/([a-f0-9-]{36})\/invitations\/([a-f0-9-]{36})$/,
        );
        if (cancelInvite && method === 'DELETE') {
          requirePrimaryIdentity();
          const admin = requireSession(request, 'admin');
          return send(
            response,
            200,
            new Rosters(store).cancelInvitation(
              cancelInvite[1],
              admin.principal_id,
              cancelInvite[2],
              (await body(request)).revision,
            ),
          );
        }
        if (enrolment && method === 'POST') {
          requirePrimaryIdentity();
          const admin = requireSession(request, 'admin');
          return send(
            response,
            200,
            new Rosters(store).enrol(enrolment[1], admin.principal_id, await body(request)),
          );
        }
        const personalInvite = path.match(/^\/api\/enrolment-join\/([A-Za-z0-9_-]{20,100})$/);
        if (personalInvite) {
          requirePrimaryIdentity();
          const rosters = new Rosters(store);
          const session = store.session(rawSession(request));
          const cloudCandidate = Boolean(
            session?.account_id &&
            db
              .prepare('SELECT 1 FROM provider_sessions WHERE token_hash=?')
              .get(digest(rawSession(request))),
          );
          const exists = Boolean(
            db
              .prepare('SELECT 1 FROM roster_enrolment_invites WHERE token=?')
              .get(personalInvite[1]),
          );
          if (cloudRosters && !cloudRosters.activeExam() && (cloudCandidate || !exists)) {
            if (method === 'GET')
              return send(
                response,
                200,
                await cloudRosters.invitation(
                  personalInvite[1],
                  cloudCandidate ? session!.account_id : null,
                  true,
                ),
              );
            if (method === 'POST') {
              const authenticated = requireSession(request, 'candidate');
              if (!cloudCandidate || !authenticated.account_id)
                throw new DomainError(
                  'Use connected sign-in to accept this cloud invitation.',
                  409,
                );
              return send(
                response,
                200,
                await cloudRosters.join(personalInvite[1], authenticated.account_id, true, () => {
                  requireSession(request, 'candidate');
                }),
              );
            }
          }
          if (method === 'GET')
            return send(response, 200, rosters.enrolmentInvitation(personalInvite[1]));
          if (method === 'POST') {
            const session = requireSession(request, 'candidate');
            if (!session.account_id)
              throw new DomainError('Sign in to accept your invitation.', 401);
            return send(
              response,
              200,
              rosters.claimEnrolment(personalInvite[1], session.account_id),
            );
          }
        }
        const rosterMatch = path.match(
          /^\/api\/rosters\/([a-f0-9-]{36})(?:\/members\/([a-f0-9-]{36}))?$/,
        );
        if (rosterMatch) {
          const admin = requireSession(request, 'admin');
          const rosters = new Rosters(store);
          if (method === 'GET')
            return send(response, 200, rosters.get(rosterMatch[1], admin.principal_id));
          if (method === 'POST') {
            requirePrimaryIdentity();
            const input = await body(request);
            return send(
              response,
              200,
              rosterMatch[2]
                ? rosters.review(rosterMatch[1], admin.principal_id, rosterMatch[2], input)
                : rosters.save(rosterMatch[1], admin.principal_id, input),
            );
          }
        }
        const rosterJoin = path.match(/^\/api\/roster-join\/([A-Za-z0-9_-]{20,100})$/);
        if (rosterJoin) {
          requirePrimaryIdentity();
          const rosters = new Rosters(store);
          const session = store.session(rawSession(request));
          const cloudCandidate = Boolean(
            session?.account_id &&
            db
              .prepare('SELECT 1 FROM provider_sessions WHERE token_hash=?')
              .get(digest(rawSession(request))),
          );
          const existing = db
            .prepare('SELECT owner_id,id FROM rosters WHERE token=?')
            .get(rosterJoin[1]);
          if (cloudRosters && !cloudRosters.activeExam() && (cloudCandidate || !existing)) {
            if (existing && cloudCandidate)
              await cloudRosters.ensure(String(existing.owner_id), true, String(existing.id));
            if (method === 'GET')
              return send(
                response,
                200,
                await cloudRosters.invitation(
                  rosterJoin[1],
                  cloudCandidate ? session!.account_id : null,
                  false,
                ),
              );
            if (method === 'POST') {
              const authenticated = requireSession(request, 'candidate');
              if (!cloudCandidate || !authenticated.account_id)
                throw new DomainError('Use connected sign-in to join this cloud roster.', 409);
              limiter.take(`cloud-roster-join:${authenticated.account_id}`, 30, 60000);
              const input = await body(request);
              return send(
                response,
                200,
                await cloudRosters.join(
                  rosterJoin[1],
                  authenticated.account_id,
                  false,
                  () => {
                    requireSession(request, 'candidate');
                  },
                  input.identifier,
                ),
              );
            }
          }
          if (method === 'GET')
            return send(
              response,
              200,
              rosters.invitation(rosterJoin[1], store.session(rawSession(request))?.account_id),
            );
          if (method === 'POST') {
            const session = requireSession(request, 'candidate');
            if (!session.account_id) throw new DomainError('Sign in with your MUDU account.', 401);
            limiter.take(`roster-join:${session.account_id}`, 30, 60000);
            return send(
              response,
              200,
              rosters.join(rosterJoin[1], session.account_id, (await body(request)).identifier),
            );
          }
        }
        const assessmentRoster = path.match(/^\/api\/assessments\/([a-f0-9-]+)\/roster$/);
        if (assessmentRoster) {
          const admin = requireSession(request, 'admin');
          if (method === 'POST') requirePrimaryIdentity();
          if (method === 'GET' || method === 'POST')
            return send(
              response,
              200,
              new Rosters(store).additions(
                assessmentRoster[1],
                admin.principal_id,
                method === 'POST',
                method === 'POST' ? (await body(request)).revision : undefined,
              ),
            );
        }
        if (path === '/api/candidate/me' && method === 'GET') {
          const session = requireSession(request, 'candidate');
          if (!session.account_id) throw new DomainError('Sign in with your MUDU account.', 401);
          return send(response, 200, identity.profile(session.account_id));
        }
        if (path === '/api/candidate/examinations' && method === 'GET') {
          const session = requireSession(request, 'candidate');
          if (!session.account_id) throw new DomainError('Sign in with your MUDU account.', 401);
          const scope = preparation.scope(rawSession(request));
          return send(response, 200, {
            examinations: identity
              .examinations(session.account_id)
              .filter((exam) => !scope || exam.assessmentId === scope),
          });
        }
        const invitationMatch = path.match(/^\/api\/registration\/([A-Za-z0-9_-]{20,100})$/);
        if (invitationMatch && method === 'GET') {
          const session = store.session(rawSession(request));
          return send(response, 200, identity.invitation(invitationMatch[1], session?.account_id));
        }
        if (invitationMatch && method === 'POST') {
          requirePrimaryIdentity();
          const session = requireSession(request, 'candidate');
          if (!session.account_id)
            throw new DomainError('Sign in with your MUDU account to register.', 401);
          limiter.take(`join:${session.account_id}`, 30, 60000);
          return send(response, 200, identity.register(invitationMatch[1], session.account_id));
        }
        if (path === '/api/candidate-directory' && method === 'GET') {
          const admin = requireSession(request, 'admin');
          return send(response, 200, { candidates: identity.directory(false, admin.principal_id) });
        }
        if (path === '/api/enrolment-directory' && method === 'GET') {
          const admin = requireSession(request, 'admin');
          return send(response, 200, { candidates: identity.directory(true, admin.principal_id) });
        }
        const registrationMatch = path.match(
          /^\/api\/assessments\/([a-f0-9-]+)\/registration(?:\/([a-f0-9-]+))?$/,
        );
        if (registrationMatch) {
          requireSession(request, 'admin');
          const [, assessmentId, registrationId] = registrationMatch;
          if (method === 'GET' && !registrationId)
            return send(response, 200, {
              settings: identity.settings(assessmentId),
              requests: identity.requests(assessmentId),
            });
          if (method === 'POST') {
            requirePrimaryIdentity();
            if (
              db.prepare('SELECT 1 FROM assessment_rosters WHERE assessment_id=?').get(assessmentId)
            )
              throw new DomainError(
                'Manage membership through the attached roster, not assessment registration.',
                409,
              );
            const input = await body(request);
            const admin = requireSession(request, 'admin');
            return send(
              response,
              200,
              registrationId
                ? identity.review(
                    assessmentId,
                    registrationId,
                    input.decision,
                    input.identityVerified,
                    admin.principal_id,
                  )
                : identity.updateSettings(assessmentId, input, admin.principal_id),
            );
          }
        }
        if (path === '/api/assessments' && method === 'GET') {
          const admin = requireSession(request, 'admin');
          return send(response, 200, {
            assessments: store.listAssessments(admin.principal_id),
            serverNow: store.now(),
          });
        }
        if (path === '/api/assessments' && method === 'POST') {
          const admin = requireSession(request, 'admin');
          limiter.take('create-assessment', 10, 60000);
          if (authoringBusy)
            throw new DomainError('Another roster is being prepared. Try again shortly.', 409);
          const input = await body(request);
          const requestId = input.creationRequestId;
          if (
            requestId !== undefined &&
            (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(requestId))
          )
            throw new DomainError('Invalid creation request identifier.', 400);
          if (requestId) {
            const existing = db
              .prepare(
                'SELECT assessment_id FROM assessment_creations WHERE admin_id=? AND request_id=?',
              )
              .get(admin.principal_id, requestId);
            if (existing)
              return send(response, 200, { id: existing.assessment_id, recovered: true });
          }
          if (authoringBusy)
            throw new DomainError(
              'Another assessment is being saved. Please try again shortly.',
              409,
            );
          const rosterSnapshot = input.rosterId
            ? new Rosters(store).snapshot(
                text(input.rosterId, 'Roster', 36),
                admin.principal_id,
                input.rosterRevision,
              )
            : null;
          if (rosterSnapshot) {
            requirePrimaryIdentity();
            input.candidates = rosterSnapshot.candidates;
            input.accessMode = 'accounts';
            input.registrationPolicy = 'roster';
            input.registrationCapacity = 500;
          }
          const { assessment, candidates } = parseAssessment(input, randomUUID);
          if (requestId) {
            authoring.assertWritable(admin.principal_id, String(requestId));
            if (input.authoringRevision !== undefined) {
              const draft = authoring.getDraft(admin.principal_id, String(requestId));
              if (!('revision' in draft) || draft.revision !== input.authoringRevision)
                throw new DomainError(
                  'This draft changed before creation. Reopen the saved draft; your tab changes are kept.',
                  409,
                  'AUTHORING_CONFLICT',
                );
            }
            assessment.id = String(requestId);
          }
          const registration = registrationConfig(input, candidates.length, store.now());
          if (registration.mode === 'accounts') requirePrimaryIdentity();
          authoringBusy = true;
          try {
            const secured = [];
            for (const candidate of candidates)
              secured.push({
                id: randomUUID(),
                identifier: candidate.identifier,
                name: candidate.name,
                hash:
                  registration.mode === 'accounts'
                    ? 'account-managed'
                    : await hashPassword(candidate.credential),
              });
            // Password hashing yields to the event loop; verify authorization again before committing.
            requireSession(request, 'admin');
            store.createAssessment(
              assessment,
              secured,
              admin.principal_id,
              registration,
              requestId as string | undefined,
              rosterSnapshot?.roster,
            );
          } finally {
            authoringBusy = false;
          }
          return send(response, 201, { id: assessment.id });
        }
        const editMatch = path.match(/^\/api\/assessments\/([a-f0-9-]+)\/(edit|rerun)$/);
        if (editMatch) {
          const admin = requireSession(request, 'admin');
          const editor = new AssessmentEditing(store);
          if (editMatch[2] === 'edit' && method === 'GET')
            return send(response, 200, editor.editView(editMatch[1]));
          if (editMatch[2] === 'edit' && method === 'PUT')
            return send(
              response,
              200,
              editor.update(editMatch[1], admin.principal_id, await body(request)),
            );
          if (editMatch[2] === 'rerun' && method === 'POST') {
            requirePrimaryIdentity();
            return send(
              response,
              201,
              editor.rerun(editMatch[1], admin.principal_id, await body(request)),
            );
          }
        }
        const reviewMatch = path.match(/^\/api\/assessments\/([a-f0-9-]+)\/review\/([a-f0-9-]+)$/);
        if (reviewMatch) {
          const admin = requireSession(request, 'admin');
          if (method === 'GET')
            return send(response, 200, store.review(reviewMatch[1], reviewMatch[2]));
          if (method === 'POST')
            return send(
              response,
              200,
              store.mark(reviewMatch[1], reviewMatch[2], await body(request), admin.principal_id),
            );
        }
        const assessmentMatch = path.match(
          /^\/api\/assessments\/([a-f0-9-]+)(?:\/(launch|end|monitor|admission|controls|results\.csv))?$/,
        );
        if (assessmentMatch) {
          const admin = requireSession(request, 'admin');
          const [, id, action] = assessmentMatch;
          if (action === 'controls' && method === 'POST')
            return send(
              response,
              200,
              controls.perform(id, admin.principal_id, await body(request)),
            );
          if (action === 'admission' && method === 'POST')
            return send(
              response,
              200,
              store.setAdmission(id, admin.principal_id, await body(request)),
            );
          if (action === 'monitor' && method === 'GET')
            return send(response, 200, monitoring.snapshot(id));
          if (action === 'launch' && method === 'POST') {
            if (
              db
                .prepare(
                  "SELECT 1 FROM events WHERE kind='online_exam_published' AND json_extract(detail,'$.assessmentId')=?",
                )
                .get(id)
            )
              throw new DomainError(
                'This assessment has been published online. Open its online examination or prepare a separate local run.',
                409,
              );
            preparation.assertLaunch(admin.principal_id, id);
            authoring.assertWritable(admin.principal_id, id);
            authoring.assertDelivery(admin.principal_id, id);
            return send(response, 200, store.launch(id, admin.principal_id));
          }
          if (action === 'end' && method === 'POST')
            return send(response, 200, store.end(id, admin.principal_id));
          if (!action && method === 'GET')
            return send(response, 200, {
              ...store.detail(id),
              preparedLocalRun: Boolean(
                db.prepare('SELECT 1 FROM local_preparations WHERE run_id=?').get(id),
              ),
              deliveryReady:
                authoring.deliveryReady(admin.principal_id, id) &&
                preparation.deliveryReady(admin.principal_id, id),
            });
          if (action === 'results.csv' && method === 'GET') {
            const detail = store.detail(id);
            const rows: unknown[][] = [
              [
                'Candidate ID',
                'Name',
                'Status',
                'Objective score',
                'Manual score',
                'Total score',
                'Maximum score',
                'Pending manual',
                'Percentage',
                'Pass',
                'Submitted at',
              ],
            ];
            for (const candidate of detail.candidates)
              rows.push([
                candidate.identifier,
                candidate.name,
                candidate.status,
                candidate.grade?.objectiveScore,
                candidate.grade?.manualScore,
                candidate.grade?.totalScore,
                candidate.grade?.maximumScore,
                candidate.grade?.pendingManual,
                candidate.grade?.percentage,
                candidate.grade?.passed === null || !candidate.grade
                  ? ''
                  : candidate.grade.passed
                    ? 'Yes'
                    : 'No',
                candidate.submittedAt ? new Date(candidate.submittedAt).toISOString() : '',
              ]);
            response.writeHead(200, {
              'Content-Type': 'text/csv; charset=utf-8',
              'Content-Disposition': resultsDisposition(detail.assessment.title),
            });
            return response.end(
              '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n'),
            );
          }
        }
        if (path === '/api/candidate/login' && method === 'POST') {
          limiter.take(`candidate-login:${ip}`, 30, 15 * 60000);
          const input = await body(request);
          const code = text(input.code, 'Exam code', 30).toUpperCase();
          const candidateIdentifier = identifier(input.identifier);
          const credential = text(input.credential, 'Access key', 128);
          limiter.take(`credential:${digest(`${code}:${candidateIdentifier}`)}`, 10, 15 * 60000);
          const row = db
            .prepare(
              `SELECT c.id,s.id AS sitting_id,c.credential_hash FROM candidates c
            JOIN sittings s ON s.assessment_id=c.assessment_id WHERE s.code=? AND c.identifier=?`,
            )
            .get(code, candidateIdentifier);
          const valid = await verifyPassword(
            credential,
            row?.credential_hash === 'account-managed'
              ? dummyHash
              : String(row?.credential_hash ?? dummyHash),
          );
          if (!row || !valid)
            throw new DomainError('Check your exam code, candidate ID, and access key.', 401);
          const session = transaction(db, () => {
            const value = store.createSession('candidate', String(row.id), String(row.sitting_id));
            store.event(String(row.sitting_id), String(row.id), 'candidate_signed_in', {
              previousDeviceRevoked: true,
            });
            return value;
          });
          setSession(response, session.raw);
          return send(response, 200, { csrf: session.csrf });
        }
        const accountExamMatch = path.match(
          /^\/api\/candidate\/examinations\/([a-f0-9-]+)\/(state|heartbeat|announcements\/read|start|submit|answers\/([a-f0-9-]+))$/,
        );
        if (accountExamMatch) {
          const input = method === 'PUT' ? await body(request) : {};
          const session = requireSession(request, 'candidate');
          if (!session.account_id) throw new DomainError('Sign in with your MUDU account.', 401);
          const { sittingId, candidateId } = identity.authorizeExam(
            session.account_id,
            accountExamMatch[1],
          );
          const action = accountExamMatch[2];
          if (action === 'announcements/read' && method === 'POST')
            return send(
              response,
              200,
              controls.acknowledge(sittingId, candidateId, await body(request)),
            );
          if (action === 'heartbeat' && method === 'POST')
            return send(response, 200, monitoring.heartbeat(sittingId, candidateId));
          if (action === 'state' && method === 'GET')
            return send(response, 200, store.candidateView(sittingId, candidateId));
          if (action === 'start' && method === 'POST') {
            store.start(sittingId, candidateId);
            return send(response, 200, store.candidateView(sittingId, candidateId));
          }
          if (action === 'submit' && method === 'POST') {
            store.submit(sittingId, candidateId);
            return send(response, 200, store.candidateView(sittingId, candidateId));
          }
          if (accountExamMatch[3] && method === 'PUT')
            return send(
              response,
              200,
              store.save(sittingId, candidateId, accountExamMatch[3], {
                value: input.value,
                expectedRevision: input.expectedRevision,
                operationId: input.operationId,
              }),
            );
          throw new DomainError('Method not allowed.', 405);
        }
        if (path.startsWith('/api/candidate/')) {
          const session = requireSession(request, 'candidate');
          if (session.account_id || !session.sitting_id)
            throw new DomainError('Select an examination from My examinations.', 409);
          const sittingId = session.sitting_id!;
          if (path === '/api/candidate/announcements/read' && method === 'POST')
            return send(
              response,
              200,
              controls.acknowledge(sittingId, session.principal_id, await body(request)),
            );
          if (path === '/api/candidate/heartbeat' && method === 'POST')
            return send(response, 200, monitoring.heartbeat(sittingId, session.principal_id));
          if (path === '/api/candidate/state' && method === 'GET')
            return send(response, 200, store.candidateView(sittingId, session.principal_id));
          if (path === '/api/candidate/start' && method === 'POST') {
            store.start(sittingId, session.principal_id);
            return send(response, 200, store.candidateView(sittingId, session.principal_id));
          }
          if (path === '/api/candidate/submit' && method === 'POST') {
            store.submit(sittingId, session.principal_id);
            return send(response, 200, store.candidateView(sittingId, session.principal_id));
          }
          const answerMatch = path.match(/^\/api\/candidate\/answers\/([a-f0-9-]+)$/);
          if (answerMatch && method === 'PUT') {
            const input = await body(request);
            // Recheck after reading the body: a concurrent sign-in can revoke this device.
            requireSession(request, 'candidate');
            return send(
              response,
              200,
              store.save(sittingId, session.principal_id, answerMatch[1], {
                value: input.value,
                expectedRevision: input.expectedRevision,
                operationId: input.operationId,
              }),
            );
          }
        }
        throw new DomainError('Endpoint not found.', 404);
      }
      if (method !== 'GET' && method !== 'HEAD') throw new DomainError('Method not allowed.', 405);
      if (!options.staticDir)
        return send(response, 404, {
          message: 'Start the web app with npm run dev, or build it with npm run build.',
        });
      const root = resolve(options.staticDir);
      const target = resolve(root, '.' + decodeURIComponent(path));
      if (target !== root && !target.startsWith(root + sep))
        throw new DomainError('Not found.', 404);
      let file = target;
      try {
        if (!(await stat(file)).isFile()) file = resolve(root, 'index.html');
      } catch {
        if (extname(target)) throw new DomainError('Not found.', 404);
        file = resolve(root, 'index.html');
      }
      const mime: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
      };
      const content = await readFile(file);
      response.writeHead(200, {
        'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
      });
      response.end(method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof DomainError)
        return send(response, error.status, { message: error.message, code: error.code });
      const reference = randomUUID();
      console.error(
        `Host error ${reference}:`,
        error instanceof Error ? error.name : 'Unknown error',
      );
      send(response, 500, {
        message: 'MUDU could not complete the request. Your saved work remains on the Host.',
        reference,
      });
    }
  };
}
