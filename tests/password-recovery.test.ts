import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../apps/host/database.ts';
import { ExamStore } from '../apps/host/store.ts';
import { CloudAdministrators } from '../apps/host/cloud-administrators.ts';
import { CloudCandidates } from '../apps/host/cloud-candidates.ts';
import { PasswordRecovery } from '../apps/host/password-recovery.ts';
import { createHandler } from '../apps/host/http.ts';
import { SupabaseAuth } from '../apps/host/supabase-auth.ts';
import type { CloudAuthProvider, CloudSession } from '../apps/host/supabase-auth.ts';
import { DomainError } from '../packages/exam-core/model.ts';
import { digest } from '../apps/host/security.ts';
import { assessment } from './fixtures.ts';
import { IdentityService } from '../apps/host/identity.ts';

test('v17 upgrade and database restarts preserve encrypted grants, completion receipts and existing records', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mudu-recovery-'));
  const path = join(directory, 'host.sqlite');
  let db = openDatabase(path);
  t.after(() => {
    db.close();
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  });
  db.prepare('INSERT INTO administrators VALUES(?,?,?,1)').run('host', 'Host', 'original-password');
  db.exec(
    'DROP TABLE workspace_connections; DROP TABLE account_preferences; DROP TABLE admin_device_sessions; DROP TABLE admin_device_access; DROP TABLE password_recovery; PRAGMA user_version=17;',
  );
  db.close();
  db = openDatabase(path);
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 21);
  assert.ok(existsSync(path + '.before-v18'));
  const key = randomBytes(32),
    userId = randomUUID();
  let updates = 0;
  const provider: CloudAuthProvider = {
    signIn: async () => {
      throw new Error('unused');
    },
    signUp: async () => ({ pending: true }),
    verify: async (s) => s,
    verifyRecovery: async () => ({
      userId,
      email: 'person@example.test',
      name: 'Person',
      accessToken: 'private-access',
      refreshToken: 'private-refresh',
      expiresAt: Date.now() + 3600000,
    }),
    resetPassword: async () => {
      updates++;
    },
  };
  const opened = await new PasswordRecovery(new ExamStore(db), provider, key).open(
    'valid-proof-for-recovery',
  );
  db.close();
  db = openDatabase(path);
  const restored = new PasswordRecovery(new ExamStore(db), provider, key);
  assert.equal(restored.state(opened.raw).csrf, opened.csrf);
  await restored.complete(opened.raw, opened.csrf, 'new passphrase');
  db.close();
  db = openDatabase(path);
  await new PasswordRecovery(new ExamStore(db), provider, key).complete(
    opened.raw,
    opened.csrf,
    'new passphrase',
  );
  assert.equal(updates, 1);
  assert.equal(
    db.prepare('SELECT password_hash FROM administrators WHERE id=?').get('host')!.password_hash,
    'original-password',
  );
});

test('a connected candidate reset preserves the original local identity and its separate password', async (t) => {
  const f = await fixture(t),
    identity = new IdentityService(f.store);
  const original = identity.createAccount({
    email: f.identity.email,
    name: 'Original candidate',
    identifier: 'STUDENT-001',
    hash: 'original-local-verifier',
  });
  const id = f.store.session(original.raw)!.account_id!;
  const connected = new CloudCandidates(f.store, f.key).open(f.identity, id);
  const before = JSON.stringify(identity.profile(id));
  const grant = await new PasswordRecovery(f.store, f.provider, f.key).open(
    'valid-proof-for-recovery',
  );
  await new PasswordRecovery(f.store, f.provider, f.key).complete(
    grant.raw,
    grant.csrf,
    '  new exact passphrase  ',
  );
  assert.equal(JSON.stringify(identity.profile(id)), before);
  assert.equal(
    f.db.prepare('SELECT password_hash FROM accounts WHERE id=?').get(id)!.password_hash,
    'original-local-verifier',
  );
  assert.equal(f.store.session(connected.raw), undefined);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM accounts').get()!.n, 1);
});

async function fixture(
  t: TestContext,
  options: { candidateListener?: boolean; identityMode?: 'replica'; secure?: boolean } = {},
) {
  const db = openDatabase(':memory:'),
    key = randomBytes(32);
  let now = Date.now(),
    updates = 0;
  const identity: CloudSession = {
    userId: randomUUID(),
    email: 'person@example.test',
    name: 'Person',
    accessToken: 'private-access',
    refreshToken: 'private-refresh',
    expiresAt: now + 3600000,
  };
  const proofs = new Set(['valid-proof-for-recovery']);
  const requests: Array<{ email: string; redirect: string }> = [];
  let updateFailure: DomainError | undefined;
  let updating: (() => Promise<void>) | undefined;
  const provider: CloudAuthProvider = {
    signIn: async () => identity,
    signUp: async () => ({ pending: true }),
    verify: async () => {
      throw new DomainError('Old provider session revoked', 401);
    },
    requestRecovery: async (email, redirect) => {
      requests.push({ email, redirect });
    },
    verifyRecovery: async (proof) => {
      if (!proofs.delete(proof)) throw new DomainError('Expired link', 401, 'RECOVERY_EXPIRED');
      return identity;
    },
    resetPassword: async (value, password) => {
      assert.equal(value.userId, identity.userId);
      assert.equal(password, '  new exact passphrase  ');
      updates++;
      await updating?.();
      if (updateFailure) throw updateFailure;
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
      now: () => now,
      ...options,
    }),
  );
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  const jar = new Map<string, string>();
  async function request(
    path: string,
    method = 'GET',
    data?: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(base + '/api' + path, {
      method,
      headers: {
        Origin: base,
        Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        'Content-Type': 'application/json',
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return { response, status: response.status, value: await response.json() };
  }
  const store = new ExamStore(db, () => now);
  return {
    db,
    key,
    store,
    provider,
    identity,
    proofs,
    requests,
    request,
    base,
    jar,
    advance: (ms: number) => {
      now += ms;
    },
    updates: () => updates,
    fail: (error?: DomainError) => {
      updateFailure = error;
    },
    waitUpdate: (fn: () => Promise<void>) => {
      updating = fn;
    },
  };
}

test('recovery requests are neutral for known/unknown accounts and use only configured redirects', async (t) => {
  const f = await fixture(t);
  const known = await f.request('/password-recovery/request', 'POST', {
    email: ' Person@Example.Test ',
    role: 'candidate',
    redirectTo: 'https://attacker.test',
  });
  const unknown = await f.request('/password-recovery/request', 'POST', {
    email: 'unknown@example.test',
    role: 'admin',
  });
  assert.equal(known.status, 200);
  assert.deepEqual(known.value, unknown.value);
  assert.deepEqual(f.requests, [
    { email: 'person@example.test', redirect: f.base + '/account/recovery?role=candidate' },
    { email: 'unknown@example.test', redirect: f.base + '/account/recovery?role=admin' },
  ]);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sessions').get()!.n, 0);
  assert.equal(
    (await f.request('/password-recovery/request', 'POST', { email: 'bad' })).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        '/password-recovery/request',
        'POST',
        { email: 'person@example.test' },
        { Origin: 'https://attacker.test' },
      )
    ).status,
    403,
  );
});

test('recovery is rate limited per address, across candidate and administrator entry points', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++)
    assert.equal(
      (
        await f.request('/password-recovery/request', 'POST', {
          email: 'person@example.test',
          role: i % 2 ? 'admin' : 'candidate',
        })
      ).status,
      200,
    );
  assert.equal(
    (await f.request('/password-recovery/request', 'POST', { email: 'PERSON@example.test' }))
      .status,
    429,
  );
  assert.equal(f.requests.length, 3);
});

test('recovery proof grants only password reset, uses a protected cookie, and never exposes provider tokens', async (t) => {
  const f = await fixture(t, { secure: true });
  const result = await f.request('/password-recovery/verify', 'POST', {
    tokenHash: 'valid-proof-for-recovery',
  });
  assert.equal(result.status, 200);
  assert.match(
    result.response.headers.get('set-cookie')!,
    /HttpOnly; SameSite=Strict; Max-Age=600; Secure/,
  );
  assert.doesNotMatch(JSON.stringify(result.value), /private-access|private-refresh|userId/);
  const row = f.db.prepare('SELECT * FROM password_recovery').get()!;
  assert.doesNotMatch(String(row.encrypted_session), /private-access|private-refresh/);
  assert.equal(row.token_hash, digest(f.jar.get('mudu_recovery')!));
  assert.equal((await f.request('/auth')).value.role, null);
  assert.equal((await f.request('/assessments')).status, 401);
  assert.equal(
    (
      await f.request('/password-recovery/complete', 'POST', {
        password: '  new exact passphrase  ',
      })
    ).status,
    403,
  );
  assert.equal(f.updates(), 0);
  assert.equal(
    (
      await f.request('/password-recovery/verify', 'POST', {
        tokenHash: 'valid-proof-for-recovery',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request(
        '/password-recovery/verify',
        'POST',
        { tokenHash: 'valid-proof-for-recovery' },
        { Cookie: '' },
      )
    ).value.code,
    'RECOVERY_EXPIRED',
  );
});

test('successful reset revokes both roles by provider identity, preserves records/local passwords and replays completion safely', async (t) => {
  const f = await fixture(t);
  f.db
    .prepare('INSERT INTO administrators VALUES(?,?,?,1)')
    .run('local-admin', 'Host', 'local-verifier');
  const admin = new CloudAdministrators(f.store, f.provider, f.key).open(f.identity, 'local-admin');
  const candidate = new CloudCandidates(f.store, f.key).open(f.identity);
  const unrelated = f.store.createSession('admin', 'unrelated-user', null);
  const exam = assessment();
  f.store.createAssessment(exam, [], 'local-admin');
  // Expired provider sessions must not prevent the public recovery endpoints working.
  f.jar.set('mudu_session', admin.raw);
  const verified = await f.request('/password-recovery/verify', 'POST', {
    tokenHash: 'valid-proof-for-recovery',
  });
  assert.equal(verified.status, 200);
  assert.equal(
    (
      await f.request(
        '/password-recovery/complete',
        'POST',
        { password: 'short' },
        { 'X-CSRF-Token': verified.value.csrf },
      )
    ).status,
    400,
  );
  const complete = () =>
    f.request(
      '/password-recovery/complete',
      'POST',
      { password: '  new exact passphrase  ' },
      { 'X-CSRF-Token': verified.value.csrf },
    );
  assert.equal((await complete()).status, 200);
  assert.equal((await complete()).status, 200);
  assert.equal(f.updates(), 1);
  assert.equal(f.store.session(admin.raw), undefined);
  assert.equal(f.store.session(candidate.raw), undefined);
  assert.ok(f.store.session(unrelated.raw));
  assert.equal(
    f.db.prepare('SELECT password_hash FROM administrators WHERE id=?').get('local-admin')!
      .password_hash,
    'local-verifier',
  );
  assert.ok(f.db.prepare('SELECT 1 FROM assessments WHERE id=?').get(exam.id));
  assert.equal(
    f.db.prepare('SELECT encrypted_session FROM password_recovery').get()!.encrypted_session,
    '',
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='cloud_password_reset'").get()!.n,
    1,
  );
  assert.equal((await f.request('/password-recovery/state')).value.completed, true);
});

test('expiry blocks updates and a new verified proof invalidates the previous recovery grant', async (t) => {
  const f = await fixture(t);
  const first = await f.request('/password-recovery/verify', 'POST', {
    tokenHash: 'valid-proof-for-recovery',
  });
  const oldCookie = f.jar.get('mudu_recovery')!;
  f.proofs.add('another-valid-recovery-proof');
  assert.equal(
    (
      await f.request('/password-recovery/verify', 'POST', {
        tokenHash: 'another-valid-recovery-proof',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request(
        '/password-recovery/complete',
        'POST',
        { password: '  new exact passphrase  ' },
        { Cookie: `mudu_recovery=${oldCookie}`, 'X-CSRF-Token': first.value.csrf },
      )
    ).status,
    401,
  );
  f.advance(10 * 60000);
  assert.equal((await f.request('/password-recovery/state')).value.code, 'RECOVERY_EXPIRED');
  assert.equal(f.updates(), 0);
});

test('concurrent changes across handler instances are claimed once; interrupted changes cannot silently replay', async (t) => {
  const f = await fixture(t);
  const oldSession = new CloudAdministrators(f.store, f.provider, f.key).open(f.identity);
  const first = new PasswordRecovery(f.store, f.provider, f.key),
    second = new PasswordRecovery(f.store, f.provider, f.key);
  const grant = await first.open('valid-proof-for-recovery');
  let release!: () => void;
  f.waitUpdate(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const pending = first.complete(grant.raw, grant.csrf, '  new exact passphrase  ');
  assert.equal(
    f.store.session(oldSession.raw),
    undefined,
    'old sessions must be revoked before the provider responds',
  );
  await assert.rejects(
    second.complete(grant.raw, grant.csrf, '  new exact passphrase  '),
    /in progress|interrupted/,
  );
  release();
  await pending;
  await second.complete(grant.raw, grant.csrf, '  new exact passphrase  ');
  assert.equal(f.updates(), 1);
});

test('known password rejection allows retry; uncertain provider failures require sign-in or a new link', async (t) => {
  const f = await fixture(t),
    service = new PasswordRecovery(f.store, f.provider, f.key);
  const grant = await service.open('valid-proof-for-recovery');
  f.fail(new DomainError('Choose a stronger password.', 400));
  await assert.rejects(
    service.complete(grant.raw, grant.csrf, '  new exact passphrase  '),
    /stronger/,
  );
  assert.equal(service.state(grant.raw).completed, 0);
  f.fail(new DomainError('Could not confirm the change.', 503));
  await assert.rejects(
    service.complete(grant.raw, grant.csrf, '  new exact passphrase  '),
    /confirm/,
  );
  await assert.rejects(
    service.complete(grant.raw, grant.csrf, '  new exact passphrase  '),
    /interrupted/,
  );
  assert.equal(f.updates(), 2);
});

test('offline candidate listeners and replicas reject recovery without contacting the provider', async (t) => {
  for (const options of [{ candidateListener: true }, { identityMode: 'replica' as const }]) {
    const f = await fixture(t, options);
    assert.equal(
      (await f.request('/password-recovery/request', 'POST', { email: 'person@example.test' }))
        .status,
      503,
    );
    assert.equal(f.requests.length, 0);
  }
});

test('Supabase adapter verifies only recovery OTPs and keeps password updates bound to the verified identity', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const id = randomUUID(),
    expiry = Math.floor(Date.now() / 1000) + 3600;
  const jwt = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: id, exp: expiry })).toString('base64url')}.${Buffer.alloc(32).toString('base64url')}`;
  const user = {
    id,
    email: 'person@example.test',
    email_confirmed_at: new Date().toISOString(),
    user_metadata: {},
  };
  const calls: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, options) => {
    const path = new URL(String(input)).pathname;
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    calls.push({ path, method: options?.method ?? 'GET', body });
    if (path.endsWith('/verify'))
      return Response.json({
        access_token: jwt,
        refresh_token: 'private-refresh',
        expires_at: expiry,
        expires_in: 3600,
        token_type: 'bearer',
        user,
      });
    if (path.endsWith('/user')) return Response.json(user);
    return Response.json({});
  };
  const provider = new SupabaseAuth({
    url: 'https://test.supabase.co',
    key: 'sb_publishable_test',
  });
  await provider.requestRecovery('person@example.test', 'https://mudu.test/account/recovery');
  const identity = await provider.verifyRecovery('valid-proof-for-recovery');
  await provider.resetPassword(identity, '  new exact passphrase  ');
  assert.equal(calls.find((c) => c.path.endsWith('/verify'))!.body.type, 'recovery');
  assert.equal(
    calls.find((c) => c.path.endsWith('/user') && c.method === 'PUT')!.body.password,
    '  new exact passphrase  ',
  );
  assert.ok(calls.some((c) => c.path.endsWith('/logout')));
});
