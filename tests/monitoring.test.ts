import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../apps/host/database.ts';
import { ExamStore } from '../apps/host/store.ts';
import { LiveMonitoring, disconnectAfterMs } from '../apps/host/monitoring.ts';
import { assessment } from './fixtures.ts';
import { contactAge, monitorCandidates } from '../apps/web/monitor-view.ts';
import type { MonitoredCandidate } from '../packages/contracts/monitoring.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  let now = 1000000;
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const store = new ExamStore(db, () => now);
  const exam = assessment();
  store.createAssessment(
    exam,
    [
      { id: 'one', identifier: '001', name: 'Ada', hash: 'test' },
      { id: 'two', identifier: '002', name: 'Ben', hash: 'test' },
    ],
    'admin',
  );
  const monitor = new LiveMonitoring(store);
  return {
    db,
    store,
    exam,
    monitor,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('monitoring derives disconnection without changing attempts, answers or deadlines', (t) => {
  const f = fixture(t);
  assert.equal(f.monitor.snapshot(f.exam.id).deadline, null);
  assert.deepEqual(
    f.monitor.snapshot(f.exam.id).candidates.map((c) => c.status),
    ['waiting', 'waiting'],
  );
  const sitting = f.store.launch(f.exam.id, 'admin');
  const attempt = f.store.start(sitting.id, 'one');
  f.monitor.heartbeat(sitting.id, 'one');
  assert.equal(f.monitor.snapshot(f.exam.id).candidates[0].status, 'active');
  f.advance(disconnectAfterMs - 1);
  assert.equal(f.monitor.snapshot(f.exam.id).candidates[0].status, 'active');
  f.advance(1);
  assert.equal(f.monitor.snapshot(f.exam.id).candidates[0].status, 'disconnected');
  assert.equal(f.monitor.snapshot(f.exam.id).candidates[1].status, 'waiting');
  assert.deepEqual(f.store.findAttempt(sitting.id, 'one'), attempt);
  assert.deepEqual(f.store.responses(attempt.id), {});
  f.monitor.heartbeat(sitting.id, 'one');
  const result = new LiveMonitoring(new ExamStore(f.db, f.now)).snapshot(f.exam.id);
  assert.equal(result.candidates[0].status, 'active');
  assert.equal(result.candidates[0].reconnects, 1);
  assert.equal(f.store.findAttempt(sitting.id, 'one')?.deadline, attempt.deadline);
  f.monitor.heartbeat(sitting.id, 'one');
  assert.equal(f.monitor.snapshot(f.exam.id).candidates[0].reconnects, 1);
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE kind='candidate_connection_restored'")
      .get()?.n,
    1,
  );
});

test('waiting candidates can connect; submitted and expired states override connectivity', (t) => {
  const f = fixture(t);
  const sitting = f.store.launch(f.exam.id, 'admin');
  f.monitor.heartbeat(sitting.id, 'two');
  const waiting = f.monitor.snapshot(f.exam.id).candidates[1];
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.lastSeenAt, f.now());
  f.store.start(sitting.id, 'one');
  f.store.submit(sitting.id, 'one');
  f.advance(disconnectAfterMs * 2);
  assert.equal(f.monitor.snapshot(f.exam.id).candidates[0].status, 'submitted');
  assert.equal(f.monitor.heartbeat(sitting.id, 'one').ended, true);
  f.advance(3600000);
  const rows = f.monitor.snapshot(f.exam.id).candidates;
  assert.equal(rows[0].status, 'submitted');
  assert.equal(rows[1].status, 'expired');
  assert.equal(rows[1].startedAt, null);
  assert.equal(f.monitor.heartbeat(sitting.id, 'two').ended, true);
});

test('saved progress ignores empty responses and contact includes acknowledged answer writes', (t) => {
  const f = fixture(t);
  const sitting = f.store.launch(f.exam.id, 'admin');
  f.store.start(sitting.id, 'one');
  f.monitor.heartbeat(sitting.id, 'one');
  f.advance(disconnectAfterMs);
  const q = f.exam.questions[0];
  f.store.save(sitting.id, 'one', q.id, {
    value: q.correctOptionIds,
    expectedRevision: 0,
    operationId: 'monitor-save-1',
  });
  let row = f.monitor.snapshot(f.exam.id).candidates[0];
  assert.equal(row.answered, 1);
  assert.equal(row.status, 'active');
  assert.equal(row.lastSavedAt, f.now());
  f.monitor.heartbeat(sitting.id, 'one');
  assert.equal(f.monitor.snapshot(f.exam.id).candidates[0].reconnects, 0);
  f.store.save(sitting.id, 'one', q.id, {
    value: [],
    expectedRevision: 1,
    operationId: 'monitor-save-2',
  });
  row = f.monitor.snapshot(f.exam.id).candidates[0];
  assert.equal(row.answered, 0);
  assert.doesNotMatch(
    JSON.stringify(f.monitor.snapshot(f.exam.id)),
    /correctOptionIds|prompt|credential|responses/,
  );
});

test('monitoring rejects ineligible candidates and unknown assessments', (t) => {
  const f = fixture(t);
  const sitting = f.store.launch(f.exam.id, 'admin');
  assert.throws(() => f.monitor.heartbeat(sitting.id, 'outsider'), /eligible/);
  assert.throws(() => f.monitor.snapshot('unknown'), /not found/i);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM candidate_presence').get()?.n, 0);
});

test('presence has referential integrity and preserves existing examination state', (t) => {
  const f = fixture(t);
  const sitting = f.store.launch(f.exam.id, 'admin');
  const attempt = f.store.start(sitting.id, 'one');
  assert.equal(f.db.prepare('PRAGMA user_version').get()?.user_version, 21);
  assert.deepEqual(f.store.findAttempt(sitting.id, 'one'), attempt);
  assert.throws(() =>
    f.db.prepare('INSERT INTO candidate_presence VALUES(?,?,?,?)').run('missing', 'one', 0, 0),
  );
  assert.equal(f.db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
});

test('v10 database upgrade preserves attempts; presence survives a real database reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mudu-monitor-'));
  const path = join(directory, 'test.sqlite');
  let db = openDatabase(path);
  try {
    let now = 1000000;
    let store = new ExamStore(db, () => now);
    const exam = assessment();
    store.createAssessment(
      exam,
      [{ id: 'one', identifier: '001', name: 'Ada', hash: 'test' }],
      'admin',
    );
    const sitting = store.launch(exam.id, 'admin');
    const attempt = store.start(sitting.id, 'one');
    db.exec(
      'DROP TABLE workspace_connections; DROP TABLE account_preferences; DROP TABLE admin_device_sessions; DROP TABLE admin_device_access; DROP TABLE password_recovery; DROP TABLE offline_candidate_sessions; DROP TABLE local_admission; DROP TABLE local_preparations; DROP TABLE authoring_drafts; DROP TABLE candidate_provider_identities; DROP TABLE cloud_sync_jobs; DROP TABLE cloud_instance; DROP TABLE provider_sessions; DROP TABLE admin_provider_identities; DROP TABLE assessment_owners; DROP TABLE exam_control_receipts; DROP TABLE announcement_reads; DROP TABLE exam_announcements; DROP TABLE exam_controls; DROP TABLE candidate_presence; PRAGMA user_version=10;',
    );
    db.close();
    db = openDatabase(path);
    store = new ExamStore(db, () => now);
    const monitor = new LiveMonitoring(store);
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 21);
    assert.deepEqual(store.findAttempt(sitting.id, 'one'), attempt);
    monitor.heartbeat(sitting.id, 'one');
    now += disconnectAfterMs;
    assert.equal(monitor.snapshot(exam.id).candidates[0].status, 'disconnected');
    monitor.heartbeat(sitting.id, 'one');
    db.close();
    db = openDatabase(path);
    const restored = new LiveMonitoring(new ExamStore(db, () => now)).snapshot(exam.id)
      .candidates[0];
    assert.equal(restored.status, 'active');
    assert.equal(restored.lastSeenAt, now);
    assert.equal(restored.reconnects, 1);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  } finally {
    db.close();
    // Only files inside this explicitly created test directory are removed.
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  }
});

test('written-answer progress treats whitespace-only text as unanswered', (t) => {
  const f = fixture(t);
  const q = {
    id: 'essay',
    type: 'short' as const,
    prompt: 'Explain',
    marks: 2,
    options: [],
    correctOptionIds: [],
  };
  f.exam.questions.push(q);
  f.db
    .prepare('UPDATE assessments SET definition=? WHERE id=?')
    .run(JSON.stringify(f.exam), f.exam.id);
  const sitting = f.store.launch(f.exam.id, 'admin');
  f.store.start(sitting.id, 'one');
  f.store.save(sitting.id, 'one', q.id, {
    value: '\n\t\u00a0\u2003',
    expectedRevision: 0,
    operationId: 'essay-blank',
  });
  assert.equal(f.monitor.snapshot(f.exam.id).candidates[0].answered, 0);
  f.store.save(sitting.id, 'one', q.id, {
    value: ' My explanation ',
    expectedRevision: 1,
    operationId: 'essay-text',
  });
  assert.equal(f.monitor.snapshot(f.exam.id).candidates[0].answered, 1);
});

test('monitor filters are case-insensitive, prioritise attention, and do not mutate snapshots', () => {
  const base: MonitoredCandidate = {
    id: 'a',
    name: 'Ada',
    identifier: '001',
    status: 'active',
    answered: 0,
    lastSeenAt: null,
    lastSavedAt: null,
    startedAt: null,
    submittedAt: null,
    reconnects: 0,
  };
  const rows = [
    base,
    { ...base, id: 'b', name: 'Ben', identifier: '002', status: 'disconnected' as const },
    { ...base, id: 'c', name: 'Chris', identifier: '003', status: 'waiting' as const },
  ];
  assert.deepEqual(
    monitorCandidates(rows, 'all', '').map((c) => c.id),
    ['b', 'c', 'a'],
  );
  assert.deepEqual(
    rows.map((c) => c.id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    monitorCandidates(rows, 'all', ' BEN ').map((c) => c.id),
    ['b'],
  );
  assert.equal(monitorCandidates(rows, 'active', '002').length, 0);
  assert.equal(monitorCandidates(rows, 'waiting', '003').length, 1);
  assert.equal(contactAge(null, 100000), 'No contact yet');
  assert.equal(contactAge(0, 45000), '45s ago');
  assert.equal(contactAge(0, 120000), '2m ago');
  assert.equal(contactAge(1000, 0), 'Just now');
});
