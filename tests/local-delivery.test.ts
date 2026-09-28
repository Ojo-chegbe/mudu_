import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  LocalDelivery,
  isPrivateIPv4,
  localAddresses,
  validateLocalConfiguration,
} from '../apps/host/local-delivery.ts';
import { browserId } from '../apps/web/browser-id.ts';
import { createHandler } from '../apps/host/http.ts';
import { openDatabase } from '../apps/host/database.ts';
import { ExamStore } from '../apps/host/store.ts';
import { assessment } from './fixtures.ts';

test('local delivery accepts only explicit consent and a currently assigned private IPv4 address', () => {
  const addresses = [{ name: 'Wi-Fi', address: '192.168.49.2' }];
  assert.equal(
    validateLocalConfiguration({ address: '192.168.49.2', acknowledged: true }, addresses).enabled,
    true,
  );
  for (const address of [
    '127.0.0.1',
    '0.0.0.0',
    '8.8.8.8',
    '169.254.1.2',
    '172.32.0.1',
    '192.168.001.2',
    '192.168.2.256',
    '::1',
    'localhost',
  ])
    assert.equal(isPrivateIPv4(address), false, address);
  for (const address of ['10.0.0.1', '172.16.1.1', '172.31.255.254', '192.168.49.2'])
    assert.equal(isPrivateIPv4(address), true);
  assert.throws(
    () => validateLocalConfiguration({ address: '192.168.49.2' }, addresses),
    /not encrypted/,
  );
  assert.throws(
    () => validateLocalConfiguration({ address: '192.168.49.3', acknowledged: true }, addresses),
    /no longer available/,
  );
});

test('browser operation IDs work without secure-context randomUUID', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const random = crypto.getRandomValues.bind(crypto);
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues: random },
  });
  try {
    const ids = new Set(Array.from({ length: 1000 }, browserId));
    assert.equal(ids.size, 1000);
    for (const id of ids)
      assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
  }
});

test('HTTP local service starts, persists consent, restores, detects network change and stays stopped', async (t) => {
  const address = localAddresses()[0];
  if (!address) {
    t.skip('No private network interface on this test machine');
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), 'mudu-lan-test-'));
  let available = [address];
  const make = () =>
    new LocalDelivery(
      directory,
      async () => (_request, response) => response.end('local'),
      () => available,
      0,
    );
  const service = make();
  t.after(() => service.close());
  await service.configure({ address: address.address, acknowledged: true });
  assert.equal(await (await fetch(service.status().origin!)).text(), 'local');
  assert.equal(
    JSON.parse(readFileSync(join(directory, 'local-delivery.json'), 'utf8')).acknowledged,
    true,
  );
  await assert.rejects(
    service.configure({ address: address.address, acknowledged: true }),
    /Stop local delivery/,
  );
  service.connection(address.address);
  assert.equal(service.status().checkedDevices, 0, 'Host itself is not a device check');
  service.connection('10.254.254.254');
  assert.equal(service.status().checkedDevices, 1);
  available = [];
  assert.equal(service.status().origin, null);
  assert.match(service.status().error!, /network changed/);
  available = [address];
  await service.close();
  const restored = make();
  t.after(() => restored.close());
  await restored.restore();
  assert.equal(restored.status().running, true);
  await restored.stop();
  const stopped = make();
  t.after(() => stopped.close());
  await stopped.restore();
  assert.equal(stopped.status().running, false);
});

test('local management requires administrator authentication and CSRF; no fake loopback connection proof', async (t) => {
  const db = openDatabase(':memory:');
  const local = new LocalDelivery(
    mkdtempSync(join(tmpdir(), 'mudu-local-api-')),
    async () => (_req, res) => res.end(),
  );
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on(
    'request',
    await createHandler(db, { origin, localDelivery: local, candidateListener: true }),
  );
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  assert.equal((await fetch(origin + '/api/local-delivery')).status, 401);
  const setup = await fetch(origin + '/api/admin/setup', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test admin', password: 'test-password-only' }),
  });
  const cookie = setup.headers.get('set-cookie')!.split(';')[0];
  const { csrf } = await setup.json();
  const request = (path: string, token = csrf) =>
    fetch(origin + '/api' + path, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: origin,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
      },
      body: '{}',
    });
  assert.equal(
    (await fetch(origin + '/api/local-delivery', { headers: { Cookie: cookie } })).status,
    200,
  );
  assert.equal((await request('/local-delivery', 'bad')).status, 403);
  assert.equal((await request('/local-delivery')).status, 400);
  assert.equal((await request('/local-connection')).status, 409);
  assert.equal(
    (await request('/local-delivery/stop')).status,
    403,
    'candidate listener cannot stop itself',
  );
  assert.equal(
    (await (await fetch(origin + '/api/candidate-address', { headers: { Cookie: cookie } })).json())
      .origin,
    null,
  );
  const store = new ExamStore(db);
  const exam = assessment();
  store.createAssessment(
    exam,
    [{ id: 'candidate', identifier: '1', name: 'Test', hash: 'test' }],
    'admin',
  );
  store.launch(exam.id, 'admin');
  assert.equal(
    (await request('/local-delivery')).status,
    409,
    'active examination blocks configuration changes',
  );

  const address = localAddresses()[0];
  if (address) {
    const candidateServer = createServer();
    candidateServer.listen(0, address.address);
    await once(candidateServer, 'listening');
    const candidateOrigin = `http://${address.address}:${(candidateServer.address() as AddressInfo).port}`;
    candidateServer.on(
      'request',
      await createHandler(db, {
        origin: candidateOrigin,
        localDelivery: local,
        candidateListener: true,
      }),
    );
    t.after(async () => {
      candidateServer.closeAllConnections();
      await new Promise<void>((resolve) => candidateServer.close(() => resolve()));
    });
    assert.equal(
      (await fetch(candidateOrigin + '/api/local-delivery', { headers: { Cookie: cookie } }))
        .status,
      403,
      'even a valid admin cookie cannot administer through the LAN interface',
    );
    const login = await fetch(candidateOrigin + '/api/admin/login', {
      method: 'POST',
      headers: { Origin: candidateOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-password-only' }),
    });
    assert.equal(login.status, 403, 'administrator password login is loopback only');
  }
});
