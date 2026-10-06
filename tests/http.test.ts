import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { openDatabase } from '../apps/host/database.ts';
import { createHandler } from '../apps/host/http.ts';
import { input } from './fixtures.ts';

test('HTTP examination lifecycle, access boundaries, replay, grading, and export', async (t) => {
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
    return {
      async request(
        path: string,
        method = 'GET',
        body?: unknown,
        headers: Record<string, string> = {},
      ) {
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
        const newCookie = response.headers.get('set-cookie');
        if (newCookie) cookie = newCookie.split(';')[0];
        const value = await response.json();
        if (value.csrf) csrf = value.csrf;
        return { response, value };
      },
      getCookie: () => cookie,
    };
  }
  const admin = client();
  const candidate = client();
  const stranger = client();
  await t.test('unconfigured Host requires setup and rejects hostile origins', async () => {
    assert.equal((await stranger.request('/auth')).value.configured, false);
    assert.equal((await stranger.request('/assessments')).response.status, 401);
    assert.equal(
      (
        await stranger.request(
          '/admin/setup',
          'POST',
          { name: 'Tester', password: 'test-password-only' },
          { Origin: 'https://untrusted.invalid' },
        )
      ).response.status,
      403,
    );
    const setup = await admin.request('/admin/setup', 'POST', {
      name: 'Test Administrator',
      password: 'test-password-only',
    });
    assert.equal(setup.response.status, 201);
    assert.match(setup.response.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
    assert.equal(
      (
        await stranger.request('/admin/setup', 'POST', {
          name: 'Other',
          password: 'another-password',
        })
      ).response.status,
      409,
    );
  });
  let assessmentId = '';
  let code = '';
  let questionId = '';
  let correctId = '';
  await t.test('authoring requires CSRF and stores credential verifiers only', async () => {
    assert.equal(
      (await admin.request('/assessments', 'POST', input(), { 'X-CSRF-Token': 'wrong' })).response
        .status,
      403,
    );
    const created = await admin.request('/assessments', 'POST', input());
    assert.equal(created.response.status, 201);
    assessmentId = created.value.id;
    const row = db.prepare('SELECT credential_hash FROM candidates').get();
    assert.match(String(row?.credential_hash), /^scrypt:/);
    assert.notEqual(row?.credential_hash, input().candidates[0].credential);
    const detail = (await admin.request(`/assessments/${assessmentId}`)).value;
    questionId = detail.assessment.questions[0].id;
    correctId = detail.assessment.questions[0].correctOptionIds[0];
    assert.doesNotMatch(JSON.stringify(detail), /credential_hash|candidate-key-123/);
    const launched = await admin.request(`/assessments/${assessmentId}/launch`, 'POST', {});
    assert.equal(launched.response.status, 200);
    code = launched.value.code;
    assert.equal(
      (await admin.request(`/assessments/${assessmentId}/launch`, 'POST', {})).value.id,
      launched.value.id,
    );
  });
  await t.test(
    'candidate authentication denies admin data and exposes no answer keys',
    async () => {
      const invalid = await candidate.request('/candidate/login', 'POST', {
        code,
        identifier: 'MUD/001',
        credential: 'wrong-secret',
      });
      assert.equal(invalid.response.status, 401);
      const login = await candidate.request('/candidate/login', 'POST', {
        code,
        identifier: 'mud/001',
        credential: input().candidates[0].credential,
      });
      assert.equal(login.response.status, 200);
      assert.equal(
        (await candidate.request(`/assessments/${assessmentId}/monitor`)).response.status,
        403,
      );
      assert.equal(
        (await candidate.request('/candidate/heartbeat', 'POST', {}, { 'X-CSRF-Token': 'wrong' }))
          .response.status,
        403,
      );
      assert.equal(
        (await candidate.request('/candidate/heartbeat', 'POST', {})).response.status,
        200,
      );
      const monitor = (await admin.request(`/assessments/${assessmentId}/monitor`)).value;
      assert.equal(monitor.candidates[0].status, 'waiting');
      assert.ok(monitor.candidates[0].lastSeenAt);
      assert.doesNotMatch(JSON.stringify(monitor), /correctOptionIds|credential_hash|prompt/);
      assert.equal((await candidate.request('/assessments')).response.status, 403);
      assert.equal((await candidate.request('/candidate/state')).value.attempt, null);
      const start = await candidate.request('/candidate/start', 'POST', {});
      assert.equal(start.response.status, 200);
      assert.doesNotMatch(
        JSON.stringify(start.value),
        /correctOptionIds|correctIndices|credential_hash/,
      );
      assert.equal(start.value.attempt.questions.length, 2);
      assert.equal((await admin.request('/candidate/state')).response.status, 403);
    },
  );
  await t.test(
    'answers are durable, stale updates are rejected, and submission freezes grading',
    async () => {
      const answer = {
        value: [correctId],
        expectedRevision: 0,
        operationId: 'http-save-operation-1',
      };
      const saved = await candidate.request(`/candidate/answers/${questionId}`, 'PUT', answer);
      assert.equal(saved.response.status, 200);
      assert.equal(saved.value.revision, 1);
      assert.deepEqual(
        (await candidate.request(`/candidate/answers/${questionId}`, 'PUT', answer)).value,
        saved.value,
      );
      assert.equal(
        (
          await candidate.request(`/candidate/answers/${questionId}`, 'PUT', {
            ...answer,
            operationId: 'stale-operation',
          })
        ).response.status,
        409,
      );
      const submitted = await candidate.request('/candidate/submit', 'POST', {});
      assert.equal(submitted.value.attempt.status, 'submitted');
      assert.equal(submitted.value.attempt.questions.length, 0);
      assert.equal(
        (
          await candidate.request(`/candidate/answers/${questionId}`, 'PUT', {
            value: [],
            expectedRevision: 1,
            operationId: 'after-submission',
          })
        ).response.status,
        409,
      );
      const detail = (await admin.request(`/assessments/${assessmentId}`)).value;
      assert.equal(detail.candidates[0].grade.objectiveScore, 2);
      assert.equal(detail.candidates[0].grade.percentage, 40);
      const exported = await fetch(base + `/api/assessments/${assessmentId}/results.csv`, {
        headers: { Cookie: admin.getCookie() },
      });
      assert.equal(exported.status, 200);
      assert.match(
        exported.headers.get('content-disposition') ?? '',
        /filename="Foundations assessment - results\.csv"/,
      );
      assert.match(await exported.text(), /MUD\/001/);
      await admin.request(`/assessments/${assessmentId}/end`, 'POST', {});
      assert.equal(
        (await admin.request(`/assessments/${assessmentId}`)).value.summary.status,
        'completed',
      );
    },
  );
  await t.test(
    'device recovery revokes the old session, restores submission, and logout revokes access',
    async () => {
      const replacement = client();
      await replacement.request('/candidate/login', 'POST', {
        code,
        identifier: 'MUD/001',
        credential: input().candidates[0].credential,
      });
      assert.equal((await candidate.request('/candidate/state')).response.status, 401);
      assert.equal(
        (await replacement.request('/candidate/state')).value.attempt.status,
        'submitted',
      );
      assert.equal((await replacement.request('/logout', 'POST', {})).response.status, 200);
      assert.equal((await replacement.request('/candidate/state')).response.status, 401);
    },
  );
});
