import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../apps/host/database.ts';
import { ExamStore } from '../apps/host/store.ts';
import { IdentityService } from '../apps/host/identity.ts';
import { Rosters } from '../apps/host/rosters.ts';
import { assessment } from './fixtures.ts';

test('approved roster additions are admitted automatically while existing attempts and enrolments remain independent', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const store = new ExamStore(db, () => 1000000);
  const identity = new IdentityService(store);
  const rosters = new Rosters(store);
  function account(email: string, number: string) {
    const s = identity.createAccount({ email, name: email, identifier: number, hash: 'test' });
    return store.session(s.raw)!.account_id!;
  }
  const a = account('a@example.test', 'M/1');
  const impostor = account('b@example.test', 'M/1');
  const b = account('c@example.test', 'M/2');
  const id = randomUUID();
  const input = {
    name: 'Class of 2026',
    revision: 0,
    restricted: false,
    open: true,
    archived: false,
    entries: [],
  };
  const roster = rosters.save(id, 'admin', input);
  assert.throws(() => rosters.get(id, 'another-admin'), /not found/);
  assert.throws(() => rosters.save(id, 'admin', input), /changed/);
  assert.equal(rosters.invitation(roster.token).status, null);
  assert.doesNotMatch(JSON.stringify(rosters.invitation(roster.token)), /example.test|M\/1/);
  assert.equal(rosters.join(roster.token, a).status, 'pending');
  assert.equal(rosters.join(roster.token, a).status, 'pending');
  assert.equal(rosters.get(id, 'admin').members.length, 1);
  assert.throws(() => rosters.snapshot(id, 'admin', 1), /Approve/);
  rosters.review(id, 'admin', a, { decision: 'approved' });
  rosters.join(roster.token, impostor);
  assert.deepEqual(
    rosters.get(id, 'admin').members.map((m) => m.status),
    ['pending', 'approved'],
  );
  assert.throws(
    () => rosters.review(id, 'admin', impostor, { decision: 'approved', identityVerified: true }),
    /another verified/,
  );
  assert.throws(() => rosters.snapshot(id, 'admin', 1), /changed/);
  const snapshot = rosters.snapshot(id, 'admin', 2);
  const exam = assessment();
  store.createAssessment(
    exam,
    snapshot.candidates.map((c) => ({ ...c, id: randomUUID(), hash: 'account-managed' })),
    'admin',
    { mode: 'accounts', policy: 'roster', capacity: 500, closesAt: null },
    undefined,
    snapshot.roster,
  );
  assert.equal(store.detail(exam.id).candidates.length, 1);
  assert.equal(identity.settings(exam.id).open, false);
  assert.equal(identity.examinations(a).length, 1);
  rosters.join(roster.token, b);
  rosters.review(id, 'admin', b, { decision: 'approved', identityVerified: true });
  assert.equal(store.detail(exam.id).candidates.length, 2);
  assert.equal(identity.examinations(b).length, 1);
  const additions = rosters.additions(exam.id, 'admin');
  assert.equal(additions.additions.length, 0);
  assert.throws(() => rosters.additions(exam.id, 'admin', true, 2), /changed/);
  rosters.additions(exam.id, 'admin', true, additions.currentRevision);
  assert.equal(identity.examinations(b).length, 1);
  rosters.additions(exam.id, 'admin', true, additions.currentRevision);
  assert.equal(store.detail(exam.id).candidates.length, 2);
  rosters.review(id, 'admin', a, { decision: 'removed' });
  assert.equal(store.detail(exam.id).candidates.length, 2);
  store.launch(exam.id, 'admin');
  assert.throws(
    () => rosters.additions(exam.id, 'admin', true, rosters.get(id, 'admin').revision),
    /Admission is closed/,
  );
  const latest = rosters.get(id, 'admin');
  rosters.save(id, 'admin', { ...input, revision: latest.revision, archived: true });
  assert.equal(rosters.invitation(roster.token).accepting, false);
  assert.throws(() => rosters.snapshot(id, 'admin', latest.revision + 1), /active roster/);
  assert.equal(identity.examinations(a).length, 1);
});

test('expected lists reject duplicates and outsiders without verifying or enrolling anyone', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const store = new ExamStore(db);
  const rosters = new Rosters(store);
  const identity = new IdentityService(store);
  const id = randomUUID();
  const input = {
    name: 'Restricted class',
    revision: 0,
    restricted: true,
    open: true,
    archived: false,
    entries: [{ identifier: 'm/1', name: 'Expected student' }],
  };
  assert.throws(
    () =>
      rosters.save(id, 'admin', {
        ...input,
        entries: [...input.entries, { identifier: 'M/1', name: 'Duplicate' }],
      }),
    /unique/,
  );
  const roster = rosters.save(id, 'admin', input);
  assert.equal(roster.entries[0].identifier, 'M/1');
  assert.equal(roster.approved, 0);
  const s = identity.createAccount({
    email: 'outside@example.test',
    identifier: 'M/2',
    name: 'Outside',
    hash: 'test',
  });
  const account = store.session(s.raw)!.account_id!;
  assert.throws(() => rosters.join(roster.token, account), /not on this roster/);
  assert.equal(identity.profile(account).identityStatus, 'pending');
  rosters.save(id, 'admin', { ...input, revision: 1, open: false });
  assert.throws(() => rosters.join(roster.token, account), /closed/);
});
