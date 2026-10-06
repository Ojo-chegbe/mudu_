import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, transaction } from '../apps/host/database.ts';
import { ExamStore } from '../apps/host/store.ts';
import { IdentityService } from '../apps/host/identity.ts';
import { Rosters } from '../apps/host/rosters.ts';
import { LiveMonitoring } from '../apps/host/monitoring.ts';
import { AssessmentEditing } from '../apps/host/assessment-editing.ts';
import { assessment, input } from './fixtures.ts';
import { parseAssessment } from '../packages/exam-core/engine.ts';
import { parseTiming } from '../packages/exam-core/timing.ts';
import { syncLinkedRosters } from '../apps/host/roster-admission.ts';

test('individual attempt deadlines and saved answers survive a database reopen after admission closes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mudu-individual-'));
  const path = join(directory, 'exam.sqlite');
  let db = openDatabase(path);
  let now = 1000000;
  try {
    let store = new ExamStore(db, () => now);
    const exam = assessment();
    exam.timing = { mode: 'individual', opensAt: now, lastStartAt: now + 120000, finishBy: null };
    store.createAssessment(
      exam,
      [{ id: 'candidate-1', identifier: '001', name: 'Student', hash: 'test-only' }],
      'admin',
    );
    const sitting = store.launch(exam.id, 'admin');
    const attempt = store.start(sitting.id, 'candidate-1');
    store.save(sitting.id, 'candidate-1', exam.questions[0].id, {
      value: exam.questions[0].correctOptionIds,
      expectedRevision: 0,
      operationId: 'before-restart',
    });
    db.close();
    now += 180000;
    db = openDatabase(path);
    store = new ExamStore(db, () => now);
    store.reconcile();
    assert.deepEqual(store.start(sitting.id, 'candidate-1'), attempt);
    const view = store.candidateView(sitting.id, 'candidate-1');
    assert.equal(view.sitting.canStart, false);
    assert.equal(view.attempt?.status, 'active');
    assert.equal(view.attempt?.deadline, attempt.deadline);
    assert.deepEqual(
      store.responses(attempt.id)[exam.questions[0].id].value,
      exam.questions[0].correctOptionIds,
    );
    now = attempt.deadline;
    assert.equal(store.candidateView(sitting.id, 'candidate-1').attempt?.status, 'expired');
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  } finally {
    db.close();
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  }
});

function fixture(t: { after: (fn: () => void) => void }) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  let now = 1000000;
  const store = new ExamStore(db, () => now);
  const rosters = new Rosters(store);
  const identity = new IdentityService(store);
  const roster = rosters.save(randomUUID(), 'admin', {
    name: 'Class',
    revision: 0,
    restricted: false,
    open: true,
    archived: false,
    entries: [],
  });
  let serial = 0;
  function member(approve = true) {
    const number = String(++serial).padStart(3, '0');
    const session = identity.createAccount({
      email: `${number}@example.test`,
      name: `Candidate ${number}`,
      identifier: number,
      hash: 'test',
    });
    const account = store.session(session.raw)!.account_id!;
    rosters.join(roster.token, account);
    if (approve) rosters.review(roster.id, 'admin', account, { decision: 'approved' });
    return account;
  }
  const first = member();
  function create(individual = false, finishBy: number | null = null, late = false) {
    const exam = assessment();
    exam.durationMinutes = 10;
    exam.allowLateAdmission = late;
    if (individual)
      exam.timing = {
        mode: 'individual',
        opensAt: now + 60000,
        lastStartAt: now + 300000,
        finishBy,
      };
    const snapshot = rosters.snapshot(roster.id, 'admin', rosters.get(roster.id, 'admin').revision);
    store.createAssessment(
      exam,
      snapshot.candidates.map((c) => ({ ...c, id: randomUUID(), hash: 'account-managed' })),
      'admin',
      { mode: 'accounts', policy: 'roster', capacity: 500, closesAt: null },
      undefined,
      snapshot.roster,
    );
    return exam;
  }
  return {
    db,
    store,
    identity,
    rosters,
    roster,
    first,
    member,
    create,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('individual timing starts on Begin, persists on retry/recovery, and separates start closure from attempt expiry', (t) => {
  const f = fixture(t);
  const second = f.member();
  const third = f.member();
  const exam = f.create(true);
  const sitting = f.store.launch(exam.id, 'admin');
  const a = f.identity.authorizeExam(f.first, exam.id);
  const b = f.identity.authorizeExam(second, exam.id);
  const c = f.identity.authorizeExam(third, exam.id);
  const instructions = f.store.candidateView(a.sittingId, a.candidateId);
  assert.equal(instructions.attempt, null);
  assert.equal(instructions.sitting.canStart, false);
  assert.equal(instructions.sitting.startRestriction, 'not_open');
  assert.throws(() => f.store.start(sitting.id, a.candidateId), /not open/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM attempts').get()?.n, 0);
  f.advance(60000);
  const first = f.store.start(sitting.id, a.candidateId);
  assert.equal(first.deadline, f.now() + 600000);
  f.advance(120000);
  const other = f.store.start(sitting.id, b.candidateId);
  assert.equal(other.deadline, f.now() + 600000);
  assert.equal(other.deadline - first.deadline, 120000);
  assert.deepEqual(f.store.start(sitting.id, a.candidateId), first);
  f.advance(120000);
  assert.throws(() => f.store.start(sitting.id, c.candidateId), /ended/);
  assert.equal(f.identity.examinations(third)[0].examStatus, 'ended');
  assert.equal(f.identity.examinations(second)[0].examStatus, 'active');
  assert.equal(new LiveMonitoring(f.store).heartbeat(sitting.id, b.candidateId).ended, false);
  assert.equal(f.store.candidateView(sitting.id, b.candidateId).sitting.deadline, other.deadline);
  const q = exam.questions[0];
  f.store.save(sitting.id, b.candidateId, q.id, {
    value: q.correctOptionIds,
    expectedRevision: 0,
    operationId: 'after-start-window-close',
  });
  f.advance(360000);
  const recovered = new ExamStore(f.db, f.now);
  recovered.reconcile();
  assert.equal(recovered.findAttempt(sitting.id, a.candidateId)?.status, 'expired');
  assert.equal(recovered.findAttempt(sitting.id, b.candidateId)?.status, 'active');
  assert.equal(recovered.findAttempt(sitting.id, b.candidateId)?.deadline, other.deadline);
  assert.equal(recovered.responses(other.id)[q.id].revision, 1);
});

test('a finish-by deadline caps individual duration and never grants another attempt', (t) => {
  const f = fixture(t);
  const finishBy = f.now() + 420000;
  const exam = f.create(true, finishBy);
  const sitting = f.store.launch(exam.id, 'admin');
  f.advance(240000);
  const admitted = f.identity.authorizeExam(f.first, exam.id);
  const preview = f.store.candidateView(sitting.id, admitted.candidateId);
  assert.equal(preview.sitting.deadline - preview.serverNow, 180000);
  const attempt = f.store.start(sitting.id, admitted.candidateId);
  assert.equal(attempt.deadline, finishBy);
  f.advance(180000);
  assert.equal(f.store.candidateView(sitting.id, admitted.candidateId).attempt?.status, 'expired');
  assert.equal(f.store.start(sitting.id, admitted.candidateId).id, attempt.id);
  assert.equal(f.store.start(sitting.id, admitted.candidateId).status, 'expired');
  assert.throws(
    () =>
      f.store.save(sitting.id, admitted.candidateId, exam.questions[0].id, {
        value: [],
        expectedRevision: 0,
        operationId: 'too-late-answer',
      }),
    /closed/,
  );
});

test('linked rosters auto-enrol approved later members; late admission is explicit, audited and non-retroactive', (t) => {
  const f = fixture(t);
  const exam = f.create();
  const pending = f.member(false);
  assert.equal(f.identity.examinations(pending).length, 0);
  f.rosters.review(f.roster.id, 'admin', pending, { decision: 'approved' });
  assert.equal(f.identity.examinations(pending).length, 1);
  const sitting = f.store.launch(exam.id, 'admin');
  const first = f.identity.authorizeExam(f.first, exam.id);
  const original = f.store.start(sitting.id, first.candidateId);
  const late = f.member();
  assert.equal(f.identity.examinations(late).length, 0);
  assert.throws(() => f.identity.authorizeExam(late, exam.id), /not approved/);
  f.advance(60000);
  const result = f.store.setAdmission(exam.id, 'admin', {
    allowLateAdmission: true,
    expectedAllowLateAdmission: false,
  });
  assert.equal(result.added, 1);
  assert.equal(f.identity.examinations(late).length, 1);
  const admission = f.identity.authorizeExam(late, exam.id);
  assert.equal(f.store.start(sitting.id, admission.candidateId).deadline, original.deadline);
  assert.equal(f.store.findAttempt(sitting.id, first.candidateId)?.deadline, original.deadline);
  const next = f.member();
  assert.equal(f.identity.examinations(next).length, 1);
  f.store.setAdmission(exam.id, 'admin', {
    allowLateAdmission: false,
    expectedAllowLateAdmission: true,
  });
  assert.equal(f.identity.examinations(next).length, 1);
  const blocked = f.member();
  assert.equal(f.identity.examinations(blocked).length, 0);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='late_admission_changed'").get()?.n,
    2,
  );
  f.store.end(exam.id, 'admin');
  assert.equal(f.identity.examinations(f.member()).length, 0);
  assert.throws(
    () =>
      f.store.setAdmission(exam.id, 'admin', {
        allowLateAdmission: true,
        expectedAllowLateAdmission: false,
      }),
    /closed/,
  );
});

test('roster admission before a future opening is automatic; after last start no new members are admitted', (t) => {
  const f = fixture(t);
  const exam = f.create(true);
  const sitting = f.store.launch(exam.id, 'admin');
  const beforeOpening = f.member();
  assert.equal(f.identity.examinations(beforeOpening)[0].examStatus, 'upcoming');
  f.advance(60000);
  const existing = f.identity.authorizeExam(f.first, exam.id);
  f.store.start(sitting.id, existing.candidateId);
  const late = f.member();
  assert.equal(f.identity.examinations(late).length, 0);
  f.store.setAdmission(exam.id, 'admin', {
    allowLateAdmission: true,
    expectedAllowLateAdmission: false,
  });
  assert.equal(f.identity.examinations(late).length, 1);
  f.advance(240000);
  const afterClosure = f.member();
  assert.equal(f.identity.examinations(afterClosure).length, 0);
  assert.throws(
    () =>
      f.store.setAdmission(exam.id, 'admin', {
        allowLateAdmission: true,
        expectedAllowLateAdmission: true,
      }),
    /start window/,
  );
  assert.equal(f.store.findAttempt(sitting.id, existing.candidateId)?.status, 'active');
});

test('startup roster reconciliation is idempotent, preserves results and respects capacity and rejected registrations', (t) => {
  const f = fixture(t);
  const exam = f.create();
  f.db.prepare('UPDATE registration_settings SET capacity=2 WHERE assessment_id=?').run(exam.id);
  const second = f.member();
  const third = f.member();
  assert.equal(f.identity.examinations(second).length, 1);
  assert.equal(f.identity.examinations(third).length, 0);
  transaction(f.db, () => syncLinkedRosters(f.store, 'system'));
  transaction(f.db, () => syncLinkedRosters(f.store, 'system'));
  assert.equal(f.store.detail(exam.id).candidates.length, 2);
  f.db.prepare('UPDATE registration_settings SET capacity=500 WHERE assessment_id=?').run(exam.id);
  transaction(f.db, () => syncLinkedRosters(f.store, 'system'));
  assert.equal(f.identity.examinations(third).length, 1);
  f.db
    .prepare("UPDATE registrations SET status='rejected' WHERE assessment_id=? AND account_id=?")
    .run(exam.id, third);
  transaction(f.db, () => syncLinkedRosters(f.store, 'system'));
  assert.equal(f.identity.examinations(third)[0].registrationStatus, 'rejected');
});

test('shared timing remains the default; timing cannot change after publication and missed windows cannot launch', (t) => {
  const f = fixture(t);
  const exam = f.create();
  delete exam.timing;
  f.db.prepare('UPDATE assessments SET definition=? WHERE id=?').run(JSON.stringify(exam), exam.id);
  const sitting = f.store.launch(exam.id, 'admin');
  const candidate = f.identity.authorizeExam(f.first, exam.id);
  f.advance(60000);
  const attempt = f.store.start(sitting.id, candidate.candidateId);
  assert.equal(attempt.deadline - f.now(), 540000);
  assert.equal(
    f.store.candidateView(sitting.id, candidate.candidateId).sitting.timingMode,
    'shared',
  );
  assert.throws(() => new AssessmentEditing(f.store).editView(exam.id), /already started/);
  f.store.end(exam.id, 'admin');
  const expiredWindow = f.create(true);
  f.advance(300000);
  assert.throws(() => f.store.launch(expiredWindow.id, 'admin'), /last start time/);
  assert.equal(
    f.db.prepare('SELECT COUNT(*) n FROM sittings WHERE assessment_id=?').get(expiredWindow.id)?.n,
    0,
  );
});

test('timing validation rejects malformed dates and ambiguous windows', () => {
  const valid = { mode: 'individual', opensAt: 1000000, lastStartAt: 2000000, finishBy: null };
  assert.deepEqual(parseTiming(valid), valid);
  assert.equal(parseTiming(undefined).mode, 'shared');
  for (const invalid of [
    null,
    [],
    'individual',
    { mode: 'other' },
    { ...valid, opensAt: null },
    { ...valid, opensAt: NaN },
    { ...valid, opensAt: '2026-01-01' },
    { ...valid, lastStartAt: 0 },
    { ...valid, lastStartAt: 1000000 },
    { ...valid, finishBy: 2000000 },
    { ...valid, finishBy: Infinity },
  ])
    assert.throws(() => parseTiming(invalid));
  assert.throws(
    () => parseAssessment({ ...input(), allowLateAdmission: 'true' }, randomUUID),
    /Late admission/,
  );
});
