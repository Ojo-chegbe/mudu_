import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../apps/host/database.ts';
import { ExamStore } from '../apps/host/store.ts';
import { QuestionBank } from '../apps/host/question-bank.ts';
import { QuestionGeneration } from '../apps/host/question-generation.ts';
import { emptyBankContent } from '../packages/contracts/question-bank.ts';

function setup() {
  const db = openDatabase(':memory:');
  const store = new ExamStore(db);
  const bank = new QuestionBank(store);
  const make = (owner = 'admin', name = 'Biology · Cells') =>
    bank.saveProject(owner, {
      id: randomUUID(),
      name,
      course: 'Biology',
      description: 'Cell structures',
      archived: false,
      expectedRevision: 0,
    });
  return { db, store, bank, make };
}
function question(projectId: string, status = 'draft') {
  return {
    ...emptyBankContent(),
    projectId,
    id: randomUUID(),
    status,
    expectedRevision: 0,
    course: 'Biology',
    question: {
      type: 'single',
      prompt: 'Where is genetic material stored?',
      marks: 1,
      options: ['Nucleus', 'Cell wall'],
      correctIndices: [0],
    },
    explanation: 'The nucleus stores genetic material.',
  };
}
function generation(projectId: string) {
  return {
    projectId,
    requestId: randomUUID(),
    source:
      'The nucleus stores genetic material. The cell wall supports the cell. These notes describe cell structures for introductory biology.',
    course: 'Biology',
    topic: 'Cells',
    type: 'single',
    difficulty: 'medium',
    count: 1,
    consent: true,
  };
}
const output = () =>
  JSON.stringify({
    questions: [
      { question: question('').question, explanation: 'The nucleus stores genetic material.' },
    ],
  });

test('bulk approval saves inline edits atomically and requires lecturer review', (t) => {
  const { db, bank, make } = setup();
  t.after(() => db.close());
  const p = make(),
    a = bank.save('admin', question(p.id)),
    b = bank.save('admin', question(p.id));
  const selection = [
    { id: a.id, revision: 1, content: { ...a, question: { ...a.question, marks: 4 } } },
    { id: b.id, revision: 1 },
  ];
  assert.throws(() => bank.reviewSelection('admin', { action: 'approve', selection }), /Confirm/);
  assert.throws(
    () =>
      bank.reviewSelection('admin', {
        action: 'approve',
        reviewed: true,
        selection: [
          selection[0],
          {
            id: b.id,
            revision: 1,
            content: { ...b, question: { ...b.question, correctIndices: [] } },
          },
        ],
      }),
    /correct answers/,
  );
  assert.equal(bank.get(a.id, 'admin').status, 'draft');
  assert.equal(bank.get(a.id, 'admin').question.marks, 1);
  assert.equal(
    bank.reviewSelection('admin', { action: 'approve', reviewed: true, selection }).count,
    2,
  );
  assert.equal(bank.get(a.id, 'admin').question.marks, 4);
  assert.equal(bank.get(a.id, 'admin').revision, 2);
  assert.equal(bank.get(b.id, 'admin').status, 'approved');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_revisions').get()?.n, 4);
});

test('bulk deletion rejects foreign and stale selections and never alters assessment copies', (t) => {
  const { db, bank, make } = setup();
  t.after(() => db.close());
  const p = make(),
    foreign = make('other');
  const a = bank.save('admin', question(p.id, 'approved')),
    b = bank.save('other', question(foreign.id));
  const copy = bank.select('admin', [{ id: a.id, revision: 1 }]);
  assert.throws(
    () =>
      bank.reviewSelection('admin', {
        action: 'delete',
        selection: [
          { id: a.id, revision: 1 },
          { id: b.id, revision: 1 },
        ],
      }),
    /not found/,
  );
  assert.equal(bank.get(a.id, 'admin').status, 'approved');
  assert.throws(
    () =>
      bank.reviewSelection('admin', { action: 'delete', selection: [{ id: a.id, revision: 0 }] }),
    /changed/,
  );
  const request = { action: 'delete', selection: [{ id: a.id, revision: 1 }] };
  assert.equal(bank.reviewSelection('admin', request).count, 1);
  assert.equal(bank.reviewSelection('admin', request).count, 1, 'deletion retries are idempotent');
  assert.throws(() => bank.get(a.id, 'admin'), /not found/);
  assert.throws(() => bank.save('admin', { ...a, expectedRevision: 1 }), /not found/);
  assert.throws(() => bank.select('admin', [{ id: a.id, revision: 1 }]), /not found/);
  assert.equal(
    bank.list('admin', new URLSearchParams({ projectId: p.id, status: 'all' })).total,
    0,
  );
  assert.deepEqual(bank.project('admin', p.id).counts, { draft: 0, approved: 0, archived: 0 });
  assert.deepEqual(copy, [a.question]);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM events WHERE kind='bank_question_deleted'").get()?.n,
    1,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM bank_revisions WHERE question_id=?').get(a.id)?.n,
    1,
    'audit history remains available',
  );
});

test('deleted generated questions stay absent when a completed generation is restored', async (t) => {
  const { db, bank, store, make } = setup();
  t.after(() => db.close());
  const p = make(),
    ai = new QuestionGeneration(store, async () => output(), 'test-key');
  const input = generation(p.id),
    job = await ai.generate('admin', input);
  const item = bank.get(job.questionIds[0], 'admin');
  bank.reviewSelection('admin', {
    action: 'delete',
    selection: [{ id: item.id, revision: item.revision }],
  });
  assert.deepEqual(ai.job(input.requestId, 'admin').questionIds, []);
  assert.equal(ai.job(input.requestId, 'admin').status, 'completed');
  assert.deepEqual((await ai.generate('admin', input)).questionIds, []);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_generations').get()?.n, 1);
});

test('the default collection includes drafts and approved questions while keeping archived separate', (t) => {
  const { db, bank, make } = setup();
  t.after(() => db.close());
  const p = make();
  bank.save('admin', question(p.id));
  bank.save('admin', question(p.id, 'approved'));
  const archived = bank.save('admin', question(p.id));
  bank.save('admin', { ...archived, status: 'archived', expectedRevision: 1 });
  const page = bank.list(
    'admin',
    new URLSearchParams({ projectId: p.id, status: 'all', activeOnly: '1' }),
  );
  assert.equal(page.total, 2);
  assert.equal(page.counts.archived, 1);
  assert.ok(page.items.every((item) => item.status !== 'archived'));
});

test('project settings are owner-scoped, idempotent and protected against stale edits', (t) => {
  const { db, bank, make } = setup();
  t.after(() => db.close());
  const p = make();
  assert.deepEqual(bank.saveProject('admin', { ...p, expectedRevision: 0 }), p);
  assert.throws(() => bank.project('other', p.id), /not found/);
  assert.throws(
    () => bank.saveProject('other', { ...p, name: 'Takeover', expectedRevision: p.revision }),
    /not found/,
  );
  const renamed = bank.saveProject('admin', {
    ...p,
    name: 'Midterm',
    expectedRevision: p.revision,
  });
  assert.equal(renamed.revision, 2);
  assert.throws(
    () => bank.saveProject('admin', { ...p, name: 'Stale edit', expectedRevision: p.revision }),
    /another window/,
  );
  assert.throws(
    () => bank.saveProject('admin', { ...renamed, name: ' ', expectedRevision: 2 }),
    /Project name/,
  );
  assert.equal(bank.projects('other', new URLSearchParams()).total, 0);
  assert.equal(bank.projects('admin', new URLSearchParams('q=Midterm')).total, 1);
});

test('questions require an owned project and lists, filters and counts stay inside it', (t) => {
  const { db, bank, make } = setup();
  t.after(() => db.close());
  const a = make(),
    b = make('admin', 'Other topic'),
    foreign = make('other');
  const approved = bank.save('admin', question(a.id, 'approved'));
  bank.save('admin', question(a.id));
  bank.save('admin', question(b.id, 'approved'));
  const params = new URLSearchParams({ projectId: a.id, status: 'all' });
  const page = bank.list('admin', params);
  assert.equal(page.total, 2);
  assert.deepEqual(page.counts, { draft: 1, approved: 1, archived: 0 });
  assert.ok(page.items.every((item) => item.projectId === a.id));
  assert.deepEqual(bank.project('admin', a.id).counts, page.counts);
  assert.throws(() => bank.list('other', params), /not found/);
  assert.throws(() => bank.save('admin', question(foreign.id)), /not found/);
  const missing = { ...question(a.id), projectId: undefined };
  assert.throws(() => bank.save('admin', missing));
  assert.throws(
    () => bank.save('admin', { ...approved, projectId: b.id, expectedRevision: 1 }),
    /cannot be moved/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_questions').get()?.n, 3);
});

test('archiving a project hides it from selection and authoring while preserving saved copies', async (t) => {
  const { db, bank, store, make } = setup();
  t.after(() => db.close());
  const p = make();
  const item = bank.save('admin', question(p.id, 'approved'));
  const copied = bank.select('admin', [{ id: item.id, revision: 1 }]);
  const archived = bank.saveProject('admin', { ...p, archived: true, expectedRevision: 1 });
  assert.equal(bank.projects('admin', new URLSearchParams()).total, 0);
  assert.equal(bank.projects('admin', new URLSearchParams('status=archived')).total, 1);
  assert.throws(() => bank.select('admin', [{ id: item.id, revision: 1 }]), /archived/);
  assert.throws(() => bank.save('admin', question(p.id)), /archived/);
  let calls = 0;
  const ai = new QuestionGeneration(
    store,
    async () => {
      calls++;
      return output();
    },
    'test-key',
  );
  await assert.rejects(ai.generate('admin', generation(p.id)), /archived/);
  assert.equal(calls, 0);
  assert.deepEqual(copied, [item.question]);
  bank.saveProject('admin', { ...archived, archived: false, expectedRevision: archived.revision });
  assert.deepEqual(bank.select('admin', [{ id: item.id, revision: 1 }]), copied);
});

test('bulk moves are atomic, retain approval and history, and invalidate stale selections', (t) => {
  const { db, bank, make } = setup();
  t.after(() => db.close());
  const a = make(),
    b = make('admin', 'Midterm'),
    foreign = make('other');
  const first = bank.save('admin', question(a.id, 'approved')),
    second = bank.save('admin', question(a.id));
  const copy = bank.select('admin', [{ id: first.id, revision: 1 }]);
  assert.throws(
    () => bank.move('admin', { projectId: foreign.id, selection: [{ id: first.id, revision: 1 }] }),
    /not found/,
  );
  assert.throws(
    () =>
      bank.move('admin', {
        projectId: b.id,
        selection: [
          { id: first.id, revision: 1 },
          { id: second.id, revision: 99 },
        ],
      }),
    /changed/,
  );
  assert.equal(bank.get(first.id, 'admin').projectId, a.id);
  assert.equal(
    bank.move('admin', {
      projectId: b.id,
      selection: [
        { id: first.id, revision: 1 },
        { id: second.id, revision: 1 },
      ],
    }).moved,
    2,
  );
  assert.equal(bank.get(first.id, 'admin').status, 'approved');
  assert.equal(bank.get(second.id, 'admin').status, 'draft');
  assert.equal(bank.get(first.id, 'admin').revision, 2);
  assert.equal(bank.get(first.id, 'admin').projectId, b.id);
  assert.equal(bank.project('admin', a.id).counts.approved, 0);
  assert.equal(bank.project('admin', b.id).counts.approved, 1);
  assert.throws(() => bank.select('admin', [{ id: first.id, revision: 1 }]), /changed/);
  assert.deepEqual(bank.select('admin', [{ id: first.id, revision: 2 }]), copy);
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM bank_revisions WHERE question_id=?').get(first.id)?.n,
    2,
  );
});

test('AI generation is scoped and cannot commit into a project archived during generation', async (t) => {
  const { db, bank, store, make } = setup();
  t.after(() => db.close());
  const a = make(),
    b = make('admin', 'Midterm'),
    foreign = make('other');
  const ai = new QuestionGeneration(store, async () => output(), 'test-key');
  const input = generation(a.id);
  const result = await ai.generate('admin', input);
  assert.equal(bank.get(result.questionIds[0], 'admin').projectId, a.id);
  assert.equal(bank.get(result.questionIds[0], 'admin').status, 'draft');
  await assert.rejects(
    ai.generate('admin', { ...input, projectId: b.id }),
    /different notes or settings/,
  );
  await assert.rejects(ai.generate('admin', generation(foreign.id)), /not found/);
  let release!: (value: string) => void;
  const delayed = new QuestionGeneration(
    store,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    'test-key',
  );
  const pending = delayed.generate('admin', generation(b.id));
  bank.saveProject('admin', { ...b, archived: true, expectedRevision: 1 });
  release(output());
  await assert.rejects(pending, /archived/);
  assert.equal(bank.project('admin', b.id).counts.draft, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_questions').get()?.n, 1);
});

test('v8 migration preserves IDs, revisions, approval and ownership in separate imported projects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mudu-project-migration-'));
  const path = join(dir, 'host.sqlite');
  let db = openDatabase(path);
  try {
    let bank = new QuestionBank(new ExamStore(db));
    const a = bank.saveProject('admin', {
      id: randomUUID(),
      name: 'Old',
      archived: false,
      expectedRevision: 0,
    });
    const b = bank.saveProject('other', {
      id: randomUUID(),
      name: 'Other',
      archived: false,
      expectedRevision: 0,
    });
    const first = bank.save('admin', question(a.id, 'approved')),
      second = bank.save('other', question(b.id));
    db.exec(
      'DROP TABLE workspace_connections; DROP TABLE account_preferences; DROP TABLE admin_device_sessions; DROP TABLE admin_device_access; DROP TABLE password_recovery; DROP TABLE offline_candidate_sessions; DROP TABLE local_admission; DROP TABLE local_preparations; DROP TABLE authoring_drafts; DROP TABLE candidate_provider_identities; DROP TABLE cloud_sync_jobs; DROP TABLE cloud_instance; DROP TABLE provider_sessions; DROP TABLE admin_provider_identities; DROP TABLE assessment_owners; DROP TABLE exam_control_receipts; DROP TABLE announcement_reads; DROP TABLE exam_announcements; DROP TABLE exam_controls; DROP TABLE candidate_presence; DROP TABLE bank_deleted_questions; DROP TABLE bank_question_projects; DROP TABLE bank_projects; PRAGMA user_version=8;',
    );
    db.close();
    db = openDatabase(path);
    bank = new QuestionBank(new ExamStore(db));
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 21);
    const imported = bank.projects('admin', new URLSearchParams()).items;
    assert.equal(imported.length, 1);
    assert.equal(imported[0].name, 'Imported questions');
    assert.equal(imported[0].counts.approved, 1);
    const migrated = bank.get(first.id, 'admin');
    assert.deepEqual({ ...migrated, projectId: first.projectId }, first);
    assert.notEqual(migrated.projectId, bank.get(second.id, 'other').projectId);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_revisions').get()?.n, 2);
    const backup = new DatabaseSync(`${path}.before-v9`, { readOnly: true });
    assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 8);
    backup.close();
    db.close();
    db = openDatabase(path);
    assert.deepEqual(new QuestionBank(new ExamStore(db)).get(first.id, 'admin'), migrated);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    const latestBank = new QuestionBank(new ExamStore(db));
    latestBank.reviewSelection('admin', {
      action: 'delete',
      selection: [{ id: first.id, revision: first.revision }],
    });
    db.close();
    db = openDatabase(path);
    assert.throws(() => new QuestionBank(new ExamStore(db)).get(first.id, 'admin'), /not found/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_deleted_questions').get()?.n, 1);
  } finally {
    db.close();
    for (const name of readdirSync(dir)) unlinkSync(join(dir, name));
    rmdirSync(dir);
  }
});
