import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { openDatabase } from '../apps/host/database.ts';
import { createHandler } from '../apps/host/http.ts';
import { input } from './fixtures.ts';

test('individual timing HTTP boundaries, server authority and admission permissions', async (t) => {
  const db = openDatabase(':memory:');
  let now = Date.now();
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on('request', await createHandler(db, { origin: base, now: () => now }));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  function client() {
    let cookie = '';
    let csrf = '';
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
      return { status: response.status, value };
    };
  }
  const admin = client(),
    student = client(),
    stranger = client();
  await admin('/admin/setup', 'POST', {
    name: 'Administrator',
    password: 'admin-testing-password',
  });
  const timing = {
    mode: 'individual',
    opensAt: now + 60000,
    lastStartAt: now + 1200000,
    finishBy: null,
  };
  const created = await admin('/assessments', 'POST', {
    ...input(),
    candidates: [],
    accessMode: 'accounts',
    registrationPolicy: 'approval',
    timing,
  });
  assert.equal(created.status, 201);
  const id = created.value.id;
  const registration = (await admin(`/assessments/${id}/registration`)).value;
  assert.equal(
    (
      await student('/candidate/account/signup', 'POST', {
        name: 'Student',
        email: 'timing@example.test',
        identifier: '001',
        password: 'a memorable testing phrase',
      })
    ).status,
    201,
  );
  assert.equal(
    (await student(`/registration/${registration.settings.token}`, 'POST', {})).status,
    200,
  );
  const request = (await admin(`/assessments/${id}/registration`)).value.requests[0];
  assert.equal(
    (await admin(`/assessments/${id}/registration/${request.id}`, 'POST', { decision: 'approved' }))
      .status,
    200,
  );
  assert.equal((await admin(`/assessments/${id}/launch`, 'POST', {})).status, 200);
  const state = `/candidate/examinations/${id}/state`;
  const start = `/candidate/examinations/${id}/start`;
  const admission = `/assessments/${id}/admission`;
  const before = await student(state);
  assert.equal(before.value.attempt, null);
  assert.equal(before.value.sitting.startRestriction, 'not_open');
  assert.doesNotMatch(JSON.stringify(before.value), /correctOptionIds|password_hash/);
  assert.equal(
    (await student(start, 'POST', { startedAt: 0, deadline: Number.MAX_SAFE_INTEGER })).status,
    409,
  );
  now = timing.opensAt;
  const begun = await student(start, 'POST', { startedAt: 0, deadline: Number.MAX_SAFE_INTEGER });
  assert.equal(begun.status, 200);
  const active = (await student(state)).value;
  assert.equal(active.attempt.deadline, now + 60 * 60000);
  const policy = { allowLateAdmission: true, expectedAllowLateAdmission: false };
  assert.equal((await stranger(admission, 'POST', policy)).status, 401);
  assert.equal((await student(admission, 'POST', policy)).status, 403);
  assert.equal((await admin(admission, 'POST', policy, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal(
    (await admin(admission, 'POST', policy, { Origin: 'https://hostile.invalid' })).status,
    403,
  );
  assert.equal(
    (await admin(admission, 'POST', { ...policy, allowLateAdmission: 'true' })).status,
    400,
  );
  assert.equal((await admin(admission, 'POST', policy)).status, 200);
  assert.equal(
    (
      await admin(admission, 'POST', {
        allowLateAdmission: false,
        expectedAllowLateAdmission: true,
      })
    ).status,
    200,
  );
  now = timing.lastStartAt;
  assert.equal((await student(state)).value.attempt.status, 'active');
  assert.equal(
    (await student(`/candidate/examinations/${id}/heartbeat`, 'POST', {})).value.ended,
    false,
  );
  assert.equal((await admin(admission, 'POST', policy)).status, 409);
  const controlPath = `/assessments/${id}/controls`;
  const announcement = {
    action: 'announce',
    message: 'Please continue carefully.',
    operationId: crypto.randomUUID(),
    expectedRevision: 0,
  };
  assert.equal((await stranger(controlPath, 'POST', announcement)).status, 401);
  assert.equal((await student(controlPath, 'POST', announcement)).status, 403);
  assert.equal(
    (await admin(controlPath, 'POST', announcement, { 'X-CSRF-Token': 'wrong' })).status,
    403,
  );
  assert.equal(
    (await admin(controlPath, 'POST', announcement, { Origin: 'https://hostile.invalid' })).status,
    403,
  );
  assert.equal((await admin(controlPath, 'POST', announcement)).status, 200);
  assert.equal((await admin(controlPath, 'POST', announcement)).status, 200);
  const announcementId = (await student(state)).value.announcements[0].id;
  assert.equal(
    (
      await student(`/candidate/examinations/${id}/announcements/read`, 'POST', {
        id: announcementId,
        candidateId: 'spoofed',
      })
    ).status,
    200,
  );
  assert.equal((await student(state)).value.announcements[0].read, true);
  assert.equal(
    (
      await student(`/candidate/examinations/${id}/announcements/read`, 'POST', {
        id: crypto.randomUUID(),
      })
    ).status,
    404,
  );
  const pause = {
    action: 'pause',
    reason: 'Approved interruption',
    operationId: crypto.randomUUID(),
    expectedRevision: 1,
  };
  assert.equal((await admin(controlPath, 'POST', pause)).status, 200);
  now += 7200000;
  assert.equal((await student(state)).value.attempt.status, 'active');
  assert.equal((await student(`/candidate/examinations/${id}/submit`, 'POST', {})).status, 409);
  const force = {
    action: 'force_submit',
    reason: 'Approved early collection',
    candidateId: (await admin(`/assessments/${id}/monitor`)).value.candidates[0].id,
    operationId: crypto.randomUUID(),
    expectedRevision: 2,
  };
  assert.equal((await student(controlPath, 'POST', force)).status, 403);
  assert.equal((await admin(controlPath, 'POST', force)).status, 200);
  assert.equal((await student(state)).value.attempt.status, 'submitted');
  assert.equal((await admin(`/assessments/${id}/end`, 'POST', {})).status, 200);
  assert.equal((await student(state)).value.attempt.status, 'submitted');
  assert.equal((await admin(admission, 'POST', policy)).status, 409);
});
