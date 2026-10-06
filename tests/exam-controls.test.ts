import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../apps/host/database.ts';
import { ExamStore } from '../apps/host/store.ts';
import { ExamControls, execution } from '../apps/host/exam-controls.ts';
import { LiveMonitoring } from '../apps/host/monitoring.ts';
import { assessment } from './fixtures.ts';

function fixture(t: { after: (fn: () => void) => void }, individual = false, cap = false) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  let now = 1000000;
  const store = new ExamStore(db, () => now),
    controls = new ExamControls(store);
  const exam = assessment();
  exam.durationMinutes = 10;
  if (individual)
    exam.timing = {
      mode: 'individual',
      opensAt: now,
      lastStartAt: now + 300000,
      finishBy: cap ? now + 600000 : null,
    };
  store.createAssessment(
    exam,
    ['one', 'two', 'three'].map((id) => ({ id, identifier: id, name: id, hash: 'test' })),
    'admin',
  );
  const sitting = store.launch(exam.id, 'admin');
  function command(action: string, rest: Record<string, unknown> = {}) {
    return controls.perform(exam.id, 'admin', {
      action,
      operationId: randomUUID(),
      expectedRevision: execution(db, store.sitting(sitting.id), now).revision,
      reason: 'Approved adjustment',
      ...rest,
    });
  }
  return {
    db,
    store,
    controls,
    exam,
    sitting,
    command,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('pause freezes expiry, blocks new writes/starts/submission, preserves replay and restores deadlines', (t) => {
  const f = fixture(t);
  const a = f.store.start(f.sitting.id, 'one');
  const save = {
    value: f.exam.questions[0].correctOptionIds,
    expectedRevision: 0,
    operationId: randomUUID(),
  };
  const receipt = f.store.save(f.sitting.id, 'one', f.exam.questions[0].id, save);
  f.advance(120000);
  f.command('pause');
  f.advance(900000);
  f.store.reconcile();
  assert.equal(f.store.findAttempt(f.sitting.id, 'one')?.status, 'active');
  assert.equal(f.store.listAssessments()[0].status, 'active');
  assert.equal(f.store.candidateView(f.sitting.id, 'one').controls?.pausedAt, 1120000);
  assert.equal(new LiveMonitoring(f.store).heartbeat(f.sitting.id, 'one').ended, false);
  assert.throws(() => f.store.start(f.sitting.id, 'two'), /paused/);
  assert.throws(
    () =>
      f.store.save(f.sitting.id, 'one', f.exam.questions[0].id, {
        ...save,
        operationId: randomUUID(),
        expectedRevision: 1,
      }),
    /paused/,
  );
  assert.deepEqual(f.store.save(f.sitting.id, 'one', f.exam.questions[0].id, save), receipt);
  assert.throws(() => f.store.submit(f.sitting.id, 'one'), /paused/);
  f.command('resume');
  assert.equal(f.store.findAttempt(f.sitting.id, 'one')!.deadline, a.deadline + 900000);
  assert.equal(f.store.start(f.sitting.id, 'two').deadline, a.deadline + 900000);
  assert.equal(f.store.start(f.sitting.id, 'one').id, a.id);
});

test('individual pause shifts start window and hard cap; ongoing attempts retain their own remaining time', (t) => {
  const f = fixture(t, true, true);
  const a = f.store.start(f.sitting.id, 'one');
  f.advance(60000);
  f.command('pause');
  f.advance(900000);
  f.command('resume');
  const view = f.store.candidateView(f.sitting.id, 'one');
  assert.equal(view.sitting.lastStartAt, f.exam.timing!.lastStartAt! + 900000);
  assert.equal(view.sitting.finishBy, f.exam.timing!.finishBy! + 900000);
  assert.equal(view.attempt!.deadline, a.deadline + 900000);
  const b = f.store.start(f.sitting.id, 'two');
  assert.equal(b.deadline, view.sitting.finishBy);
});

test('shared individual extensions do not extend admission or other candidates; global extension does', (t) => {
  const f = fixture(t);
  const a = f.store.start(f.sitting.id, 'one'),
    b = f.store.start(f.sitting.id, 'two');
  f.command('extend', { candidateId: 'one', minutes: 5 });
  assert.equal(f.store.findAttempt(f.sitting.id, 'one')!.deadline, a.deadline + 300000);
  assert.equal(f.store.findAttempt(f.sitting.id, 'two')!.deadline, b.deadline);
  assert.equal(f.store.candidateView(f.sitting.id, 'three').sitting.lastStartAt, b.deadline);
  f.command('extend', { minutes: 2 });
  assert.equal(f.store.findAttempt(f.sitting.id, 'one')!.deadline, a.deadline + 420000);
  assert.equal(f.store.start(f.sitting.id, 'three').deadline, b.deadline + 120000);
});

test('individual global extension changes future duration and hard cap, not the last-start boundary or closed attempts', (t) => {
  const f = fixture(t, true, true);
  const a = f.store.start(f.sitting.id, 'one');
  assert.throws(() => f.command('extend', { candidateId: 'one', minutes: 1 }), /finish-by/);
  f.store.start(f.sitting.id, 'two');
  f.store.submit(f.sitting.id, 'two');
  f.command('extend', { minutes: 5 });
  assert.equal(f.store.findAttempt(f.sitting.id, 'one')!.deadline, a.deadline + 300000);
  const view = f.store.candidateView(f.sitting.id, 'three');
  assert.equal(view.sitting.durationMinutes, 15);
  assert.equal(view.sitting.lastStartAt, f.exam.timing!.lastStartAt);
  assert.equal(view.sitting.finishBy, f.exam.timing!.finishBy! + 300000);
  assert.equal(f.store.findAttempt(f.sitting.id, 'two')!.status, 'submitted');
  assert.throws(() => f.command('extend', { candidateId: 'two', minutes: 1 }), /ongoing/);
  f.advance(300000);
  assert.throws(() => f.store.start(f.sitting.id, 'three'), /ended/);
});

test('force submission includes only persisted answers, is final even during pause, and records actor/reason', (t) => {
  const f = fixture(t);
  const a = f.store.start(f.sitting.id, 'one');
  f.store.save(f.sitting.id, 'one', f.exam.questions[0].id, {
    value: f.exam.questions[0].correctOptionIds,
    expectedRevision: 0,
    operationId: randomUUID(),
  });
  f.command('pause');
  f.command('force_submit', { candidateId: 'one', reason: 'Approved early collection' });
  assert.equal(f.store.findAttempt(f.sitting.id, 'one')!.status, 'submitted');
  assert.equal(Object.keys(f.store.responses(a.id)).length, 1);
  assert.throws(() => f.command('force_submit', { candidateId: 'two' }), /ongoing/);
  f.command('resume');
  assert.equal(f.store.start(f.sitting.id, 'one').status, 'submitted');
  const event = f.db
    .prepare("SELECT actor_id,detail FROM events WHERE kind='exam_force_submit'")
    .get()!;
  assert.equal(event.actor_id, 'admin');
  assert.match(String(event.detail), /Approved early collection/);
});

test('announcements are persistent, scoped, escaped as data and acknowledged per candidate', (t) => {
  const f = fixture(t);
  f.command('announce', { message: '<script>alert(1)</script> Please continue.' });
  const first = f.store.candidateView(f.sitting.id, 'one').announcements![0];
  assert.match(first.message, /<script>/);
  assert.equal(first.read, false);
  f.controls.acknowledge(f.sitting.id, 'one', { id: first.id });
  f.controls.acknowledge(f.sitting.id, 'one', { id: first.id });
  assert.equal(f.store.candidateView(f.sitting.id, 'one').announcements![0].read, true);
  assert.equal(f.store.candidateView(f.sitting.id, 'two').announcements![0].read, false);
  assert.throws(
    () => f.controls.acknowledge(f.sitting.id, 'one', { id: randomUUID() }),
    /not found/,
  );
  assert.doesNotMatch(
    JSON.stringify(new LiveMonitoring(f.store).snapshot(f.exam.id)),
    /correctOptionIds|credential_hash/,
  );
});

test('control retries do not double-extend and stale/conflicting requests fail without partial changes', (t) => {
  const f = fixture(t);
  const a = f.store.start(f.sitting.id, 'one');
  const payload = {
    action: 'extend',
    minutes: 5,
    reason: 'Approved adjustment',
    expectedRevision: 0,
    operationId: randomUUID(),
  };
  const result = f.controls.perform(f.exam.id, 'admin', payload);
  assert.deepEqual(f.controls.perform(f.exam.id, 'admin', payload), result);
  assert.equal(f.store.findAttempt(f.sitting.id, 'one')!.deadline, a.deadline + 300000);
  assert.throws(
    () => f.controls.perform(f.exam.id, 'admin', { ...payload, minutes: 10 }),
    /different changes/,
  );
  assert.throws(
    () => f.controls.perform(f.exam.id, 'admin', { ...payload, operationId: randomUUID() }),
    /changed/,
  );
  for (const minutes of [0, -1, 1.5, 241, '5'])
    assert.throws(() => f.command('extend', { minutes }), /minutes/);
  assert.throws(() => f.command('pause', { reason: '' }), /Reason/);
  f.store.end(f.exam.id, 'admin');
  assert.throws(() => f.store.start(f.sitting.id, 'two'), /ended/);
  assert.throws(() => f.command('extend', { minutes: 1 }), /closed/);
  assert.deepEqual(f.controls.perform(f.exam.id, 'admin', payload), result);
});

test('paused state and control receipts survive disk reopen, even beyond the previous deadline', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mudu-controls-'));
  let db = openDatabase(join(directory, 'exam.sqlite'));
  let now = 1000000;
  try {
    let store = new ExamStore(db, () => now),
      controls = new ExamControls(store);
    const exam = assessment();
    store.createAssessment(
      exam,
      [{ id: 'one', identifier: '001', name: 'One', hash: 'test' }],
      'admin',
    );
    const sitting = store.launch(exam.id, 'admin'),
      attempt = store.start(sitting.id, 'one');
    const pause = {
      action: 'pause',
      reason: 'Network maintenance',
      operationId: randomUUID(),
      expectedRevision: 0,
    };
    const receipt = controls.perform(exam.id, 'admin', pause);
    db.close();
    now += 7200000;
    db = openDatabase(join(directory, 'exam.sqlite'));
    store = new ExamStore(db, () => now);
    controls = new ExamControls(store);
    store.reconcile();
    assert.equal(store.findAttempt(sitting.id, 'one')!.status, 'active');
    assert.deepEqual(controls.perform(exam.id, 'admin', pause), receipt);
    controls.perform(exam.id, 'admin', {
      action: 'resume',
      reason: 'Network restored',
      operationId: randomUUID(),
      expectedRevision: 1,
    });
    assert.equal(store.findAttempt(sitting.id, 'one')!.deadline, attempt.deadline + 7200000);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  } finally {
    db.close();
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  }
});

test('v11 migration adds controls without rewriting active attempts or saved responses', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mudu-controls-migration-'));
  const path = join(directory, 'exam.sqlite');
  let db = openDatabase(path);
  try {
    let store = new ExamStore(db, () => 1000000);
    const exam = assessment();
    store.createAssessment(
      exam,
      [{ id: 'one', identifier: '001', name: 'One', hash: 'test' }],
      'admin',
    );
    const sitting = store.launch(exam.id, 'admin');
    const attempt = store.start(sitting.id, 'one');
    store.save(sitting.id, 'one', exam.questions[0].id, {
      value: exam.questions[0].correctOptionIds,
      expectedRevision: 0,
      operationId: randomUUID(),
    });
    db.exec(
      'DROP TABLE workspace_connections; DROP TABLE account_preferences; DROP TABLE admin_device_sessions; DROP TABLE admin_device_access; DROP TABLE password_recovery; DROP TABLE offline_candidate_sessions; DROP TABLE local_admission; DROP TABLE local_preparations; DROP TABLE authoring_drafts; DROP TABLE candidate_provider_identities; DROP TABLE cloud_sync_jobs; DROP TABLE cloud_instance; DROP TABLE provider_sessions; DROP TABLE admin_provider_identities; DROP TABLE assessment_owners; DROP TABLE exam_control_receipts; DROP TABLE announcement_reads; DROP TABLE exam_announcements; DROP TABLE exam_controls; PRAGMA user_version=11;',
    );
    db.close();
    db = openDatabase(path);
    store = new ExamStore(db, () => 1001000);
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 20);
    assert.deepEqual(store.findAttempt(sitting.id, 'one'), attempt);
    assert.deepEqual(
      store.responses(attempt.id)[exam.questions[0].id].value,
      exam.questions[0].correctOptionIds,
    );
    assert.equal(store.candidateView(sitting.id, 'one').controls!.pausedAt, null);
  } finally {
    db.close();
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  }
});
