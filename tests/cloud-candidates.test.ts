import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../apps/host/database.ts';
import { ExamStore } from '../apps/host/store.ts';
import { IdentityService } from '../apps/host/identity.ts';
import { Rosters } from '../apps/host/rosters.ts';
import { CloudCandidates } from '../apps/host/cloud-candidates.ts';
import { CloudAdministrators } from '../apps/host/cloud-administrators.ts';
import { createHandler } from '../apps/host/http.ts';
import { digest, hashPassword } from '../apps/host/security.ts';
import { decryptSession } from '../apps/host/supabase-auth.ts';
import type { CloudSession, CloudAuthProvider } from '../apps/host/supabase-auth.ts';
import { DomainError } from '../packages/exam-core/model.ts';
import { assessment } from './fixtures.ts';

function cloudIdentity(email = 'candidate@example.test'): CloudSession {
  return {
    userId: randomUUID(),
    email,
    name: 'Candidate',
    accessToken: 'private-access',
    refreshToken: 'private-refresh',
    expiresAt: Date.now() + 3600000,
  };
}

test('candidate cloud identity is stable across Hosts without transferring password verifiers', (t) => {
  const value = cloudIdentity();
  const first = openDatabase(':memory:'),
    second = openDatabase(':memory:');
  t.after(() => {
    first.close();
    second.close();
  });
  for (const db of [first, second]) {
    const store = new ExamStore(db),
      key = randomBytes(32);
    const candidates = new CloudCandidates(store, key);
    const session = candidates.open(value);
    assert.equal(store.session(session.raw)!.account_id, value.userId);
    assert.equal(
      db.prepare('SELECT password_hash FROM accounts').get()!.password_hash,
      'supabase-managed',
    );
    const encrypted = db.prepare('SELECT access_token FROM provider_sessions').get()!.access_token;
    assert.doesNotMatch(String(encrypted), /private-access|private-refresh/);
    assert.equal(decryptSession(String(encrypted), key, digest(session.raw)).userId, value.userId);
    candidates.open(value);
    assert.equal(store.session(session.raw), undefined);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounts').get()!.n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM provider_sessions').get()!.n, 1);
  }
});

test('explicit connection preserves local identity, approved membership, assignments and local password', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const store = new ExamStore(db),
    local = new IdentityService(store),
    rosters = new Rosters(store);
  const value = cloudIdentity();
  const original = local.createAccount({
    email: value.email,
    name: 'Existing candidate',
    identifier: '001',
    hash: 'unchanged-local-verifier',
  });
  const id = store.session(original.raw)!.account_id!;
  const rosterId = randomUUID();
  const roster = rosters.save(rosterId, 'admin', {
    name: 'Class',
    revision: 0,
    restricted: false,
    open: true,
    archived: false,
    entries: [],
  });
  rosters.join(roster.token, id);
  rosters.review(rosterId, 'admin', id, { decision: 'approved' });
  const snapshot = rosters.snapshot(rosterId, 'admin', 2),
    paper = assessment();
  store.createAssessment(
    paper,
    snapshot.candidates.map((c) => ({ ...c, id: randomUUID(), hash: 'account-managed' })),
    'admin',
    { mode: 'accounts', policy: 'roster', capacity: 500, closesAt: null },
    undefined,
    snapshot.roster,
  );
  const before = JSON.stringify(local.examinations(id));
  const service = new CloudCandidates(store, randomBytes(32));
  assert.throws(() => service.open(value), /already exists/);
  const connected = service.open(value, id);
  assert.equal(store.session(connected.raw)!.account_id, id);
  assert.equal(store.session(original.raw), undefined);
  assert.equal(
    db.prepare('SELECT password_hash FROM accounts WHERE id=?').get(id)!.password_hash,
    'unchanged-local-verifier',
  );
  assert.equal(local.profile(id).identifier, '001');
  assert.equal(rosters.get(rosterId, 'admin').members[0].status, 'approved');
  assert.equal(JSON.stringify(local.examinations(id)), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounts').get()!.n, 1);
});

test('candidate connections reject email takeover, competing identities and malformed UUIDs atomically', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const store = new ExamStore(db),
    local = new IdentityService(store),
    service = new CloudCandidates(store, randomBytes(32));
  const value = cloudIdentity();
  const s = local.createAccount({ email: value.email, name: 'Local', hash: 'local' }),
    id = store.session(s.raw)!.account_id!;
  assert.throws(() => service.open({ ...value, email: 'other@example.test' }, id), /same email/);
  assert.throws(() => service.open({ ...value, userId: 'not-a-uuid' }), /sign in/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM candidate_provider_identities').get()!.n, 0);
  service.open(value, id);
  assert.throws(() => service.open({ ...value, userId: randomUUID() }, id), /different cloud/);
  local.createAccount({ email: 'other@example.test', name: 'Other', hash: 'other' });
  assert.throws(() => service.open({ ...value, email: 'other@example.test' }), /already attached/);
  assert.equal(local.profile(id).email, value.email);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM candidate_provider_identities').get()!.n, 1);
});

test('cloud candidate verification uses candidate binding, denies revoked identity, and retains sessions during outages', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const store = new ExamStore(db),
    key = randomBytes(32),
    value = cloudIdentity();
  const s = new CloudCandidates(store, key).open(value);
  let status = 200;
  const provider: CloudAuthProvider = {
    signIn: async () => value,
    signUp: async () => ({ pending: true }),
    verify: async (v) => {
      if (status !== 200) throw new DomainError('Unavailable', status);
      return v;
    },
  };
  const verifier = new CloudAdministrators(store, provider, key);
  await verifier.verify(s.raw);
  status = 503;
  await assert.rejects(verifier.verify(s.raw), (e) => e instanceof DomainError && e.status === 503);
  assert.ok(store.session(s.raw));
  status = 401;
  await assert.rejects(verifier.verify(s.raw), (e) => e instanceof DomainError && e.status === 401);
  assert.equal(store.session(s.raw), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM provider_sessions').get()!.n, 0);
});

test('a cloud candidate cannot authorize through an administrator binding or a tampered candidate binding', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const store = new ExamStore(db),
    key = randomBytes(32),
    value = cloudIdentity();
  const s = new CloudCandidates(store, key).open(value);
  db.prepare('UPDATE candidate_provider_identities SET provider_user_id=?').run(randomUUID());
  let checks = 0;
  const provider: CloudAuthProvider = {
    signIn: async () => value,
    signUp: async () => ({ pending: true }),
    verify: async (v) => {
      checks++;
      return v;
    },
  };
  await assert.rejects(new CloudAdministrators(store, provider, key).verify(s.raw), /sign in/);
  assert.equal(checks, 0);
  assert.equal(store.session(s.raw), undefined);
});

async function httpFixture(t: TestContext, candidateListener = false, replica = false) {
  const db = openDatabase(':memory:'),
    value = cloudIdentity(),
    key = randomBytes(32);
  let pending = true,
    revoked = false,
    verifyCalls = 0;
  let beforeSignIn: (() => void) | undefined;
  const provider: CloudAuthProvider = {
    signIn: async (email, password) => {
      if (email !== value.email || password !== 'cloud-password')
        throw new DomainError('Check credentials', 401);
      beforeSignIn?.();
      return value;
    },
    signUp: async () => (pending ? { pending: true } : { pending: false, session: value }),
    verify: async (v) => {
      verifyCalls++;
      if (revoked) throw new DomainError('Please sign in again.', 401);
      return v;
    },
  };
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on(
    'request',
    await createHandler(db, {
      origin: base,
      cloudAuth: { provider, sessionKey: key },
      candidateListener,
      identityMode: replica ? 'replica' : 'primary',
    }),
  );
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  let cookie = '',
    csrf = '';
  async function request(
    path: string,
    method = 'GET',
    data?: unknown,
    headers: Record<string, string> = {},
  ) {
    const r = await fetch(base + '/api' + path, {
      method,
      headers: {
        Origin: base,
        Cookie: cookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const json = await r.json();
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    if (json.csrf) csrf = json.csrf;
    return { status: r.status, json, set };
  }
  return {
    db,
    value,
    request,
    setPending: (v: boolean) => {
      pending = v;
    },
    revoke: () => {
      revoked = true;
    },
    checks: () => verifyCalls,
    beforeSignIn: (fn: () => void) => {
      beforeSignIn = fn;
    },
  };
}

test('HTTP cloud signup waits for email confirmation; login grants candidate-only access and verifies later requests', async (t) => {
  const f = await httpFixture(t);
  const signup = await f.request('/candidate/cloud/signup', 'POST', {
    email: f.value.email,
    name: 'Candidate',
    password: 'cloud-password',
  });
  assert.equal(signup.status, 202);
  assert.equal(signup.json.pending, true);
  assert.equal(signup.set, null);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM accounts').get()!.n, 0);
  const login = await f.request('/candidate/cloud/login', 'POST', {
    email: f.value.email,
    password: 'cloud-password',
  });
  assert.equal(login.status, 200);
  assert.doesNotMatch(JSON.stringify(login.json), /private-access|private-refresh/);
  const auth = await f.request('/auth');
  assert.equal(auth.json.role, 'candidate');
  assert.equal(auth.json.candidateCloudConnected, true);
  assert.equal(auth.json.candidateCloudSignedIn, true);
  assert.equal((await f.request('/candidate/me')).status, 200);
  assert.ok(f.checks() > 0);
  assert.equal((await f.request('/question-bank')).status, 403);
  f.revoke();
  assert.equal((await f.request('/candidate/me')).status, 401);
  assert.equal((await f.request('/auth')).json.role, null);
});

test('HTTP linking requires local password and CSRF; connection retains a working offline login', async (t) => {
  const f = await httpFixture(t),
    store = new ExamStore(f.db);
  f.db.prepare('INSERT INTO administrators VALUES(?,?,?,1)').run(randomUUID(), 'Host', 'unused');
  const s = new IdentityService(store).createAccount({
    email: f.value.email,
    name: 'Existing',
    hash: await hashPassword('local-password'),
  });
  const id = store.session(s.raw)!.account_id!;
  assert.equal(
    (
      await f.request('/candidate/account/login', 'POST', {
        login: f.value.email,
        password: 'local-password',
      })
    ).status,
    200,
  );
  const body = {
    email: f.value.email,
    password: 'cloud-password',
    localPassword: 'local-password',
  };
  assert.equal(
    (await f.request('/candidate/cloud/connect', 'POST', body, { 'X-CSRF-Token': 'wrong' })).status,
    403,
  );
  assert.equal(
    (await f.request('/candidate/cloud/connect', 'POST', { ...body, localPassword: 'wrong' }))
      .status,
    401,
  );
  assert.equal((await f.request('/candidate/cloud/connect', 'POST', body)).status, 200);
  assert.equal((await f.request('/auth')).json.accountId, id);
  f.revoke();
  assert.equal(
    (
      await f.request('/candidate/account/login', 'POST', {
        login: f.value.email,
        password: 'local-password',
      })
    ).status,
    200,
  );
  assert.equal((await f.request('/candidate/me')).status, 200);
  assert.equal((await f.request('/auth')).json.candidateCloudSignedIn, false);
});

test('cloud candidate auth is unavailable on LAN candidate listeners and replica Hosts', async (t) => {
  for (const mode of ['listener', 'replica']) {
    const f = await httpFixture(t, mode === 'listener', mode === 'replica');
    assert.equal((await f.request('/auth')).json.candidateCloudAvailable, false);
    assert.equal(
      (
        await f.request('/candidate/cloud/login', 'POST', {
          email: f.value.email,
          password: 'cloud-password',
        })
      ).status,
      409,
    );
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM accounts').get()!.n, 0);
    assert.equal(f.checks(), 0);
  }
});

test('connecting cannot complete after the authorizing local session is revoked during provider sign-in', async (t) => {
  const f = await httpFixture(t),
    store = new ExamStore(f.db);
  f.db.prepare('INSERT INTO administrators VALUES(?,?,?,1)').run(randomUUID(), 'Host', 'unused');
  new IdentityService(store).createAccount({
    email: f.value.email,
    name: 'Local',
    hash: await hashPassword('local-password'),
  });
  await f.request('/candidate/account/login', 'POST', {
    login: f.value.email,
    password: 'local-password',
  });
  f.beforeSignIn(() => {
    f.db.prepare('DELETE FROM sessions').run();
  });
  const r = await f.request('/candidate/cloud/connect', 'POST', {
    email: f.value.email,
    password: 'cloud-password',
    localPassword: 'local-password',
  });
  assert.equal(r.status, 401);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM candidate_provider_identities').get()!.n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM provider_sessions').get()!.n, 0);
});

test('confirmation-pending connection leaves the local session and records untouched', async (t) => {
  const f = await httpFixture(t),
    store = new ExamStore(f.db);
  f.db.prepare('INSERT INTO administrators VALUES(?,?,?,1)').run(randomUUID(), 'Host', 'unused');
  const original = new IdentityService(store).createAccount({
    email: f.value.email,
    name: 'Local',
    hash: await hashPassword('local-password'),
  });
  const id = store.session(original.raw)!.account_id!;
  await f.request('/candidate/account/login', 'POST', {
    login: f.value.email,
    password: 'local-password',
  });
  const r = await f.request('/candidate/cloud/connect/signup', 'POST', {
    email: f.value.email,
    password: 'cloud-password',
    localPassword: 'local-password',
  });
  assert.equal(r.status, 202);
  assert.equal(r.set, null);
  const auth = await f.request('/auth');
  assert.equal(auth.json.accountId, id);
  assert.equal(auth.json.candidateCloudConnected, false);
  assert.equal((await f.request('/candidate/me')).status, 200);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM accounts').get()!.n, 1);
});

test('v14 upgrade preserves candidates and sessions; connected bindings and encrypted sessions survive reopening', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mudu-candidate-link-')),
    path = join(directory, 'exam.sqlite');
  let db = openDatabase(path);
  t.after(() => {
    db.close();
    for (const file of readdirSync(directory)) unlinkSync(join(directory, file));
    rmdirSync(directory);
  });
  let store = new ExamStore(db);
  const value = cloudIdentity(),
    key = randomBytes(32);
  const original = new IdentityService(store).createAccount({
    email: value.email,
    name: 'Local',
    hash: 'retained-verifier',
  });
  const id = store.session(original.raw)!.account_id!;
  db.exec(
    'DROP TABLE workspace_connections; DROP TABLE account_preferences; DROP TABLE admin_device_sessions; DROP TABLE admin_device_access; DROP TABLE password_recovery; DROP TABLE offline_candidate_sessions; DROP TABLE local_admission; DROP TABLE local_preparations; DROP TABLE authoring_drafts; DROP TABLE candidate_provider_identities; PRAGMA user_version=14;',
  );
  db.close();
  db = openDatabase(path);
  store = new ExamStore(db);
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 21);
  assert.ok(existsSync(`${path}.before-v15`));
  assert.equal(store.session(original.raw)!.account_id, id);
  const linked = new CloudCandidates(store, key).open(value, id);
  db.close();
  db = openDatabase(path);
  store = new ExamStore(db);
  assert.equal(store.session(linked.raw)!.account_id, id);
  assert.equal(
    db.prepare('SELECT password_hash FROM accounts WHERE id=?').get(id)!.password_hash,
    'retained-verifier',
  );
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  const provider: CloudAuthProvider = {
    signIn: async () => value,
    signUp: async () => ({ pending: true }),
    verify: async (v) => v,
  };
  await new CloudAdministrators(store, provider, key).verify(linked.raw);
});
