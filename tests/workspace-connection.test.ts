import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { openDatabase } from '../apps/host/database.ts';
import { createHandler } from '../apps/host/http.ts';
import type { CloudAuthProvider, CloudSession } from '../apps/host/supabase-auth.ts';
import { DomainError } from '../packages/exam-core/model.ts';
import { input } from './fixtures.ts';
import { pendingConnection, rememberConnection } from '../apps/web/workspace-connection.ts';

for (const confirmationRequired of [true, false]) {
  test(`inline cloud signup preserves the local workspace (${confirmationRequired ? 'email confirmation required' : 'immediately confirmed'})`, async (t) => {
    const db = openDatabase(':memory:');
    const identity: CloudSession = {
      userId: randomUUID(),
      email: 'organizer@example.test',
      name: 'Organizer',
      accessToken: 'test-access',
      refreshToken: 'test-refresh',
      expiresAt: Date.now() + 3600000,
    };
    let signups = 0;
    let confirmed = !confirmationRequired;
    const provider: CloudAuthProvider = {
      signUp: async (email, password, name) => {
        signups++;
        assert.equal(email, identity.email);
        assert.equal(password, 'Cloud123');
        assert.equal(name, 'Organizer');
        return confirmationRequired ? { pending: true } : { pending: false, session: identity };
      },
      signIn: async (email, password) => {
        assert.equal(email, identity.email);
        assert.equal(password, 'Cloud123');
        if (!confirmed) throw new DomainError('Confirm your email before signing in.', 401);
        return identity;
      },
      verify: async (session) => session,
    };
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    server.on(
      'request',
      await createHandler(db, {
        origin: base,
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
        const value = await response.json();
        if (value.csrf) csrf = value.csrf;
        return { status: response.status, value, changedSession: Boolean(next) };
      };
    }
    const admin = client(),
      outsider = client();
    const credentials = {
      name: 'Organizer',
      email: identity.email,
      password: 'Cloud123',
      hostPassword: 'original local host password',
    };
    assert.equal(
      (
        await admin('/admin/setup', 'POST', {
          name: 'Organizer',
          password: credentials.hostPassword,
        })
      ).status,
      201,
    );
    const owner = (await admin('/auth')).value.adminId;
    const verifier = db
      .prepare('SELECT password_hash FROM administrators WHERE id=?')
      .get(owner)!.password_hash;
    const exam = (await admin('/assessments', 'POST', input())).value;
    assert.equal((await outsider('/admin/cloud/connect/signup', 'POST', credentials)).status, 401);
    assert.equal(
      (await admin('/admin/cloud/connect/signup', 'POST', credentials, { 'X-CSRF-Token': 'wrong' }))
        .status,
      403,
    );
    assert.equal(
      (
        await admin('/admin/cloud/connect/signup', 'POST', credentials, {
          Origin: 'https://evil.invalid',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await admin('/admin/cloud/connect/signup', 'POST', {
          ...credentials,
          hostPassword: 'wrong host password',
        })
      ).status,
      401,
    );
    assert.equal(
      (await admin('/admin/cloud/connect/signup', 'POST', { ...credentials, password: 'short' }))
        .status,
      400,
    );
    assert.equal(signups, 0, 'Rejected requests must not create remote accounts');
    const created = await admin('/admin/cloud/connect/signup', 'POST', credentials);
    assert.equal(created.status, confirmationRequired ? 202 : 201);
    assert.equal(signups, 1);
    if (confirmationRequired) {
      assert.equal(created.value.pending, true);
      assert.equal(created.changedSession, false);
      const pending = (await admin('/auth')).value;
      assert.equal(pending.adminId, owner);
      assert.equal(pending.role, 'admin');
      assert.equal(pending.cloudConnected, false);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM admin_provider_identities').get()!.n, 0);
      assert.equal((await admin('/assessments')).value.assessments.length, 1);
      assert.equal((await admin('/admin/cloud/connect', 'POST', credentials)).status, 401);
      assert.equal((await admin('/auth')).value.adminId, owner);
      confirmed = true;
      assert.equal((await admin('/admin/cloud/connect', 'POST', credentials)).status, 200);
    }
    const connected = (await admin('/auth')).value;
    assert.equal(connected.adminId, owner);
    assert.equal(connected.cloudConnected, true);
    assert.equal(connected.cloudSignedIn, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM administrators').get()!.n, 1);
    assert.equal(
      db.prepare('SELECT owner_id FROM assessment_owners WHERE assessment_id=?').get(exam.id)!
        .owner_id,
      owner,
    );
    assert.equal(
      db.prepare('SELECT password_hash FROM administrators WHERE id=?').get(owner)!.password_hash,
      verifier,
    );
    assert.equal((await admin('/admin/cloud/connect/signup', 'POST', credentials)).status, 409);
    assert.equal(signups, 1, 'Already connected workspaces must not create another cloud account');
    assert.equal(
      (await admin('/admin/login', 'POST', { password: credentials.hostPassword })).status,
      200,
    );
    assert.equal((await admin('/auth')).value.adminId, owner);
    assert.equal((await admin('/assessments')).value.assessments.length, 1);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  });
}

test('confirmation progress is isolated by workspace and contains no credentials', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  rememberConnection(storage, 'original', 'organizer@example.test');
  assert.equal(pendingConnection(storage, 'original'), 'organizer@example.test');
  assert.equal(pendingConnection(storage, 'other'), '');
  assert.deepEqual(JSON.parse([...values.values()][0]), {
    version: 1,
    email: 'organizer@example.test',
  });
  rememberConnection(storage, 'original', '');
  assert.equal(pendingConnection(storage, 'original'), '');
  values.set('mudu:cloud-connection:original', '{invalid');
  assert.equal(pendingConnection(storage, 'original'), '');
  values.set('mudu:cloud-connection:original', JSON.stringify({ version: 1, email: '<script>' }));
  assert.equal(pendingConnection(storage, 'original'), '');
  const blocked = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
    removeItem() {
      throw new Error('blocked');
    },
  };
  assert.equal(pendingConnection(blocked, 'original'), '');
  assert.doesNotThrow(() => rememberConnection(blocked, 'original', 'organizer@example.test'));
});
