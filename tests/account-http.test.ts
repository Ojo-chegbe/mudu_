import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { openDatabase } from '../apps/host/database.ts';
import { createHandler } from '../apps/host/http.ts';
import { input } from './fixtures.ts';

test('account registration, lecturer approval, multi-exam dashboard, and secure examination access', async (t) => {
  const db = openDatabase(':memory:');
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on('request', await createHandler(db, { origin: base }));
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
      override: Record<string, string> = {},
    ) => {
      const response = await fetch(`${base}/api${path}`, {
        method,
        headers: {
          Origin: base,
          Cookie: cookie,
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          ...override,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.headers.has('set-cookie'))
        cookie = response.headers.get('set-cookie')!.split(';')[0];
      const value = await response.json();
      if (value.csrf) csrf = value.csrf;
      return { status: response.status, value };
    };
  }
  const admin = client();
  const student = client();
  const outsider = client();
  await admin('/admin/setup', 'POST', { name: 'Lecturer', password: 'admin-testing-password' });
  const payload = {
    ...input(),
    creationRequestId: crypto.randomUUID(),
    accessMode: 'accounts',
    registrationPolicy: 'approval',
    candidates: [],
  };
  const created = await admin('/assessments', 'POST', payload);
  assert.equal(created.status, 201);
  const id = created.value.id;
  const retry = await admin('/assessments', 'POST', payload);
  assert.equal(retry.status, 200);
  assert.equal(retry.value.id, id);
  assert.equal(retry.value.recovered, true);
  assert.equal((await admin('/assessments')).value.assessments.length, 1);
  assert.equal((await outsider('/assessments', 'POST', payload)).status, 401);
  // A new HTTP handler (as after a Host restart) must use the persisted receipt.
  server.removeAllListeners('request');
  server.on('request', await createHandler(db, { origin: base }));
  assert.equal((await admin('/assessments', 'POST', payload)).value.id, id);
  const settings = (await admin(`/assessments/${id}/registration`)).value.settings;
  const join = `/registration/${settings.token}`;
  const publicInfo = await outsider(join);
  assert.equal(publicInfo.status, 200);
  assert.doesNotMatch(JSON.stringify(publicInfo.value), /correctOptionIds|password_hash/);
  const signup = await student('/candidate/account/signup', 'POST', {
    name: 'Student',
    email: 'student@example.test',
    identifier: 'MUD/001',
    password: 'a memorable testing phrase',
  });
  assert.equal(signup.status, 201);
  const reviewPath = `/assessments/${id}/review/${crypto.randomUUID()}`;
  assert.equal((await outsider(reviewPath)).status, 401);
  assert.equal((await student(reviewPath)).status, 403);
  assert.equal((await student(reviewPath, 'POST', { score: 5 })).status, 403);
  assert.equal((await admin(reviewPath, 'POST', {}, { 'X-CSRF-Token': 'invalid' })).status, 403);
  const accountId = (await student('/auth')).value.accountId;
  assert.ok(accountId);
  assert.equal((await student('/candidate/examinations')).value.examinations.length, 0);
  assert.equal((await student(join, 'POST', {}, { 'X-CSRF-Token': 'invalid' })).status, 403);
  assert.equal((await student(join, 'POST', {})).value.status, 'pending');
  const notifications = await admin('/notifications');
  assert.equal(notifications.value.unread, 1);
  const noticeId = notifications.value.items[0].id;
  assert.equal((await admin('/notifications')).value.items.length, 1);
  assert.equal((await outsider('/notifications')).status, 401);
  assert.equal((await student('/notifications')).value.items.length, 0);
  assert.equal((await student('/notifications', 'POST', { ids: [noticeId] })).status, 200);
  assert.equal((await admin('/notifications')).value.unread, 1);
  assert.equal(
    (await admin('/notifications', 'POST', { ids: [noticeId] }, { 'X-CSRF-Token': 'bad' })).status,
    403,
  );
  assert.equal((await admin('/notifications', 'POST', { ids: [noticeId] })).status, 200);
  assert.equal((await admin('/notifications')).value.unread, 0);
  assert.equal((await admin('/notifications', 'POST', { ids: [12] })).status, 400);
  assert.equal((await student(join, 'POST', {})).value.status, 'pending');
  assert.equal((await student('/candidate/examinations')).value.examinations.length, 1);
  assert.equal((await student(`/candidate/examinations/${id}/state`)).status, 403);
  const request = (await admin(`/assessments/${id}/registration`)).value.requests[0];
  assert.equal(
    (
      await student(`/assessments/${id}/registration/${request.id}`, 'POST', {
        decision: 'approved',
        identityVerified: true,
      })
    ).status,
    403,
  );
  assert.equal(
    (await admin(`/assessments/${id}/registration/${request.id}`, 'POST', { decision: 'approved' }))
      .status,
    200,
  );
  assert.equal(
    (
      await admin(`/assessments/${id}/registration/${request.id}`, 'POST', {
        decision: 'approved',
        identityVerified: true,
      })
    ).status,
    200,
  );
  await admin(`/assessments/${id}/registration`, 'POST', { open: false });
  assert.equal((await student(join)).value.registration.status, 'approved');
  assert.equal((await student(`/candidate/examinations/${id}/state`)).status, 409);
  assert.equal((await admin(`/assessments/${id}/launch`, 'POST', {})).status, 200);
  const started = await student(`/candidate/examinations/${id}/start`, 'POST', {});
  assert.equal(started.status, 200);
  assert.doesNotMatch(JSON.stringify(started.value), /correctOptionIds/);
  const question = started.value.attempt.questions[0];
  assert.equal(
    (
      await student(`/candidate/examinations/${id}/answers/${question.id}`, 'PUT', {
        value: [question.options[0].id],
        expectedRevision: 0,
        operationId: 'persistent-account-answer',
      })
    ).status,
    200,
  );
  assert.equal((await student('/candidate/state')).status, 409);
  const receipt = await student(`/candidate/examinations/${id}/submit`, 'POST', {});
  assert.equal(receipt.value.attempt.status, 'submitted');
  const second = await admin('/assessments', 'POST', {
    ...payload,
    title: 'Next assessment',
    creationRequestId: crypto.randomUUID(),
    candidates: [
      { identifier: (await student('/candidate/me')).value.identifier, name: 'Student' },
    ],
    registrationPolicy: 'roster',
  });
  assert.equal(second.status, 201);
  const dashboard = (await student('/candidate/examinations')).value.examinations;
  assert.equal(dashboard.length, 2);
  assert.equal(
    dashboard.find((exam: { assessmentId: string }) => exam.assessmentId === second.value.id)
      .registrationStatus,
    'approved',
  );
  assert.equal((await student('/auth')).value.accountId, accountId);
  const candidateNotices = (await student('/notifications')).value;
  assert.equal(candidateNotices.items.length, 2);
  assert.ok(
    candidateNotices.items.every((n: { title: string }) => n.title === 'Registration approved'),
  );
  assert.equal(
    (
      await outsider('/candidate/account/signup', 'POST', {
        name: 'Outsider',
        email: 'outsider@example.test',
        identifier: 'MUD/002',
        password: 'another testing phrase',
      })
    ).status,
    201,
  );
  assert.equal((await outsider(`/candidate/examinations/${id}/state`)).status, 403);
  assert.equal((await outsider(`/candidate/examinations/${id}/submit`, 'POST', {})).status, 403);
  assert.equal((await outsider('/candidate/examinations')).value.examinations.length, 0);
  const newDevice = client();
  assert.equal(
    (
      await newDevice('/candidate/account/login', 'POST', {
        login: 'student@example.test',
        password: 'a memorable testing phrase',
      })
    ).status,
    200,
  );
  assert.equal((await student('/candidate/examinations')).status, 401);
  assert.equal(
    (await newDevice(`/candidate/examinations/${id}/state`)).value.attempt.id,
    receipt.value.attempt.id,
  );
  assert.equal(
    (
      await newDevice('/candidate/account/login', 'POST', {
        login: 'student@example.test',
        password: ' a memorable testing phrase ',
      })
    ).status,
    401,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM accounts').get()?.count, 2);
  const rosterId = crypto.randomUUID();
  const rosterInput = {
    name: 'Reusable class',
    revision: 0,
    restricted: false,
    open: true,
    archived: false,
    entries: [],
  };
  assert.equal((await outsider('/rosters')).status, 403);
  assert.equal((await newDevice(`/rosters/${rosterId}`, 'POST', rosterInput)).status, 403);
  assert.equal(
    (await admin(`/rosters/${rosterId}`, 'POST', rosterInput, { 'X-CSRF-Token': 'bad' })).status,
    403,
  );
  const group = await admin(`/rosters/${rosterId}`, 'POST', rosterInput);
  assert.equal(group.status, 200);
  const rosterJoin = `/roster-join/${group.value.token}`;
  assert.equal((await newDevice(rosterJoin, 'POST', {})).value.status, 'pending');
  assert.equal(
    (await admin(`/rosters/${rosterId}/members/${accountId}`, 'POST', { decision: 'approved' }))
      .status,
    200,
  );
  const rosterExam = await admin('/assessments', 'POST', {
    ...payload,
    creationRequestId: crypto.randomUUID(),
    rosterId,
    rosterRevision: 2,
    candidates: [{ name: 'Forged', identifier: 'FORGED' }],
  });
  assert.equal(rosterExam.status, 201);
  const rosterDetail = (await admin(`/assessments/${rosterExam.value.id}`)).value;
  assert.equal(rosterDetail.roster.id, rosterId);
  assert.equal(rosterDetail.candidates.length, 1);
  assert.equal(
    rosterDetail.candidates[0].identifier,
    (await newDevice('/candidate/me')).value.identifier,
  );
  assert.equal(
    (await admin(`/assessments/${rosterExam.value.id}/registration`, 'POST', { open: true }))
      .status,
    409,
  );
  assert.equal((await newDevice(`/assessments/${rosterExam.value.id}/roster`)).status, 403);
  assert.equal((await newDevice('/candidate/rosters')).value.rosters.length, 1);
  assert.equal((await outsider('/candidate/rosters')).value.rosters.length, 0);
  assert.equal(
    (
      await admin('/assessments', 'POST', {
        ...payload,
        creationRequestId: crypto.randomUUID(),
        rosterId,
        rosterRevision: 1,
      })
    ).status,
    409,
  );
});

test('offline replica does not create a second account or accept a permanent account password', async (t) => {
  const db = openDatabase(':memory:');
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on('request', await createHandler(db, { origin: base, identityMode: 'replica' }));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  for (const action of ['signup', 'login']) {
    const response = await fetch(`${base}/api/candidate/account/${action}`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 409);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM accounts').get()?.count, 0);
});
