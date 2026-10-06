import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../apps/host/database.ts';
import { createHandler } from '../apps/host/http.ts';
import { ExamStore } from '../apps/host/store.ts';
import { CloudAdministrators } from '../apps/host/cloud-administrators.ts';
import { WorkspaceConnection } from '../apps/host/workspace-connection.ts';
import { hashPassword } from '../apps/host/security.ts';
import type { CloudAuthProvider, CloudSession } from '../apps/host/supabase-auth.ts';
import { DomainError } from '../packages/exam-core/model.ts';
import { input } from './fixtures.ts';

async function fixture(t: TestContext) {
  const db = openDatabase(':memory:');
  let now = Date.now(),
    failure = 0,
    calls = 0;
  const first: CloudSession = {
    userId: randomUUID(),
    email: 'one@example.test',
    name: 'One',
    accessToken: 'test-access',
    refreshToken: 'test-refresh',
    expiresAt: now + 3600000,
  };
  const second = { ...first, userId: randomUUID(), email: 'two@example.test', name: 'Two' };
  const provider: CloudAuthProvider = {
    signUp: async () => ({ pending: true }),
    signIn: async (email, password) => {
      if (password !== 'correct account password')
        throw new DomainError('Incorrect password.', 401);
      return email === first.email ? first : second;
    },
    verify: async (value) => {
      calls++;
      if (failure) throw new DomainError('Provider failure.', failure);
      return value;
    },
    updateName: async (session, name) => {
      assert.equal(session.userId, first.userId);
      first.name = name;
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
      now: () => now,
      cloudAuth: { provider, sessionKey: randomBytes(32) },
    }),
  );
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  function client() {
    let cookie = '',
      csrf = '';
    return {
      get cookie() {
        return cookie;
      },
      request: async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
        const response = await fetch(base + '/api' + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            Origin: base,
            Cookie: cookie,
            'X-CSRF-Token': csrf,
            'Content-Type': 'application/json',
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const next = response.headers.get('set-cookie');
        if (next) cookie = next.split(';')[0];
        const value = await response.json();
        if (value.csrf) csrf = value.csrf;
        return { status: response.status, value, headers: response.headers };
      },
    };
  }
  const a = client(),
    b = client();
  for (const [c, email] of [
    [a, first.email],
    [b, second.email],
  ] as const)
    assert.equal(
      (await c.request('/admin/cloud/login', { email, password: 'correct account password' }))
        .status,
      200,
    );
  const enable = async () =>
    assert.equal(
      (
        await a.request('/admin/device-access', {
          action: 'enable',
          accountPassword: 'correct account password',
          devicePassword: 'trusted device passphrase',
        })
      ).status,
      200,
    );
  return {
    db,
    a,
    b,
    provider,
    first,
    enable,
    setFailure: (value: number) => {
      failure = value;
    },
    advance: (milliseconds = 16000) => {
      now += milliseconds;
    },
    get calls() {
      return calls;
    },
  };
}

test('manual offline and automatic reconnection retain the same cookie, identity, preferences and records', async (t) => {
  const f = await fixture(t);
  await f.enable();
  const owner = (await f.a.request('/auth')).value.adminId;
  assert.equal(
    (await f.a.request('/assessments', { ...input(), accessMode: 'accounts', candidates: [] }))
      .status,
    201,
  );
  const cookie = f.a.cookie,
    calls = f.calls;
  const switched = await f.a.request('/workspace/connection', { mode: 'offline' });
  assert.equal(switched.status, 200);
  assert.equal(switched.headers.get('set-cookie'), null);
  assert.equal(f.a.cookie, cookie);
  assert.equal(f.calls, calls);
  f.setFailure(503);
  const records = await f.a.request('/assessments');
  assert.equal(records.status, 200);
  assert.equal(records.value.assessments.length, 1);
  const auth = (await f.a.request('/auth')).value;
  assert.equal(auth.adminId, owner);
  assert.equal(auth.cloudSignedIn, false);
  assert.equal((await f.a.request('/account/profile')).value.emailVerified, true);
  assert.equal((await f.a.request('/account/profile', { name: 'Offline change' })).status, 409);
  assert.equal((await f.a.request('/online/assessments')).status, 409);
  const prefs = { textSize: 'large', reducedMotion: 'reduce', notificationBadge: false };
  assert.equal((await f.a.request('/account/preferences', prefs)).status, 200);
  assert.deepEqual((await f.a.request('/account/preferences')).value, prefs);
  const auto = await f.a.request('/workspace/connection', { mode: 'auto' });
  assert.equal(auto.value.state, 'offline');
  assert.equal(auto.value.mode, 'auto');
  f.setFailure(0);
  f.advance();
  assert.equal((await f.a.request('/workspace/connection')).value.state, 'online');
  assert.equal((await f.a.request('/auth')).value.adminId, owner);
  assert.equal(f.a.cookie, cookie);
  assert.equal((await f.a.request('/account/profile', { name: 'Renamed Person' })).status, 200);
  assert.equal((await f.a.request('/auth')).value.name, 'Renamed Person');
  assert.equal((await f.a.request('/assessments')).value.assessments.length, 1);
});

test('automatic fallback requires a trusted grant and never accepts provider revocation', async (t) => {
  const f = await fixture(t);
  f.setFailure(503);
  assert.equal(
    (await f.a.request('/assessments', { ...input(), accessMode: 'accounts', candidates: [] }))
      .status,
    503,
  );
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM assessments').get()!.n, 0);
  f.setFailure(0);
  await f.a.request('/workspace/connection');
  await f.enable();
  f.setFailure(503);
  assert.equal((await f.a.request('/assessments')).status, 200);
  assert.equal((await f.a.request('/auth')).value.connection.state, 'offline');
  f.setFailure(401);
  f.advance();
  assert.equal((await f.a.request('/workspace/connection')).status, 401);
  assert.equal((await f.a.request('/auth')).value.role, null);
});

test('preferences, profiles, diagnostics and session controls are owner scoped and CSRF protected', async (t) => {
  const f = await fixture(t);
  const prefs = { textSize: 'large', reducedMotion: 'reduce', notificationBadge: false };
  assert.equal(
    (await f.a.request('/account/preferences', prefs, { 'X-CSRF-Token': 'wrong' })).status,
    403,
  );
  assert.equal(
    (await f.a.request('/account/preferences', { ...prefs, textSize: 'invalid' })).status,
    400,
  );
  assert.equal(
    (
      await f.a.request('/account/preferences', {
        ...prefs,
        principalId: (await f.b.request('/auth')).value.adminId,
      })
    ).status,
    200,
  );
  assert.equal((await f.b.request('/account/preferences')).value.textSize, 'normal');
  assert.equal((await f.b.request('/account/profile')).value.name, 'Two');
  const report = await f.a.request('/account/diagnostics');
  assert.equal(report.status, 200);
  assert.match(report.headers.get('content-disposition')!, /attachment/);
  assert.doesNotMatch(
    JSON.stringify(report.value),
    /one@example|test-access|test-refresh|password|principal|token_hash/,
  );
  const store = new ExamStore(f.db),
    owner = (await f.a.request('/auth')).value.adminId;
  const other = store.createSession('admin', owner, null);
  assert.equal(
    (await f.a.request('/account/sessions', { password: 'wrong password' })).status,
    401,
  );
  assert.ok(store.session(other.raw));
  assert.equal(
    (await f.a.request('/account/sessions', { password: 'correct account password' })).status,
    200,
  );
  assert.equal(store.session(other.raw), undefined);
  assert.equal((await f.a.request('/auth')).value.role, 'admin');
  assert.equal((await f.b.request('/auth')).value.role, 'admin');
});

test('a late online check cannot override a newer manual offline choice', async () => {
  const db = openDatabase(':memory:');
  try {
    let release!: () => void, reached!: () => void;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const identity: CloudSession = {
      userId: randomUUID(),
      email: 'race@example.test',
      name: 'Race',
      accessToken: 'test',
      refreshToken: 'test',
      expiresAt: Date.now() + 3600000,
    };
    const provider: CloudAuthProvider = {
      signIn: async () => identity,
      signUp: async () => ({ pending: true }),
      verify: async (value) => {
        reached();
        await pending;
        return value;
      },
    };
    const store = new ExamStore(db),
      cloud = new CloudAdministrators(store, provider, randomBytes(32));
    const session = cloud.open(identity),
      actor = store.session(session.raw)!.principal_id;
    db.prepare('INSERT INTO admin_device_access VALUES(?,?,?)').run(
      actor,
      await hashPassword('trusted device passphrase'),
      Date.now(),
    );
    const connection = new WorkspaceConnection(store, cloud);
    const check = connection.verify(session.raw, true);
    await waiting;
    await connection.change(session.raw, 'offline', true);
    release();
    assert.equal(await check, false);
    assert.equal(connection.status(session.raw).mode, 'offline');
    await assert.rejects(cloud.credentials(actor), /paused/);
  } finally {
    db.close();
  }
});

test('active trusted Host sessions renew without expiring email verification; expired sessions cannot revive', async (t) => {
  const f = await fixture(t);
  await f.enable();
  const owner = (await f.a.request('/auth')).value.adminId;
  f.advance(7 * 3600000);
  assert.equal((await f.a.request('/auth')).value.adminId, owner);
  f.advance(7 * 3600000);
  assert.equal((await f.a.request('/auth')).value.adminId, owner);
  assert.equal((await f.a.request('/account/profile')).value.emailVerified, true);
  assert.equal((await f.b.request('/auth')).value.role, null);
  f.advance(13 * 3600000);
  assert.equal((await f.a.request('/auth')).value.role, null);
});

test('candidate Profile and Settings preserve organiser identity and cannot acquire administrator controls', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.a.request('/candidate/cloud/login', {
        email: f.first.email,
        password: 'correct account password',
      })
    ).status,
    200,
  );
  const before = (await f.a.request('/account/profile')).value;
  assert.equal(before.role, 'candidate');
  assert.equal(before.emailVerified, true);
  assert.equal(before.hostOperator, false);
  assert.equal((await f.a.request('/workspace/connection', { mode: 'offline' })).status, 403);
  assert.equal((await f.a.request('/admin/device-access', { action: 'enable' })).status, 403);
  assert.equal(
    (
      await f.a.request('/account/profile', {
        name: 'Candidate Name',
        identifier: 'spoofed',
        email: 'spoofed@example.test',
      })
    ).status,
    200,
  );
  const after = (await f.a.request('/account/profile')).value;
  assert.equal(after.name, 'Candidate Name');
  assert.equal(after.email, before.email);
  assert.equal(after.candidate.identifier, before.candidate.identifier);
  assert.equal(after.candidate.identityStatus, before.candidate.identityStatus);
  const prefs = { textSize: 'large', reducedMotion: 'reduce', notificationBadge: false };
  assert.equal((await f.a.request('/account/preferences', prefs)).status, 200);
  assert.equal((await f.a.request('/auth')).value.preferences.textSize, 'large');
  assert.equal((await f.b.request('/auth')).value.preferences.textSize, 'normal');
});

test('profile updates retain rotated credentials and reject a different provider identity', async (t) => {
  const f = await fixture(t);
  f.provider.updateName = async (session, name) => ({
    ...session,
    name,
    accessToken: 'rotated-secret-access',
    refreshToken: 'rotated-secret-refresh',
  });
  assert.equal((await f.a.request('/account/profile', { name: 'Updated Name' })).status, 200);
  assert.equal((await f.a.request('/account/profile')).value.name, 'Updated Name');
  const stored = JSON.stringify(f.db.prepare('SELECT access_token FROM provider_sessions').all());
  assert.ok(!stored.includes('rotated-secret'));
  f.provider.verify = async (session) => {
    assert.equal(session.accessToken, 'rotated-secret-access');
    return session;
  };
  assert.equal((await f.a.request('/assessments')).status, 200);
  f.provider.updateName = async (session, name) => ({ ...session, name, userId: randomUUID() });
  assert.equal((await f.a.request('/account/profile', { name: 'Wrong Identity' })).status, 401);
  assert.equal(
    f.db.prepare('SELECT name FROM administrators WHERE name=?').get('Wrong Identity'),
    undefined,
  );
});
