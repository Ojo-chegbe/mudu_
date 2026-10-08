import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../apps/host/database.ts';
import { ExamStore } from '../apps/host/store.ts';
import { IdentityService } from '../apps/host/identity.ts';
import { assessment } from './fixtures.ts';

test('v12 workspace migration preserves the Host password, sessions and creation references', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mudu-workspace-migration-'));
  const path = join(directory, 'exam.sqlite');
  let db = openDatabase(path);
  try {
    const store = new ExamStore(db);
    db.prepare('INSERT INTO administrators VALUES(?,?,?,1)').run(
      'host',
      'Original',
      'original-verifier',
    );
    const exam = assessment();
    store.createAssessment(exam, [], 'host');
    db.prepare('INSERT INTO assessment_creations VALUES(?,?,?)').run(
      'host',
      'original-request',
      exam.id,
    );
    const session = store.createSession('admin', 'host', null);
    db.exec(`PRAGMA foreign_keys=OFF;
      DROP TABLE workspace_connections; DROP TABLE account_preferences; DROP TABLE admin_device_sessions; DROP TABLE admin_device_access; DROP TABLE password_recovery; DROP TABLE offline_candidate_sessions; DROP TABLE local_admission; DROP TABLE local_preparations; DROP TABLE authoring_drafts; DROP TABLE candidate_provider_identities; DROP TABLE cloud_sync_jobs; DROP TABLE cloud_instance; DROP TABLE provider_sessions; DROP TABLE admin_provider_identities; DROP TABLE assessment_owners;
      CREATE TABLE administrators_v12 (id TEXT PRIMARY KEY,name TEXT NOT NULL,password_hash TEXT NOT NULL,
        singleton INTEGER NOT NULL UNIQUE CHECK(singleton=1)) STRICT;
      INSERT INTO administrators_v12 SELECT * FROM administrators;
      DROP TABLE administrators; ALTER TABLE administrators_v12 RENAME TO administrators;
      PRAGMA user_version=12; PRAGMA foreign_keys=ON;`);
    db.close();
    db = openDatabase(path);
    const migrated = new ExamStore(db);
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 21);
    assert.equal(
      db.prepare('SELECT password_hash FROM administrators WHERE id=?').get('host')!.password_hash,
      'original-verifier',
    );
    assert.equal(migrated.session(session.raw)!.principal_id, 'host');
    assert.doesNotThrow(() => migrated.assertOwner(exam.id, 'host'));
    assert.throws(() => migrated.assertOwner(exam.id, 'another-admin'), /not found/);
    assert.equal(db.prepare('SELECT admin_id FROM assessment_creations').get()!.admin_id, 'host');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.ok(existsSync(`${path}.before-v13`));
    db.prepare('INSERT INTO administrators VALUES(?,?,?,NULL)').run(
      'cloud',
      'Cloud',
      'supabase-managed',
    );
    assert.throws(() =>
      db.prepare('INSERT INTO administrators VALUES(?,?,?,1)').run('second-host', 'Other', 'test'),
    );
  } finally {
    db.close();
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  }
});

test('v1 migration backs up and preserves existing attempts, responses, credentials, and sessions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mudu-migration-'));
  const path = join(directory, 'exam.sqlite');
  let db = openDatabase(path);
  try {
    let store = new ExamStore(db, () => 1000000);
    const exam = assessment();
    store.createAssessment(
      exam,
      [
        {
          id: 'legacy-student',
          identifier: 'MUD/001',
          name: 'Existing Student',
          hash: 'existing-password-verifier',
        },
      ],
      'admin',
    );
    const sitting = store.launch(exam.id, 'admin');
    const attempt = store.start(sitting.id, 'legacy-student');
    const oldSession = store.createSession('candidate', 'legacy-student', sitting.id);
    const question = exam.questions[0];
    store.save(sitting.id, 'legacy-student', question.id, {
      value: question.correctOptionIds,
      expectedRevision: 0,
      operationId: 'pre-migration-answer',
    });
    // Reconstruct the previous schema in this isolated fixture, retaining all
    // pre-existing exam rows. No real workspace database is touched by this test.
    db.exec(`DROP TABLE workspace_connections; DROP TABLE account_preferences; DROP TABLE admin_device_sessions; DROP TABLE admin_device_access; DROP TABLE password_recovery; DROP TABLE offline_candidate_sessions; DROP TABLE local_admission; DROP TABLE local_preparations; DROP TABLE authoring_drafts; DROP TABLE candidate_provider_identities; DROP TABLE cloud_sync_jobs; DROP TABLE cloud_instance; DROP TABLE provider_sessions; DROP TABLE admin_provider_identities; DROP TABLE assessment_owners; DROP TABLE exam_control_receipts; DROP TABLE announcement_reads; DROP TABLE exam_announcements; DROP TABLE exam_controls; DROP TABLE candidate_presence; DROP TABLE bank_deleted_questions; DROP TABLE bank_question_projects; DROP TABLE bank_projects; DROP TABLE bank_revisions; DROP TABLE bank_questions; DROP TABLE bank_generations;
      DROP TABLE roster_enrolment_invites; DROP TABLE application_numbers;
      DROP TABLE registrations; DROP TABLE registration_settings; DROP TABLE memberships;
      DROP INDEX sessions_account; ALTER TABLE sessions DROP COLUMN account_id;
      DROP TABLE roster_members; DROP TABLE roster_entries; DROP TABLE assessment_rosters; DROP TABLE rosters;
      DROP TABLE accounts; DROP TABLE organizations; DROP TABLE assessment_creations; DROP TABLE manual_marks; DROP TABLE notifications; PRAGMA user_version=1;`);
    db.close();
    db = openDatabase(path);
    store = new ExamStore(db, () => 1001000);
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 21);
    assert.deepEqual(store.findAttempt(sitting.id, 'legacy-student'), attempt);
    assert.deepEqual(store.responses(attempt.id)[question.id].value, question.correctOptionIds);
    assert.equal(
      db.prepare('SELECT credential_hash FROM candidates').get()?.credential_hash,
      'existing-password-verifier',
    );
    assert.ok(store.session(oldSession.raw));
    assert.equal(new IdentityService(store).settings(exam.id).mode, 'legacy');
    assert.ok(existsSync(`${path}.before-v2`));
    const backup = new DatabaseSync(`${path}.before-v2`, { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 1);
      assert.equal(backup.prepare('SELECT COUNT(*) AS total FROM responses').get()?.total, 1);
    } finally {
      backup.close();
    }
    db.close();
    db = openDatabase(path);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM registration_settings').get()?.total, 1);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  } finally {
    db.close();
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  }
});

test('accounts and registrations keep their canonical IDs across a database restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mudu-account-restart-'));
  const path = join(directory, 'exam.sqlite');
  let db = openDatabase(path);
  try {
    let store = new ExamStore(db);
    let identity = new IdentityService(store);
    const session = identity.createAccount({
      email: 'test@example.test',
      name: 'Test Candidate',
      identifier: 'MUD/001',
      hash: 'test-verifier',
    });
    const accountId = store.session(session.raw)!.account_id!;
    const exam = assessment();
    store.createAssessment(exam, [], 'admin', {
      mode: 'accounts',
      policy: 'approval',
      closesAt: null,
      capacity: 100,
    });
    const link = identity.settings(exam.id).token;
    identity.register(link, accountId);
    const requestId = identity.requests(exam.id)[0].id;
    identity.review(exam.id, requestId, 'approved', true, 'admin');
    db.close();
    db = openDatabase(path);
    store = new ExamStore(db);
    identity = new IdentityService(store);
    assert.equal(identity.profile(accountId).id, accountId);
    assert.equal(identity.settings(exam.id).token, link);
    assert.equal(identity.requests(exam.id)[0].id, requestId);
    assert.equal(identity.examinations(accountId)[0].registrationStatus, 'approved');
    assert.equal(store.session(session.raw)?.account_id, accountId);
  } finally {
    db.close();
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  }
});

test('v6 upgrade backs up data and assigns stable application references without changing accounts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mudu-enrolment-migration-'));
  const path = join(directory, 'exam.sqlite');
  let db = openDatabase(path);
  try {
    const store = new ExamStore(db);
    const identity = new IdentityService(store);
    const session = identity.createAccount({
      email: 'existing@example.test',
      name: 'Existing',
      identifier: '001',
      hash: 'unchanged-password-verifier',
    });
    const accountId = store.session(session.raw)!.account_id!;
    const exam = assessment();
    store.createAssessment(exam, [], 'admin', {
      mode: 'accounts',
      policy: 'approval',
      capacity: 500,
      closesAt: null,
    });
    identity.register(identity.settings(exam.id).token, accountId);
    const requestId = identity.requests(exam.id)[0].id;
    db.exec(
      'DROP TABLE workspace_connections; DROP TABLE account_preferences; DROP TABLE admin_device_sessions; DROP TABLE admin_device_access; DROP TABLE password_recovery; DROP TABLE offline_candidate_sessions; DROP TABLE local_admission; DROP TABLE local_preparations; DROP TABLE authoring_drafts; DROP TABLE candidate_provider_identities; DROP TABLE cloud_sync_jobs; DROP TABLE cloud_instance; DROP TABLE provider_sessions; DROP TABLE admin_provider_identities; DROP TABLE assessment_owners; DROP TABLE exam_control_receipts; DROP TABLE announcement_reads; DROP TABLE exam_announcements; DROP TABLE exam_controls; DROP TABLE candidate_presence; DROP TABLE bank_deleted_questions; DROP TABLE bank_question_projects; DROP TABLE bank_projects; DROP TABLE bank_revisions; DROP TABLE bank_questions; DROP TABLE bank_generations; DROP TRIGGER registration_application_number; DROP TABLE application_numbers; DROP TABLE roster_enrolment_invites; PRAGMA user_version=6;',
    );
    db.close();
    db = openDatabase(path);
    const migrated = new IdentityService(new ExamStore(db));
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 21);
    assert.equal(migrated.profile(accountId).identifier, '001');
    assert.equal(
      db.prepare('SELECT password_hash FROM accounts WHERE id=?').get(accountId)?.password_hash,
      'unchanged-password-verifier',
    );
    assert.equal(migrated.requests(exam.id)[0].id, requestId);
    assert.equal(migrated.requests(exam.id)[0].applicationNumber, 'APP-000001');
    const backup = new DatabaseSync(`${path}.before-v7`, { readOnly: true });
    assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 6);
    backup.close();
    db.close();
    db = openDatabase(path);
    assert.equal(
      new IdentityService(new ExamStore(db)).requests(exam.id)[0].applicationNumber,
      'APP-000001',
    );
  } finally {
    db.close();
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  }
});
