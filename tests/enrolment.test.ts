import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../apps/host/database.ts';
import { ExamStore } from '../apps/host/store.ts';
import { IdentityService } from '../apps/host/identity.ts';
import { Rosters } from '../apps/host/rosters.ts';
import { notificationFeed } from '../apps/host/notifications.ts';
import { assessment } from './fixtures.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createHandler } from '../apps/host/http.ts';

function fixture() {
  const db = openDatabase(':memory:');
  const store = new ExamStore(db);
  const identity = new IdentityService(store);
  const rosters = new Rosters(store);
  const account = (email: string) => {
    const session = identity.createAccount({ email, name: email.split('@')[0], hash: 'test-only' });
    return store.session(session.raw)!;
  };
  const roster = () =>
    rosters.save(randomUUID(), 'admin', {
      name: 'Class',
      revision: 0,
      entries: [],
      restricted: false,
      open: true,
      archived: false,
    });
  return { db, store, identity, rosters, account, roster };
}

test('existing account is enrolled immediately without verification and receives a group notification', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const person = f.account('person@example.test');
  let roster = f.roster();
  roster = f.rosters.enrol(roster.id, 'admin', {
    revision: roster.revision,
    accountId: person.account_id,
    email: 'person@example.test',
    identifier: '001',
  });
  assert.equal(roster.members[0].status, 'approved');
  assert.equal(roster.members[0].identifier, '001');
  assert.equal(f.identity.findLogin('person@example.test')?.id, person.account_id);
  assert.equal(f.identity.findLogin('001'), undefined);
  assert.ok(notificationFeed(f.db, person).items.some((item) => item.title === 'Added to a group'));
  const snapshot = f.rosters.snapshot(roster.id, 'admin', roster.revision);
  const exam = assessment();
  f.store.createAssessment(
    exam,
    snapshot.candidates.map((c) => ({ ...c, id: randomUUID(), hash: 'account-managed' })),
    'admin',
    { mode: 'accounts', policy: 'roster', capacity: 500, closesAt: null },
    undefined,
    snapshot.roster,
  );
  assert.equal(f.identity.examinations(person.account_id!)[0].registrationStatus, 'approved');
  assert.match(f.identity.examinations(person.account_id!)[0].applicationNumber!, /^APP-\d{6}$/);
  assert.throws(
    () =>
      f.rosters.enrol(roster.id, 'admin', {
        revision: 1,
        email: 'person@example.test',
        accountId: person.account_id,
      }),
    /changed/,
  );
});

test('assigned student numbers are unique across rosters in the current workspace', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const first = f.account('first@example.test');
  const other = f.account('other@example.test');
  const a = f.roster();
  const b = f.roster();
  f.rosters.enrol(a.id, 'admin', {
    revision: a.revision,
    email: 'first@example.test',
    accountId: first.account_id,
    identifier: '001',
  });
  assert.throws(
    () =>
      f.rosters.enrol(b.id, 'admin', {
        revision: b.revision,
        email: 'other@example.test',
        accountId: other.account_id,
        identifier: '001',
      }),
    /another account/,
  );
  assert.equal(f.rosters.get(b.id, 'admin').approved, 0);
  const again = f.rosters.enrol(b.id, 'admin', {
    revision: b.revision,
    email: 'first@example.test',
    accountId: first.account_id,
    identifier: '001',
  });
  assert.equal(again.approved, 1);
  assert.throws(
    () =>
      f.rosters.enrol(b.id, 'admin', {
        revision: again.revision,
        email: 'first@example.test',
        accountId: other.account_id,
        identifier: '001',
      }),
    /Select the existing account/,
  );
});

test('personal invitation reserves a number, binds only its intended email and is idempotent', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  let roster = f.roster();
  roster = f.rosters.enrol(roster.id, 'admin', {
    revision: roster.revision,
    email: 'new@example.test',
    name: 'New Student',
    identifier: '002',
  });
  assert.equal(roster.approved, 0);
  const link = roster.invitations[0].token;
  const other = f.account('other@example.test');
  assert.throws(() => f.rosters.claimEnrolment(link, other.account_id!), /email address/);
  assert.throws(
    () =>
      f.rosters.enrol(roster.id, 'admin', {
        revision: roster.revision,
        email: 'other@example.test',
        accountId: other.account_id,
        identifier: '002',
      }),
    /reserved/,
  );
  const person = f.account('new@example.test');
  assert.equal(f.rosters.claimEnrolment(link, person.account_id!).enrolled, true);
  assert.equal(f.rosters.claimEnrolment(link, person.account_id!).enrolled, true);
  assert.equal(f.rosters.get(roster.id, 'admin').approved, 1);
  assert.equal(f.rosters.get(roster.id, 'admin').invitations.length, 0);
  assert.equal(f.identity.profile(person.account_id!).identifier, '002');
});

test('closed and archived rosters cannot admit a new personal invitation', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  let roster = f.roster();
  roster = f.rosters.enrol(roster.id, 'admin', {
    revision: roster.revision,
    email: 'new@example.test',
    name: 'New',
  });
  const person = f.account('new@example.test');
  f.rosters.save(roster.id, 'admin', {
    name: roster.name,
    revision: roster.revision,
    entries: [],
    restricted: false,
    open: false,
    archived: true,
  });
  assert.throws(
    () => f.rosters.claimEnrolment(roster.invitations[0].token, person.account_id!),
    /closed/,
  );
  assert.equal(f.rosters.get(roster.id, 'admin').approved, 0);
});

test('one account receives stable assessment-scoped application references, not new login credentials', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const person = f.account('returning@example.test');
  const other = f.account('other@example.test');
  const exams = [assessment(), assessment()];
  for (const exam of exams)
    f.store.createAssessment(exam, [], 'admin', {
      mode: 'accounts',
      policy: 'approval',
      capacity: 500,
      closesAt: null,
    });
  const first = f.identity.settings(exams[0].id).token;
  f.identity.register(first, person.account_id!);
  f.identity.register(first, person.account_id!);
  f.identity.register(first, other.account_id!);
  f.identity.register(f.identity.settings(exams[1].id).token, person.account_id!);
  const requests = f.identity.requests(exams[0].id);
  assert.deepEqual(requests.map((r) => r.applicationNumber).sort(), ['APP-000001', 'APP-000002']);
  f.identity.review(exams[0].id, requests[0].id, 'approved', undefined, 'admin');
  assert.equal(f.identity.examinations(person.account_id!).length, 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM accounts').get()?.n, 2);
  assert.equal(f.identity.findLogin('APP-000001'), undefined);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM application_numbers').get()?.n, 3);
});

test('cancelling an unused invitation revokes its link and releases its student number', (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  let roster = f.roster();
  roster = f.rosters.enrol(roster.id, 'admin', {
    revision: roster.revision,
    email: 'wrong@example.test',
    name: 'Wrong email',
    identifier: '001',
  });
  const invite = roster.invitations[0];
  assert.throws(
    () => f.rosters.cancelInvitation(roster.id, 'someone-else', invite.id, roster.revision),
    /not found/,
  );
  roster = f.rosters.cancelInvitation(roster.id, 'admin', invite.id, roster.revision);
  assert.throws(() => f.rosters.enrolmentInvitation(invite.token), /not found/);
  const person = f.account('correct@example.test');
  roster = f.rosters.enrol(roster.id, 'admin', {
    revision: roster.revision,
    email: 'correct@example.test',
    accountId: person.account_id,
    identifier: '001',
  });
  assert.equal(roster.approved, 1);
});

test('email login works at another address of the same Host; public signup cannot claim a student number', async (t) => {
  const db = openDatabase(':memory:');
  const servers = [createServer(), createServer()];
  const origins: string[] = [];
  for (const [index, server] of servers.entries()) {
    server.listen(0, index === 0 ? '127.0.0.1' : '127.0.0.2');
    await once(server, 'listening');
    const origin = `http://${index === 0 ? '127.0.0.1' : '127.0.0.2'}:${(server.address() as AddressInfo).port}`;
    origins.push(origin);
    server.on('request', await createHandler(db, { origin }));
  }
  t.after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    db.close();
  });
  const post = (origin: string, path: string, body: unknown) =>
    fetch(origin + '/api' + path, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  await post(origins[0], '/admin/setup', { name: 'Admin', password: 'testing password only' });
  const signup = await post(origins[0], '/candidate/account/signup', {
    email: 'student@example.test',
    name: 'Student',
    identifier: '001',
    password: 'a memorable test phrase',
  });
  assert.equal(signup.status, 201);
  assert.match(
    String(db.prepare('SELECT identifier FROM memberships').get()?.identifier),
    /^ACCOUNT-/,
  );
  const login = await post(origins[1], '/candidate/account/login', {
    login: 'STUDENT@example.test',
    password: 'a memorable test phrase',
  });
  assert.equal(login.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM accounts').get()?.n, 1);
  assert.equal(
    (
      await post(origins[1], '/candidate/account/login', {
        login: '001',
        password: 'a memorable test phrase',
      })
    ).status,
    400,
  );
});
