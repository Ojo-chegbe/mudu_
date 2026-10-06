import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../apps/host/database.ts';
import { createHandler } from '../apps/host/http.ts';
import { DomainError } from '../packages/exam-core/model.ts';
import type { CloudAuthProvider, CloudSession } from '../apps/host/supabase-auth.ts';
import { input } from './fixtures.ts';
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExamStore } from '../apps/host/store.ts';
import { hashPassword, digest } from '../apps/host/security.ts';

test('schema 19 backs up existing workspaces and retains device credentials and sessions through restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mudu-device-migration-'));
  const path = join(directory, 'host.sqlite');
  let db = openDatabase(path);
  try {
    db.prepare('INSERT INTO administrators VALUES(?,?,?,1)').run(
      'host',
      'Host',
      'unchanged-host-verifier',
    );
    db.exec(
      'DROP TABLE workspace_connections; DROP TABLE account_preferences; DROP TABLE admin_device_sessions; DROP TABLE admin_device_access; PRAGMA user_version=18;',
    );
    const previous = new ExamStore(db).createSession('admin', 'host', null);
    db.close();
    db = openDatabase(path);
    assert.ok(existsSync(path + '.before-v19'));
    assert.equal(
      db.prepare('SELECT password_hash FROM administrators').get()!.password_hash,
      'unchanged-host-verifier',
    );
    assert.equal(new ExamStore(db).session(previous.raw)!.principal_id, 'host');
    const hash = await hashPassword('offline device passphrase');
    db.prepare('INSERT INTO admin_device_access VALUES(?,?,?)').run('host', hash, Date.now());
    db.prepare('INSERT INTO admin_device_sessions VALUES(?,?)').run(digest(previous.raw), 'host');
    db.close();
    db = openDatabase(path);
    assert.equal(
      db.prepare('SELECT password_hash FROM admin_device_access').get()!.password_hash,
      hash,
    );
    assert.equal(
      db.prepare('SELECT administrator_id FROM admin_device_sessions').get()!.administrator_id,
      'host',
    );
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    db.close();
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  }
});

test('one online identity owns its automatic Host workspace and scoped offline device access', async (t) => {
  const db = openDatabase(':memory:');
  let outage = false;
  const identities = new Map<string, CloudSession>();
  for (const email of ['one@example.test', 'two@example.test'])
    identities.set(email, {
      userId: randomUUID(),
      email,
      name: email.split('@')[0],
      accessToken: 'test-access',
      refreshToken: 'test-refresh',
      expiresAt: Date.now() + 3600000,
    });
  const provider: CloudAuthProvider = {
    signUp: async () => ({ pending: true }),
    signIn: async (email, password) => {
      if (outage) throw new DomainError('Provider unavailable.', 503);
      if (password !== 'correct online password' || !identities.has(email))
        throw new DomainError('Incorrect account password.', 401);
      return identities.get(email)!;
    },
    verify: async (value) => {
      if (outage) throw new DomainError('Provider unavailable.', 503);
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
    return async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
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
      return { status: response.status, value };
    };
  }
  const online = client(),
    second = client(),
    offline = client(),
    unauthenticated = client();
  const login = { email: 'one@example.test', password: 'correct online password' };
  assert.equal((await online('/admin/cloud/login', login)).status, 200);
  const auth = (await online('/auth')).value;
  assert.equal(auth.cloudConnected, true);
  assert.equal(auth.hostOperator, true);
  assert.equal(auth.localConfigured, false);
  assert.equal(auth.deviceAccessEnabled, false);
  const owner = auth.adminId;
  const exam = await online('/assessments', { ...input(), accessMode: 'accounts', candidates: [] });
  assert.equal(exam.status, 201);
  assert.equal(
    (await second('/admin/cloud/login', { email: 'two@example.test', password: login.password }))
      .status,
    200,
  );
  assert.equal((await second('/auth')).value.hostOperator, false);
  const enable = {
    action: 'enable',
    accountPassword: login.password,
    devicePassword: 'my offline device passphrase',
  };
  assert.equal((await unauthenticated('/admin/device-access', enable)).status, 401);
  assert.equal(
    (await online('/admin/device-access', enable, { 'X-CSRF-Token': 'wrong' })).status,
    403,
  );
  assert.equal(
    (await online('/admin/device-access', { ...enable, accountPassword: 'wrong password' })).status,
    401,
  );
  assert.equal(
    (await online('/admin/device-access', { ...enable, devicePassword: 'short' })).status,
    400,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM admin_device_access').get()!.n, 0);
  assert.equal((await online('/admin/device-access', enable)).status, 200);
  const stored = String(
    db.prepare('SELECT password_hash FROM admin_device_access').get()!.password_hash,
  );
  assert.match(stored, /^scrypt:/);
  assert.notEqual(stored, enable.devicePassword);
  assert.equal((await online('/auth')).value.deviceAccessEnabled, true);
  // Device unlock creates a session for the existing principal without contacting the provider.
  outage = true;
  assert.equal(
    (
      await offline('/admin/device/login', {
        email: 'ONE@example.test',
        password: 'wrong device password',
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await offline('/admin/device/login', {
        email: 'ONE@example.test',
        password: enable.devicePassword,
      })
    ).status,
    200,
  );
  const unlocked = (await offline('/auth')).value;
  assert.equal(unlocked.adminId, owner);
  assert.equal(unlocked.cloudConnected, true);
  assert.equal(unlocked.cloudSignedIn, false);
  assert.equal(unlocked.deviceSignedIn, true);
  const records = await offline('/assessments');
  assert.equal(records.status, 200);
  assert.equal(records.value.assessments.length, 1);
  assert.equal((await offline('/admin/device-access', enable)).status, 401);
  outage = false;
  // Replacing device access revokes existing device sessions and keeps both accounts isolated.
  assert.equal(
    (
      await online('/admin/device-access', {
        ...enable,
        devicePassword: 'replacement device passphrase',
      })
    ).status,
    200,
  );
  assert.equal((await offline('/auth')).value.role, null);
  assert.equal(
    (await offline('/admin/device/login', { email: login.email, password: enable.devicePassword }))
      .status,
    401,
  );
  assert.equal(
    (
      await offline('/admin/device/login', {
        email: login.email,
        password: 'replacement device passphrase',
      })
    ).status,
    200,
  );
  assert.equal((await second('/auth')).value.deviceAccessEnabled, false);
  assert.equal(
    (await online('/admin/device-access', { action: 'disable', accountPassword: login.password }))
      .status,
    200,
  );
  assert.equal((await offline('/auth')).value.role, null);
  assert.equal((await online('/assessments')).value.assessments.length, 1);
  assert.equal((await online('/admin/cloud/login', login)).status, 200);
  assert.equal((await online('/auth')).value.adminId, owner);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM administrators').get()!.n, 2);
});

test('schema 20 upgrade preserves device grants and persists connection and account settings', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mudu-settings-migration-'));
  const path = join(directory, 'host.sqlite');
  let db = openDatabase(path);
  try {
    db.prepare('INSERT INTO administrators VALUES(?,?,?,1)').run(
      'host',
      'Host',
      'unchanged-verifier',
    );
    db.prepare('INSERT INTO admin_device_access VALUES(?,?,?)').run(
      'host',
      'unchanged-device-verifier',
      Date.now(),
    );
    const session = new ExamStore(db).createSession('admin', 'host', null);
    db.exec(
      'DROP TABLE workspace_connections; DROP TABLE account_preferences; PRAGMA user_version=19;',
    );
    db.close();
    db = openDatabase(path);
    assert.ok(existsSync(path + '.before-v20'));
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 20);
    assert.equal(
      db.prepare('SELECT offline_setup_completed FROM account_preferences').get()!
        .offline_setup_completed,
      1,
    );
    assert.equal(
      db.prepare('SELECT password_hash FROM admin_device_access').get()!.password_hash,
      'unchanged-device-verifier',
    );
    db.prepare('INSERT INTO workspace_connections VALUES(?,?,?,?)').run(
      digest(session.raw),
      'offline',
      'offline',
      Date.now(),
    );
    db.prepare("UPDATE account_preferences SET text_size='large'").run();
    db.close();
    db = openDatabase(path);
    assert.equal(new ExamStore(db).session(session.raw)!.principal_id, 'host');
    assert.equal(db.prepare('SELECT mode FROM workspace_connections').get()!.mode, 'offline');
    assert.equal(db.prepare('SELECT text_size FROM account_preferences').get()!.text_size, 'large');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    db.close();
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  }
});
