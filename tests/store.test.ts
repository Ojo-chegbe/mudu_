import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../apps/host/database.ts';
import { ExamStore } from '../apps/host/store.ts';
import { assessment } from './fixtures.ts';

function fixture() {
  let now = 1000000;
  const db = openDatabase(':memory:');
  const store = new ExamStore(db, () => now);
  const exam = assessment();
  store.createAssessment(
    exam,
    [{ id: 'candidate-1', identifier: 'MUD/001', name: 'Candidate', hash: 'test-only' }],
    'admin',
  );
  const sitting = store.launch(exam.id, 'admin');
  return {
    db,
    store,
    exam,
    sitting,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
test('manual marking validates marks, rejects stale edits, updates totals and records the reviewer', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const store = new ExamStore(db, () => 1000000);
  const exam = assessment();
  exam.questions.push({
    id: 'essay',
    type: 'short',
    prompt: 'Explain your reasoning.',
    marks: 5,
    options: [],
    correctOptionIds: [],
  });
  store.createAssessment(
    exam,
    [{ id: 'writer', identifier: 'W/1', name: 'Writer', hash: 'test' }],
    'admin',
  );
  const sitting = store.launch(exam.id, 'admin');
  store.start(sitting.id, 'writer');
  const mark = { questionId: 'essay', score: 4, expectedRevision: 0 };
  assert.throws(() => store.mark(exam.id, 'writer', mark, 'reviewer'), /completed/);
  store.save(sitting.id, 'writer', 'essay', {
    value: 'My reasoning',
    expectedRevision: 0,
    operationId: 'essay-answer',
  });
  store.submit(sitting.id, 'writer');
  assert.equal(store.detail(exam.id).candidates[0].grade?.pendingManual, 1);
  assert.equal(store.review(exam.id, 'writer').questions[0].answer, 'My reasoning');
  for (const score of [-1, 6, NaN, Infinity, '4'])
    assert.throws(() => store.mark(exam.id, 'writer', { ...mark, score }, 'reviewer'));
  assert.throws(() =>
    store.mark(exam.id, 'writer', { ...mark, questionId: exam.questions[0].id }, 'reviewer'),
  );
  assert.throws(() => store.review('wrong-assessment', 'writer'));
  store.mark(exam.id, 'writer', mark, 'reviewer');
  assert.throws(() => store.mark(exam.id, 'writer', mark, 'other-reviewer'), /changed/);
  const result = new ExamStore(db).detail(exam.id).candidates[0].grade!;
  assert.equal(result.manualScore, 4);
  assert.equal(result.totalScore, 4);
  assert.equal(result.pendingManual, 0);
  assert.equal(result.percentage, 40);
  assert.equal(result.passed, false);
  store.mark(exam.id, 'writer', { ...mark, score: 5, expectedRevision: 1 }, 'reviewer');
  assert.equal(store.detail(exam.id).candidates[0].grade?.passed, true);
  store.mark(exam.id, 'writer', { ...mark, score: 0, expectedRevision: 2 }, 'reviewer');
  assert.equal(store.detail(exam.id).candidates[0].grade?.pendingManual, 0);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE kind='manual_grade_saved' AND actor_id='reviewer'",
      )
      .get()?.n,
    3,
  );
});
test('repeated start creates one attempt and late arrivals do not receive extra time', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.advance(500000);
  const first = f.store.start(f.sitting.id, 'candidate-1');
  assert.deepEqual(f.store.start(f.sitting.id, 'candidate-1'), first);
  assert.equal(first.deadline, 1000000 + 60 * 60000);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS total FROM attempts').get()?.total, 1);
});
test('answer retries return original receipt and conflicting revisions cannot overwrite newer answers', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.store.start(f.sitting.id, 'candidate-1');
  const q = f.exam.questions[0];
  const first = { value: q.correctOptionIds, expectedRevision: 0, operationId: 'operation-1' };
  const receipt = f.store.save(f.sitting.id, 'candidate-1', q.id, first);
  f.advance(500);
  assert.deepEqual(f.store.save(f.sitting.id, 'candidate-1', q.id, first), receipt);
  assert.throws(
    () =>
      f.store.save(f.sitting.id, 'candidate-1', q.id, {
        ...first,
        value: [],
        operationId: 'operation-1',
      }),
    /already used/,
  );
  assert.throws(
    () =>
      f.store.save(f.sitting.id, 'candidate-1', q.id, {
        ...first,
        value: [],
        operationId: 'operation-2',
      }),
    /newer answer/,
  );
  assert.equal(
    f.store.save(f.sitting.id, 'candidate-1', q.id, {
      value: [],
      expectedRevision: 1,
      operationId: 'operation-2',
    }).revision,
    2,
  );
});
test('submission is idempotent and prevents further answer changes', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.store.start(f.sitting.id, 'candidate-1');
  const receipt = f.store.submit(f.sitting.id, 'candidate-1');
  f.advance(1000);
  assert.deepEqual(f.store.submit(f.sitting.id, 'candidate-1'), receipt);
  assert.throws(
    () =>
      f.store.save(f.sitting.id, 'candidate-1', f.exam.questions[0].id, {
        value: [],
        expectedRevision: 0,
        operationId: 'after-submit',
      }),
    /closed/,
  );
});
test('expiry is enforced on reads and writes without an in-memory timer', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.store.start(f.sitting.id, 'candidate-1');
  f.advance(60 * 60000);
  assert.throws(
    () =>
      f.store.save(f.sitting.id, 'candidate-1', f.exam.questions[0].id, {
        value: [],
        expectedRevision: 0,
        operationId: 'expired-save',
      }),
    /closed/,
  );
  const view = f.store.candidateView(f.sitting.id, 'candidate-1');
  assert.equal(view.attempt?.status, 'expired');
  assert.equal(view.attempt?.submittedAt, view.attempt?.deadline);
});
test('candidate data never includes answer keys, grading rules, or other candidates', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  assert.equal(f.store.candidateView(f.sitting.id, 'candidate-1').attempt, null);
  f.store.start(f.sitting.id, 'candidate-1');
  const view = f.store.candidateView(f.sitting.id, 'candidate-1');
  assert.equal(view.attempt?.questions.length, 2);
  assert.doesNotMatch(JSON.stringify(view), /correctOptionIds|credential_hash|passPercent/);
  assert.throws(() => f.store.candidateView(f.sitting.id, 'foreign-candidate'), /not found/);
  assert.throws(() => f.store.start(f.sitting.id, 'foreign-candidate'), /not eligible/);
});
test('recovery login revokes previous device authorization without creating another attempt', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const attempt = f.store.start(f.sitting.id, 'candidate-1');
  const first = f.store.createSession('candidate', 'candidate-1', f.sitting.id);
  const second = f.store.createSession('candidate', 'candidate-1', f.sitting.id);
  assert.equal(f.store.session(first.raw), undefined);
  assert.ok(f.store.session(second.raw));
  assert.equal(f.store.start(f.sitting.id, 'candidate-1').id, attempt.id);
});
test('end examination submits saved answers and permits a subsequent sitting', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  f.store.start(f.sitting.id, 'candidate-1');
  f.store.end(f.exam.id, 'admin');
  assert.equal(f.store.candidateView(f.sitting.id, 'candidate-1').attempt?.status, 'submitted');
  assert.equal(f.store.detail(f.exam.id).summary.status, 'completed');
  assert.deepEqual(f.store.end(f.exam.id, 'admin'), { ok: true });
});
test('database reopen preserves answers, fixed order, deadlines, and sessions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mudu-recovery-'));
  const path = join(directory, 'exam.sqlite');
  let db = openDatabase(path);
  try {
    let store = new ExamStore(db, () => 1000000);
    const exam = assessment();
    store.createAssessment(
      exam,
      [{ id: 'candidate-1', identifier: 'A', name: 'A', hash: 'test-only' }],
      'admin',
    );
    const sitting = store.launch(exam.id, 'admin');
    const attempt = store.start(sitting.id, 'candidate-1');
    store.save(sitting.id, 'candidate-1', exam.questions[0].id, {
      value: exam.questions[0].correctOptionIds,
      expectedRevision: 0,
      operationId: 'restart-answer',
    });
    const session = store.createSession('candidate', 'candidate-1', sitting.id);
    db.close();
    db = openDatabase(path);
    store = new ExamStore(db, () => 1001000);
    assert.deepEqual(store.findAttempt(sitting.id, 'candidate-1'), attempt);
    assert.deepEqual(
      store.responses(attempt.id)[exam.questions[0].id].value,
      exam.questions[0].correctOptionIds,
    );
    assert.ok(store.session(session.raw));
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  } finally {
    db.close();
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  }
});
