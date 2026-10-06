import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { openDatabase } from '../apps/host/database.ts';
import { createHandler } from '../apps/host/http.ts';
import { DomainError } from '../packages/exam-core/model.ts';
import { input } from './fixtures.ts';
import { encryptSession, decryptSession, supabaseConfig } from '../apps/host/supabase-auth.ts';
import type { CloudSession, CloudAuthProvider } from '../apps/host/supabase-auth.ts';
import { ExamStore } from '../apps/host/store.ts';
import { CloudAdministrators } from '../apps/host/cloud-administrators.ts';
import { draftOwnerKey, selectDraftWorkspace } from '../apps/web/workspace-drafts.ts';
import { draftKey } from '../apps/web/assessment-draft.ts';
import { assessment } from './fixtures.ts';

const identity = (email: string): CloudSession => ({
  userId: randomUUID(),
  email,
  name: email.split('@')[0],
  accessToken: 'test-access-only',
  refreshToken: 'test-refresh-only',
  expiresAt: Date.now() + 3600000,
});

test('cloud configuration rejects secret keys; encrypted sessions cannot be moved or tampered with', () => {
  const url = 'https://example.supabase.co';
  assert.equal(supabaseConfig({}), null);
  assert.throws(() => supabaseConfig({ MUDU_SUPABASE_URL: url }), /both/);
  assert.throws(
    () =>
      supabaseConfig({
        MUDU_SUPABASE_URL: 'http://example.supabase.co',
        MUDU_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      supabaseConfig({ MUDU_SUPABASE_URL: url, MUDU_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_test' }),
    /never/,
  );
  const service = [
    'header',
    Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url'),
    'signature',
  ].join('.');
  assert.throws(
    () => supabaseConfig({ MUDU_SUPABASE_URL: url, MUDU_SUPABASE_PUBLISHABLE_KEY: service }),
    /publishable/,
  );
  const key = randomBytes(32),
    value = identity('one@example.test');
  const encrypted = encryptSession(value, key, 'cookie-hash');
  assert.doesNotMatch(encrypted, /test-access|test-refresh/);
  assert.deepEqual(decryptSession(encrypted, key, 'cookie-hash'), value);
  assert.throws(() => decryptSession(encrypted, key, 'different-cookie'), /sign in/);
  assert.throws(() => decryptSession(encrypted, randomBytes(32), 'cookie-hash'), /sign in/);
});

test('two cloud administrators cannot read or mutate another workspace through any assessment route', async (t) => {
  const db = openDatabase(':memory:');
  const first = identity('first@example.test'),
    second = identity('second@example.test');
  let unavailable = false,
    revoked = false;
  const provider: CloudAuthProvider = {
    signIn: async (email, password) => {
      if (password !== 'correct testing password')
        throw new DomainError('Check your email and password.', 401);
      return email === first.email ? first : second;
    },
    signUp: async () => ({ pending: true }),
    verify: async (value) => {
      if (unavailable) throw new DomainError('Verification unavailable.', 503);
      if (revoked) throw new DomainError('Please sign in again.', 401);
      return value;
    },
  };
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on(
    'request',
    await createHandler(db, { origin: base, cloudAuth: { provider, sessionKey: randomBytes(32) } }),
  );
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  function client() {
    let cookie = '',
      csrf = '';
    return async (
      path: string,
      method = 'GET',
      body?: unknown,
      headers: Record<string, string> = {},
    ) => {
      const response = await fetch(base + '/api' + path, {
        method,
        headers: {
          Origin: base,
          Cookie: cookie,
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const next = response.headers.get('set-cookie');
      if (next) cookie = next.split(';')[0];
      const value = response.headers.get('content-type')?.includes('application/json')
        ? await response.json()
        : await response.text();
      if (value.csrf) csrf = value.csrf;
      return { status: response.status, value };
    };
  }
  const a = client(),
    b = client(),
    candidate = client(),
    stranger = client();
  assert.equal((await a('/auth')).value.cloudAvailable, true);
  const pending = await stranger('/admin/cloud/signup', 'POST', {
    name: 'New',
    email: 'new@example.test',
    password: 'a sufficiently long phrase',
  });
  assert.equal(pending.status, 202);
  assert.equal((await stranger('/auth')).value.role, null);
  for (const [client, email] of [
    [a, first.email],
    [b, second.email],
  ] as const)
    assert.equal(
      (
        await client('/admin/cloud/login', 'POST', {
          email,
          password: 'correct testing password',
          ownerId: 'spoofed',
        })
      ).status,
      200,
    );
  assert.notEqual((await a('/auth')).value.adminId, (await b('/auth')).value.adminId);
  const exam = (
    await a('/assessments', 'POST', {
      ...input(),
      accessMode: 'accounts',
      candidates: [],
      registrationPolicy: 'approval',
    })
  ).value;
  assert.equal((await a('/assessments')).value.assessments.length, 1);
  assert.equal((await b('/assessments')).value.assessments.length, 0);
  for (const [suffix, method, body] of [
    ['', 'GET', undefined],
    ['/edit', 'GET', undefined],
    ['/edit', 'PUT', {}],
    ['/rerun', 'POST', {}],
    ['/monitor', 'GET', undefined],
    ['/registration', 'GET', undefined],
    ['/registration', 'POST', {}],
    ['/roster', 'GET', undefined],
    ['/results.csv', 'GET', undefined],
    ['/review/' + randomUUID(), 'GET', undefined],
    ['/review/' + randomUUID(), 'POST', {}],
    ['/launch', 'POST', {}],
    ['/end', 'POST', {}],
    ['/admission', 'POST', {}],
    ['/controls', 'POST', {}],
  ] as const) {
    assert.equal(
      (await b(`/assessments/${exam.id}${suffix}`, method, body)).status,
      404,
      `${method} ${suffix}`,
    );
  }
  assert.equal((await b(`/assessments/${randomUUID()}`)).status, 404);
  const rosterId = randomUUID();
  const roster = await a(`/rosters/${rosterId}`, 'POST', {
    name: 'Private class',
    revision: 0,
    restricted: false,
    open: true,
    archived: false,
    entries: [],
  });
  assert.equal(roster.status, 200);
  assert.equal((await b(`/rosters/${rosterId}`)).status, 404);
  assert.equal((await b('/rosters')).value.rosters.length, 0);
  assert.equal((await b('/local-delivery')).status, 403);
  const registration = (await a(`/assessments/${exam.id}/registration`)).value.settings;
  assert.equal(
    (
      await candidate('/candidate/account/signup', 'POST', {
        name: 'Shared candidate',
        email: 'candidate@example.test',
        password: 'a memorable testing passphrase',
      })
    ).status,
    201,
  );
  assert.equal((await candidate('/auth')).value.configured, true);
  assert.equal((await candidate(`/registration/${registration.token}`, 'POST', {})).status, 200);
  assert.equal((await a('/enrolment-directory')).value.candidates.length, 1);
  assert.equal((await b('/enrolment-directory')).value.candidates.length, 0);
  assert.equal((await b('/candidate-directory')).value.candidates.length, 0);
  assert.equal((await a('/notifications')).value.unread, 1);
  assert.equal((await b('/notifications')).value.unread, 0);
  const otherExam = (
    await b('/assessments', 'POST', {
      ...input(),
      accessMode: 'accounts',
      candidates: [],
      registrationPolicy: 'approval',
    })
  ).value;
  const otherLink = (await b(`/assessments/${otherExam.id}/registration`)).value.settings.token;
  const accountId = (await candidate('/auth')).value.accountId;
  assert.equal((await candidate(`/registration/${otherLink}`, 'POST', {})).status, 200);
  assert.equal((await candidate('/auth')).value.accountId, accountId);
  assert.equal((await a('/enrolment-directory')).value.candidates.length, 1);
  assert.equal((await b('/enrolment-directory')).value.candidates.length, 1);
  assert.doesNotMatch(
    JSON.stringify((await a('/auth')).value),
    /accessToken|refreshToken|password_hash/,
  );
  assert.equal((await candidate('/assessments')).status, 403);
  unavailable = true;
  assert.equal((await a('/assessments')).status, 503);
  unavailable = false;
  revoked = true;
  assert.equal((await a('/assessments')).status, 401);
  revoked = false;
  assert.equal((await a('/auth')).value.role, null);
  assert.equal((await b('/assessments', 'POST', input(), { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal(
    (
      await b(
        '/admin/cloud/login',
        'POST',
        { email: second.email, password: 'correct testing password' },
        { Origin: 'https://evil.invalid' },
      )
    ).status,
    403,
  );
});

test('connecting a local workspace preserves its administrator ID and never takes over an occupied cloud workspace', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const store = new ExamStore(db);
  db.prepare('INSERT INTO administrators VALUES(?,?,?,1)').run(
    'local',
    'Lecturer',
    'existing-verifier',
  );
  const remote = identity('lecturer@example.test');
  const provider: CloudAuthProvider = {
    signIn: async () => remote,
    signUp: async () => ({ pending: true }),
    verify: async (s) => s,
  };
  const cloud = new CloudAdministrators(store, provider, randomBytes(32));
  const originalPassword = db
    .prepare('SELECT password_hash FROM administrators WHERE id=?')
    .get('local')!.password_hash;
  const empty = cloud.open(remote);
  const emptyId = store.session(empty.raw)!.principal_id;
  assert.notEqual(emptyId, 'local');
  const connected = cloud.open(remote, 'local');
  assert.equal(store.session(connected.raw)!.principal_id, 'local');
  assert.equal(store.session(empty.raw), undefined);
  assert.equal(
    db.prepare('SELECT password_hash FROM administrators WHERE id=?').get('local')!.password_hash,
    originalPassword,
  );
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('connecting an occupied cloud workspace fails without moving records or invalidating its session', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.prepare('INSERT INTO administrators VALUES(?,?,?,1)').run(
    'local',
    'Local',
    'original-verifier',
  );
  const store = new ExamStore(db),
    remote = identity('occupied@example.test');
  const provider: CloudAuthProvider = {
    signIn: async () => remote,
    signUp: async () => ({ pending: true }),
    verify: async (s) => s,
  };
  const cloud = new CloudAdministrators(store, provider, randomBytes(32));
  const session = cloud.open(remote),
    owner = store.session(session.raw)!.principal_id;
  const exam = assessment();
  store.createAssessment(exam, [], owner);
  assert.throws(() => cloud.open(remote, 'local'), /already owns/);
  assert.equal(store.session(session.raw)!.principal_id, owner);
  assert.equal(
    db.prepare('SELECT owner_id FROM assessment_owners WHERE assessment_id=?').get(exam.id)!
      .owner_id,
    owner,
  );
  assert.equal(
    db
      .prepare('SELECT administrator_id FROM admin_provider_identities WHERE provider_user_id=?')
      .get(remote.userId)!.administrator_id,
    owner,
  );
});

test('tab drafts cannot cross administrator identities; candidate answer outboxes are untouched', () => {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  values.set(draftKey, 'legacy draft');
  values.set('candidate-outbox', 'saved answers');
  selectDraftWorkspace(storage, 'local', true);
  assert.equal(values.get(draftKey), 'legacy draft');
  selectDraftWorkspace(storage, 'local', true);
  assert.equal(values.get(draftKey), 'legacy draft');
  selectDraftWorkspace(storage, 'new-cloud');
  assert.equal(values.has(draftKey), false);
  assert.equal(values.get('candidate-outbox'), 'saved answers');
  assert.equal(values.get(draftOwnerKey), 'new-cloud');
  values.delete(draftOwnerKey);
  values.set(draftKey, 'unattributed');
  selectDraftWorkspace(storage, 'different-cloud');
  assert.equal(values.has(draftKey), false);
});
