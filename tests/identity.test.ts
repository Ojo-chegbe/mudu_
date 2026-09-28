import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../apps/host/database.ts';
import { ExamStore } from '../apps/host/store.ts';
import { IdentityService, accountPassword, registrationConfig } from '../apps/host/identity.ts';
import { assessment } from './fixtures.ts';

function fixture() {
  let now = 1000000;
  const db = openDatabase(':memory:');
  const store = new ExamStore(db, () => now);
  const identity = new IdentityService(store);
  function account(email = 'candidate@example.test', number = 'MUD/001') {
    const session = identity.createAccount({
      name: 'Candidate',
      email,
      identifier: number,
      hash: 'test-only-verifier',
    });
    return { id: store.session(session.raw)!.account_id!, ...session };
  }
  function exam(
    policy: 'approval' | 'roster' = 'approval',
    roster: Array<{ identifier: string; name: string }> = [],
    capacity = 500,
  ) {
    const definition = assessment();
    store.createAssessment(
      definition,
      roster.map((c, index) => ({
        ...c,
        id: `${definition.id}-c${index}`,
        hash: 'account-managed',
      })),
      'admin',
      { mode: 'accounts', policy, closesAt: null, capacity },
    );
    return { id: definition.id, token: identity.settings(definition.id).token, definition };
  }
  function approve(examId: string, accountId: string) {
    const id = String(
      db
        .prepare('SELECT id FROM registrations WHERE assessment_id=? AND account_id=?')
        .get(examId, accountId)?.id,
    );
    return identity.review(examId, id, 'approved', true, 'admin');
  }
  return {
    db,
    store,
    identity,
    account,
    exam,
    approve,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('one canonical account registers for multiple exams without another password or identity', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const person = f.account();
  const first = f.exam();
  const second = f.exam();
  f.identity.register(first.token, person.id);
  f.identity.register(second.token, person.id);
  f.approve(first.id, person.id);
  f.approve(second.id, person.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM accounts').get()?.count, 1);
  assert.equal(f.identity.examinations(person.id).length, 2);
  assert.equal(f.identity.profile(person.id).identityStatus, 'verified');
  assert.equal(f.identity.findLogin('candidate@example.test')?.id, person.id);
  assert.equal(f.identity.findLogin('mud/001'), undefined);
});
test('repeated registration is idempotent, including after closing registration', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const person = f.account();
  const exam = f.exam();
  assert.deepEqual(f.identity.register(exam.token, person.id), { status: 'pending' });
  f.identity.updateSettings(exam.id, { open: false }, 'admin');
  assert.deepEqual(f.identity.register(exam.token, person.id), { status: 'pending' });
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM registrations').get()?.count, 1);
  const other = f.account('other@example.test', 'MUD/002');
  assert.throws(() => f.identity.register(exam.token, other.id), /closed/);
});
test('guessing a roster number never auto-verifies a new account or admits it', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const person = f.account();
  const exam = f.exam('roster', [{ identifier: 'MUD/001', name: 'Real Student' }]);
  f.identity.register(exam.token, person.id);
  const registration = f.identity.requests(exam.id)[0];
  assert.equal(registration.status, 'pending');
  assert.equal(registration.rosterName, 'Real Student');
  assert.equal(f.identity.findLogin('MUD/001'), undefined);
  assert.throws(() => f.identity.authorizeExam(person.id, exam.id), /not approved/);
  assert.throws(() => f.store.launch(exam.id, 'admin'), /Approve at least one/);
  f.identity.review(exam.id, registration.id, 'approved', false, 'admin');
  assert.equal(f.identity.requests(exam.id)[0].status, 'approved');
});
test('verified candidate-number ownership is unique; pending claims cannot squat the identifier', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const imposter = f.account('imposter@example.test');
  const real = f.account('real@example.test');
  const exam = f.exam();
  f.identity.register(exam.token, imposter.id);
  f.identity.register(exam.token, real.id);
  f.approve(exam.id, real.id);
  assert.throws(() => f.approve(exam.id, imposter.id), /another account/);
  assert.equal(f.identity.findLogin('real@example.test')?.id, real.id);
  assert.equal(f.identity.profile(imposter.id).identityStatus, 'pending');
});
test('a reused verified roster assigns the next exam automatically to the same account', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const person = f.account();
  const first = f.exam();
  f.identity.register(first.token, person.id);
  f.approve(first.id, person.id);
  const second = f.exam('roster', [{ identifier: 'MUD/001', name: 'Candidate' }]);
  assert.equal(f.identity.invitation(second.token, person.id).registration?.status, 'approved');
  assert.equal(f.identity.examinations(person.id).length, 2);
  assert.equal(f.identity.requests(second.id).length, 1);
});
test('registration closure and link rotation preserve approved access and existing attempts', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const person = f.account();
  const exam = f.exam();
  f.identity.register(exam.token, person.id);
  f.approve(exam.id, person.id);
  const settings = f.identity.updateSettings(exam.id, { open: false, rotate: true }, 'admin');
  assert.throws(() => f.identity.invitation(exam.token), /no longer available/);
  assert.equal(f.identity.invitation(settings.token, person.id).registration?.status, 'approved');
  f.store.launch(exam.id, 'admin');
  const access = f.identity.authorizeExam(person.id, exam.id);
  const attempt = f.store.start(access.sittingId, access.candidateId);
  assert.equal(f.store.start(access.sittingId, access.candidateId).id, attempt.id);
  assert.throws(
    () => f.identity.updateSettings(exam.id, { open: true }, 'admin'),
    /after the examination/,
  );
});
test('capacity checks are transactional and a failed approval does not verify identity', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const one = f.account();
  const two = f.account('second@example.test', 'MUD/002');
  const exam = f.exam('approval', [], 1);
  f.identity.register(exam.token, one.id);
  f.identity.register(exam.token, two.id);
  f.approve(exam.id, one.id);
  assert.throws(() => f.approve(exam.id, two.id), /limit/);
  assert.equal(f.identity.profile(two.id).identityStatus, 'pending');
  assert.equal(
    f.identity.requests(exam.id).find((r) => r.identifier === 'MUD/002')?.status,
    'pending',
  );
});
test('registration deadline uses server time, and public invitations omit protected data', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const person = f.account();
  const exam = f.exam();
  f.db
    .prepare('UPDATE registration_settings SET closes_at=? WHERE assessment_id=?')
    .run(1001000, exam.id);
  f.advance(1000);
  assert.throws(() => f.identity.register(exam.token, person.id), /closed/);
  assert.equal(f.identity.invitation(exam.token).accepting, false);
  assert.doesNotMatch(
    JSON.stringify(f.identity.invitation(exam.token)),
    /password|correctOptionIds|credential|candidate@example/,
  );
});
test('declining one registration does not delete the account or its other registrations', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const person = f.account();
  const first = f.exam();
  const second = f.exam();
  f.identity.register(first.token, person.id);
  f.identity.register(second.token, person.id);
  f.identity.review(first.id, f.identity.requests(first.id)[0].id, 'rejected', false, 'admin');
  f.approve(second.id, person.id);
  assert.equal(f.identity.examinations(person.id).length, 2);
  assert.equal(
    f.identity.examinations(person.id).find((e) => e.assessmentId === first.id)?.registrationStatus,
    'rejected',
  );
});
test('candidate passphrases retain exact whitespace and registration settings are validated', () => {
  assert.equal(accountPassword('  my memorable phrase  ', true), '  my memorable phrase  ');
  assert.throws(() => accountPassword('too-short', true), /15/);
  assert.throws(
    () => registrationConfig({ accessMode: 'accounts', registrationPolicy: 'roster' }, 0, 1000),
    /roster/,
  );
  assert.throws(() => registrationConfig({ registrationCapacity: 1 }, 2, 1000), /capacity/);
});
