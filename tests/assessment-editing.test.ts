import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../apps/host/database.ts';
import { ExamStore } from '../apps/host/store.ts';
import { AssessmentEditing } from '../apps/host/assessment-editing.ts';
import { IdentityService } from '../apps/host/identity.ts';
import { Rosters } from '../apps/host/rosters.ts';
import { assessment } from './fixtures.ts';
import { createHandler } from '../apps/host/http.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

function fixture(legacy = false) {
  const db = openDatabase(':memory:');
  let now = 1000000;
  const store = new ExamStore(db, () => now);
  const identity = new IdentityService(store);
  const editor = new AssessmentEditing(store);
  db.prepare('INSERT INTO administrators VALUES(?,?,?,1)').run('admin', 'Admin', 'test-only');
  const exam = assessment();
  store.createAssessment(
    exam,
    legacy ? [{ id: 'legacy', name: 'Legacy', identifier: 'L001', hash: 'old-secret-hash' }] : [],
    'admin',
    { mode: legacy ? 'legacy' : 'accounts', policy: 'approval', capacity: 500, closesAt: null },
  );
  let accountId = '';
  if (!legacy) {
    const session = identity.createAccount({
      email: 'candidate@example.test',
      name: 'Candidate',
      hash: 'password-hash',
    });
    accountId = store.session(session.raw)!.account_id!;
    identity.register(identity.settings(exam.id).token, accountId);
    identity.review(exam.id, identity.requests(exam.id)[0].id, 'approved', undefined, 'admin');
  }
  return {
    db,
    store,
    identity,
    editor,
    exam,
    accountId,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('reruns can use an owned roster snapshot instead of previous candidates, safely and idempotently', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const rosters = new Rosters(f.store);
  const roster = rosters.save(randomUUID(), 'admin', {
    name: 'New class',
    revision: 0,
    restricted: false,
    open: true,
    archived: false,
    entries: [],
  });
  const account = f.identity.createAccount({
    email: 'new@example.test',
    name: 'New candidate',
    hash: 'test',
  });
  const newId = f.store.session(account.raw)!.account_id!;
  rosters.join(roster.token, newId);
  rosters.review(roster.id, 'admin', newId, { decision: 'approved' });
  rosters.join(roster.token, f.accountId);
  f.store.launch(f.exam.id, 'admin');
  f.store.end(f.exam.id, 'admin');
  const previous = f.store.detail(f.exam.id);
  const request = {
    title: 'New class exam',
    includeCandidates: false,
    rosterId: roster.id,
    rosterRevision: rosters.get(roster.id, 'admin').revision,
    requestId: randomUUID(),
  };
  assert.throws(
    () => f.editor.rerun(f.exam.id, 'admin', { ...request, includeCandidates: true }),
    /not both/,
  );
  assert.throws(
    () => f.editor.rerun(f.exam.id, 'admin', { ...request, rosterRevision: 0 }),
    /changed/,
  );
  assert.throws(() => f.editor.rerun(f.exam.id, 'other-admin', request), /not found/);
  const result = f.editor.rerun(f.exam.id, 'admin', request);
  assert.equal(f.store.detail(result.id).candidates.length, 1);
  assert.equal(f.store.detail(result.id).candidates[0].name, 'New candidate');
  assert.equal(f.identity.examinations(newId).length, 1);
  assert.equal(f.identity.examinations(f.accountId).length, 1, 'pending member is not enrolled');
  assert.equal(rosters.additions(result.id, 'admin').rosterId, roster.id);
  assert.deepEqual(f.store.detail(f.exam.id), previous);
  rosters.review(roster.id, 'admin', f.accountId, { decision: 'approved' });
  assert.equal(
    f.editor.rerun(f.exam.id, 'admin', request).id,
    result.id,
    'retry returns the same new assessment after membership changes',
  );
  assert.equal(
    f.store.detail(result.id).candidates.length,
    2,
    'approved later members receive the linked draft automatically',
  );
  assert.throws(
    () =>
      f.editor.rerun(f.exam.id, 'admin', {
        ...request,
        rosterRevision: request.rosterRevision + 1,
      }),
    /different settings/,
  );
  assert.throws(
    () => f.editor.rerun(f.exam.id, 'admin', { ...request, rosterId: null }),
    /different settings/,
  );
});

test('draft edits update questions/settings while preserving candidates and registration links', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const before = f.editor.editView(f.exam.id);
  const candidates = f.store.detail(f.exam.id).candidates;
  const settings = f.identity.settings(f.exam.id);
  const update = {
    ...before.input,
    title: 'Updated title',
    durationMinutes: 45,
    expectedVersion: before.version,
  };
  update.questions = [
    ...before.input.questions,
    { type: 'short', prompt: 'Explain why.', marks: 5, options: [], correctIndices: [] },
  ];
  const saved = f.editor.update(f.exam.id, 'admin', update);
  assert.equal(saved.input.title, 'Updated title');
  assert.equal(saved.input.questions.length, 3);
  assert.equal(saved.input.durationMinutes, 45);
  assert.deepEqual(f.store.detail(f.exam.id).candidates, candidates);
  assert.deepEqual(f.identity.settings(f.exam.id), settings);
  assert.equal(
    f.editor.update(f.exam.id, 'admin', update).version,
    saved.version,
    'lost-response retries are harmless',
  );
  assert.throws(
    () =>
      f.editor.update(f.exam.id, 'admin', {
        ...before.input,
        title: 'Stale change',
        expectedVersion: before.version,
      }),
    /another window/,
  );
  assert.throws(
    () =>
      f.editor.update(f.exam.id, 'admin', {
        ...saved.input,
        questions: [],
        expectedVersion: saved.version,
      }),
    /1 and 200/,
  );
});

test('started and completed assessments cannot be edited; active assessments cannot be rerun', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const view = f.editor.editView(f.exam.id);
  f.store.launch(f.exam.id, 'admin');
  assert.throws(() => f.editor.editView(f.exam.id), /already started/);
  assert.throws(
    () => f.editor.update(f.exam.id, 'admin', { ...view.input, expectedVersion: view.version }),
    /already started/,
  );
  assert.throws(
    () =>
      f.editor.rerun(f.exam.id, 'admin', {
        title: 'Again',
        includeCandidates: true,
        requestId: randomUUID(),
      }),
    /Finish/,
  );
  f.store.end(f.exam.id, 'admin');
  assert.throws(
    () => f.editor.update(f.exam.id, 'admin', { ...view.input, expectedVersion: view.version }),
    /already started/,
  );
});

test('rerun creates a new editable assessment and fresh attempts without touching original answers/results', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const sitting = f.store.launch(f.exam.id, 'admin');
  const candidateId = f.store.detail(f.exam.id).candidates[0].id;
  f.store.start(sitting.id, candidateId);
  f.store.save(sitting.id, candidateId, f.exam.questions[0].id, {
    operationId: 'original-answer',
    expectedRevision: 0,
    value: f.exam.questions[0].correctOptionIds,
  });
  f.store.end(f.exam.id, 'admin');
  const original = f.store.detail(f.exam.id);
  const beforeAnswers = f.db.prepare('SELECT * FROM responses').all();
  const request = { title: 'Second run', includeCandidates: true, requestId: randomUUID() };
  const result = f.editor.rerun(f.exam.id, 'admin', request);
  const next = f.store.detail(result.id);
  assert.equal(next.summary.status, 'draft');
  assert.equal(next.candidates.length, 1);
  assert.equal(next.candidates[0].grade, null);
  assert.equal(next.candidates[0].answered, 0);
  assert.equal(next.source?.id, f.exam.id);
  assert.notEqual(next.assessment.questions[0].id, f.exam.questions[0].id);
  assert.notEqual(f.identity.settings(result.id).token, f.identity.settings(f.exam.id).token);
  assert.equal(f.identity.settings(result.id).open, false);
  assert.equal(f.editor.rerun(f.exam.id, 'admin', request).id, result.id);
  assert.throws(
    () => f.editor.rerun(f.exam.id, 'admin', { ...request, title: 'Different request' }),
    /different settings/,
  );
  assert.deepEqual(f.store.detail(f.exam.id), original);
  assert.deepEqual(f.db.prepare('SELECT * FROM responses').all(), beforeAnswers);
  assert.equal(f.identity.examinations(f.accountId).length, 2);
  const newSitting = f.store.launch(result.id, 'admin');
  assert.notEqual(newSitting.code, sitting.code);
  const newCandidate = next.candidates[0].id;
  f.store.start(newSitting.id, newCandidate);
  assert.deepEqual(f.store.responses(f.store.findAttempt(newSitting.id, newCandidate)!.id), {});
});

test('rerun can omit candidates and never reuses legacy access keys', (t) => {
  const f = fixture(true);
  t.after(() => f.db.close());
  f.store.launch(f.exam.id, 'admin');
  f.store.end(f.exam.id, 'admin');
  assert.throws(
    () =>
      f.editor.rerun(f.exam.id, 'admin', {
        title: 'Again',
        includeCandidates: true,
        requestId: randomUUID(),
      }),
    /keys are not reused/,
  );
  const result = f.editor.rerun(f.exam.id, 'admin', {
    title: 'Again',
    includeCandidates: false,
    requestId: randomUUID(),
  });
  assert.equal(f.store.detail(result.id).candidates.length, 0);
  assert.equal(f.identity.settings(result.id).mode, 'accounts');
  assert.equal(
    f.db.prepare('SELECT COUNT(*) n FROM candidates WHERE assessment_id=?').get(result.id)?.n,
    0,
  );
});

test('a naturally expired assessment can be rerun without a manual end action', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.store.launch(f.exam.id, 'admin');
  f.advance(61 * 60000);
  const result = f.editor.rerun(f.exam.id, 'admin', {
    title: 'Again',
    includeCandidates: false,
    requestId: randomUUID(),
  });
  assert.equal(f.store.detail(result.id).summary.status, 'draft');
});

test('editing and rerun endpoints require administrator access and CSRF protection', async (t) => {
  const f = fixture();
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on('request', await createHandler(f.db, { origin, now: () => 1000000 }));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.db.close();
  });
  const admin = f.store.createSession('admin', 'admin', null);
  const candidate = f.store.createSession('candidate', f.accountId, null, f.accountId);
  const endpoint = `${origin}/api/assessments/${f.exam.id}`;
  assert.equal((await fetch(endpoint + '/edit')).status, 401);
  assert.equal(
    (await fetch(endpoint + '/edit', { headers: { Cookie: `mudu_session=${candidate.raw}` } }))
      .status,
    403,
  );
  const view = f.editor.editView(f.exam.id);
  const body = JSON.stringify({ ...view.input, title: 'Updated', expectedVersion: view.version });
  const headers = {
    Origin: origin,
    Cookie: `mudu_session=${admin.raw}`,
    'Content-Type': 'application/json',
  };
  assert.equal((await fetch(endpoint + '/edit', { method: 'PUT', headers, body })).status, 403);
  assert.equal(
    (
      await fetch(endpoint + '/edit', {
        method: 'PUT',
        headers: { ...headers, 'X-CSRF-Token': admin.csrf },
        body,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(endpoint + '/rerun', {
        method: 'POST',
        headers: {
          ...headers,
          Cookie: `mudu_session=${candidate.raw}`,
          'X-CSRF-Token': candidate.csrf,
        },
        body: '{}',
      })
    ).status,
    403,
  );
});
