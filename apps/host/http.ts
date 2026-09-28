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

interface HostOptions {
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
  const store = new ExamStore(db, options.now);
  const identity = new IdentityService(store);
  const bank = new QuestionBank(store);
  const generation = new QuestionGeneration(store);
  const limiter = new RateLimiter();
  const dummyHash = await hashPassword(token());
  const origins = new Set([options.origin, ...(options.webOrigin ? [options.webOrigin] : [])]);
  const hosts = new Set([...origins].map((origin) => new URL(origin).host));
  let authoringBusy = false;
  store.reconcile();
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
    if (session.account_id) requirePrimaryIdentity();
    if (role && session.role !== role)
      throw new DomainError('You do not have permission to do that.', 403);
    if (session.role === 'admin' && !isLoopback(request.socket.remoteAddress))
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
        limiter.take(`request:${ip}`, 1200, 60000);
        if (!['GET', 'HEAD'].includes(method) && !origins.has(request.headers.origin ?? ''))
          throw new DomainError('Unrecognized request origin.', 403);

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
            origin: managed?.origin ?? (external ? options.origin : null),
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
            options.identityMode === 'replica' && storedSession?.account_id
              ? undefined
              : storedSession;
          const admin = db.prepare('SELECT name FROM administrators WHERE singleton=1').get();
          return send(response, 200, {
            configured: Boolean(admin),
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
          if (db.prepare('SELECT id FROM administrators').get())
            throw new DomainError('This Host has already been set up.', 409);
          const input = await body(request);
          const name = text(input.name, 'Your name', 100);
          const password = text(input.password, 'Password', 128, 12);
          const hash = await hashPassword(password);
          const session = transaction(db, () => {
            if (db.prepare('SELECT id FROM administrators').get())
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
              String(row?.password_hash ?? dummyHash),
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
          if (path === '/api/question-bank/ai/status' && method === 'GET')
            return send(response, 200, generation.availability());
          if (path === '/api/question-bank/generate' && method === 'POST')
            return send(
              response,
              200,
              await generation.generate(admin.principal_id, await body(request), () => {
                requireSession(request, 'admin');
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
        if (path === '/api/candidate/rosters' && method === 'GET') {
          const session = requireSession(request, 'candidate');
          if (!session.account_id) throw new DomainError('Sign in with your MUDU account.', 401);
          return send(response, 200, {
            rosters: db
              .prepare(
                'SELECT r.name,r.token,m.status FROM roster_members m JOIN rosters r ON r.id=m.roster_id WHERE m.account_id=? ORDER BY r.name',
              )
              .all(session.account_id),
          });
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
            return send(response, 200, rosters.join(rosterJoin[1], session.account_id));
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
          return send(response, 200, { examinations: identity.examinations(session.account_id) });
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
          requireSession(request, 'admin');
          return send(response, 200, { candidates: identity.directory() });
        }
        if (path === '/api/enrolment-directory' && method === 'GET') {
          requireSession(request, 'admin');
          return send(response, 200, { candidates: identity.directory(true) });
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
          requireSession(request, 'admin');
          return send(response, 200, {
            assessments: store.listAssessments(),
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
          /^\/api\/assessments\/([a-f0-9-]+)(?:\/(launch|end|results\.csv))?$/,
        );
        if (assessmentMatch) {
          const admin = requireSession(request, 'admin');
          const [, id, action] = assessmentMatch;
          if (action === 'launch' && method === 'POST')
            return send(response, 200, store.launch(id, admin.principal_id));
          if (action === 'end' && method === 'POST')
            return send(response, 200, store.end(id, admin.principal_id));
          if (!action && method === 'GET') return send(response, 200, store.detail(id));
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
          /^\/api\/candidate\/examinations\/([a-f0-9-]+)\/(state|start|submit|answers\/([a-f0-9-]+))$/,
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
