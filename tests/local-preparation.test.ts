import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../apps/host/database.ts';
import { ExamStore } from '../apps/host/store.ts';
import { CloudAdministrators } from '../apps/host/cloud-administrators.ts';
import { CloudAuthoring } from '../apps/host/cloud-authoring.ts';
import { LocalPreparation } from '../apps/host/local-preparation.ts';
import { AssessmentEditing } from '../apps/host/assessment-editing.ts';
import { createHandler } from '../apps/host/http.ts';
import { ExamControls } from '../apps/host/exam-controls.ts';
import { digest } from '../apps/host/security.ts';
import { DomainError } from '../packages/exam-core/model.ts';
import type { AuthoringStorage } from '../apps/host/cloud-authoring-storage.ts';
import type { AuthoringRecord } from '../packages/contracts/cloud-authoring.ts';
import type {
  PreparationStorage,
  PreparationUpload,
} from '../apps/host/local-preparation-storage.ts';
import type { CloudSession, CloudAuthProvider } from '../apps/host/supabase-auth.ts';
import { assessment } from './fixtures.ts';

class MemoryPreparation implements PreparationStorage {
  uploads = new Map<string, PreparationUpload>();
  calls = 0;
  offline = false;
  lostAck = false;
  available() {
    this.calls++;
    if (this.offline) throw new DomainError('Offline', 503);
  }
  async prepare(_token: string, input: PreparationUpload) {
    this.available();
    this.uploads.set(input.id, structuredClone(input));
    if (this.lostAck) {
      this.lostAck = false;
      throw new DomainError('Lost receipt', 503);
    }
    return { id: input.id, digest: input.digest };
  }
  async close() {
    this.available();
  }
  async status() {
    this.available();
    return { downloaded: 0 };
  }
  async passes() {
    this.available();
    return [];
  }
  async pass(token: string, id: string) {
    this.available();
    const member = this.uploads.get(id)?.members.find((m) => m.accountId === token);
    if (!member) throw new DomainError('Not found', 404);
    return member.pass;
  }
}
async function fixture(t: TestContext) {
  const db = openDatabase(':memory:'),
    store = new ExamStore(db),
    key = randomBytes(32),
    providerId = randomUUID();
  let providerCalls = 0;
  const session: CloudSession = {
    userId: providerId,
    email: 'owner@example.test',
    name: 'Owner',
    accessToken: providerId,
    refreshToken: 'never-export-this-refresh',
    expiresAt: Date.now() + 86400000,
  };
  const provider: CloudAuthProvider = {
    signIn: async () => session,
    signUp: async () => ({ pending: true }),
    verify: async (s) => {
      providerCalls++;
      return s;
    },
  };
  const auth = new CloudAdministrators(store, provider, key),
    opened = auth.open(session),
    owner = store.session(opened.raw)!.principal_id;
  const records = new Map<string, AuthoringRecord>();
  let authoringCalls = 0;
  const storage: AuthoringStorage = {
    list: async () => {
      authoringCalls++;
      return [...records.values()].map(({ id, revision, digest }) => ({ id, revision, digest }));
    },
    read: async (_token, id) => {
      authoringCalls++;
      return records.get(id)!;
    },
    write: async (_token, expected, payload) => {
      authoringCalls++;
      const doc = JSON.parse(payload),
        hash = digest(payload),
        old = records.get(doc.id);
      if (old?.digest === hash) return old;
      if ((old?.revision ?? 0) !== expected) throw new DomainError('Changed', 409);
      const row = { id: doc.id, revision: expected + 1, digest: hash, payload };
      records.set(row.id, row);
      return row;
    },
  };
  const authoring = new CloudAuthoring(store, auth, storage),
    remote = new MemoryPreparation(),
    prep = new LocalPreparation(store, authoring, auth, remote, key),
    paper = assessment();
  store.createAssessment(paper, [], owner, {
    mode: 'accounts',
    policy: 'approval',
    closesAt: null,
    capacity: 100,
  });
  const account = randomUUID(),
    providerAccount = randomUUID(),
    candidate = randomUUID();
  db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?)').run(
    account,
    'student@example.test',
    'Student',
    'native-password-must-stay',
    Date.now(),
  );
  db.prepare("INSERT INTO memberships VALUES(?,?, 'default',?,'verified',NULL)").run(
    randomUUID(),
    account,
    '001',
  );
  db.prepare('INSERT INTO candidate_provider_identities VALUES(?,?)').run(account, providerAccount);
  db.prepare('INSERT INTO candidates VALUES(?,?,?,?,?)').run(
    candidate,
    paper.id,
    '001',
    'Student',
    'account-managed',
  );
  db.prepare("INSERT INTO registrations VALUES(?,?,?,?,'approved',?,?)").run(
    randomUUID(),
    paper.id,
    account,
    candidate,
    Date.now(),
    Date.now(),
  );
  await authoring.ensure(owner, true);
  t.after(async () => {
    await prep.stop();
    await authoring.stop();
    db.close();
  });
  const prepare = () =>
    prep.prepare(
      owner,
      paper.id,
      {
        expectedVersion: prep.status(owner, paper.id).sourceVersion,
        expiresAt: Date.now() + 86400000,
      },
      () => {},
    );
  return {
    db,
    store,
    key,
    auth,
    authoring,
    remote,
    prep,
    paper,
    owner,
    account,
    providerAccount,
    opened,
    prepare,
    cloudCalls: () => providerCalls + authoringCalls + remote.calls,
  };
}

test('preparation pins a separate native run, persists hashed access and no passwords or cloud tokens', async (t) => {
  const f = await fixture(t),
    status = await f.prepare(),
    p = status.preparation!;
  assert.equal(p.state, 'ready');
  assert.equal(p.candidates, 1);
  assert.notEqual(p.runId, f.paper.id);
  const upload = f.remote.uploads.get(p.id)!;
  assert.doesNotMatch(
    JSON.stringify(upload),
    /native-password|never-export|localAccountId|correctOptionIds/,
  );
  assert.doesNotMatch(
    String(f.db.prepare('SELECT sealed FROM local_preparations').get()!.sealed),
    /What is 2|credential|student@example/,
  );
  assert.equal(
    f.db.prepare('SELECT password_hash FROM accounts WHERE id=?').get(f.account)!.password_hash,
    'native-password-must-stay',
  );
  const pass = upload.members[0].pass;
  assert.equal(
    f.db.prepare('SELECT pass_hash FROM local_admission').get()!.pass_hash,
    digest(pass.credential),
  );
  assert.doesNotThrow(() => f.prep.assertLaunch(f.owner, p.runId));
  assert.throws(() => new AssessmentEditing(f.store).editView(p.runId), /prepared|pinned/i);
  const again = await f.prepare();
  assert.equal(again.preparation!.id, p.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM local_preparations').get()!.n, 1);
});

test('lost cloud acknowledgement is durable and retry commits exactly once after service restart', async (t) => {
  const f = await fixture(t);
  f.remote.lostAck = true;
  const pending = (await f.prepare()).preparation!;
  assert.equal(pending.state, 'pending');
  assert.match(pending.error!, /Lost receipt/);
  assert.equal(f.db.prepare('SELECT 1 FROM assessments WHERE id=?').get(pending.runId), undefined);
  const restart = new LocalPreparation(f.store, f.authoring, f.auth, f.remote, f.key);
  await restart.retry(f.owner, pending.id);
  assert.equal(restart.status(f.owner, f.paper.id).preparation!.state, 'ready');
  await restart.retry(f.owner, pending.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM local_admission').get()!.n, 1);
  await restart.stop();
});

test('tampered package, wrong Host key and unbound candidate admission cannot commit', async (t) => {
  const f = await fixture(t);
  f.remote.offline = true;
  const p = (await f.prepare()).preparation!;
  f.remote.offline = false;
  const wrong = new LocalPreparation(f.store, f.authoring, f.auth, f.remote, randomBytes(32));
  await wrong.retry(f.owner, p.id);
  assert.equal(f.prep.status(f.owner, f.paper.id).preparation!.state, 'pending');
  f.db.prepare("UPDATE local_preparations SET sealed='{}' WHERE id=?").run(p.id);
  await f.prep.retry(f.owner, p.id);
  assert.match(f.prep.status(f.owner, f.paper.id).preparation!.error!, /verified/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM local_admission').get()!.n, 0);
  f.prep.cancel(f.owner, p.id, 'Invalid retained package');
  f.db.prepare('DELETE FROM candidate_provider_identities WHERE account_id=?').run(f.account);
  await assert.rejects(f.prepare(), /Every admitted candidate/);
  await wrong.stop();
});

test('offline login and replacement preserve attempt identity, answers and deadline and revoke previous sessions', async (t) => {
  const f = await fixture(t),
    p = (await f.prepare()).preparation!,
    pass = f.remote.uploads.get(p.id)!.members[0].pass;
  const sitting = f.store.launch(p.runId, f.owner),
    attempt = f.store.start(sitting.id, pass.candidateId),
    question = f.store.assessment(p.runId).questions[0];
  f.store.save(sitting.id, pass.candidateId, question.id, {
    value: question.correctOptionIds,
    operationId: randomUUID(),
    expectedRevision: 0,
  });
  const calls = f.cloudCalls();
  f.remote.offline = true;
  const old = f.prep.login(pass),
    second = f.prep.login(pass);
  assert.equal(f.store.session(old.raw), undefined);
  assert.ok(f.store.session(second.raw));
  const operation = randomUUID(),
    replacement = f.prep.replace(f.owner, p.id, f.account, 'Lost phone', operation);
  assert.equal(f.store.session(second.raw), undefined);
  assert.throws(() => f.prep.login(pass), /not valid/);
  assert.deepEqual(f.prep.replace(f.owner, p.id, f.account, 'Lost phone', operation), replacement);
  assert.throws(
    () => f.prep.replace(f.owner, p.id, f.account, 'Different reason', operation),
    /already used/,
  );
  const next = f.prep.login(replacement);
  assert.equal(f.prep.scope(next.raw), p.runId);
  assert.equal(f.store.findAttempt(sitting.id, pass.candidateId)!.id, attempt.id);
  assert.equal(f.store.findAttempt(sitting.id, pass.candidateId)!.deadline, attempt.deadline);
  assert.deepEqual(f.store.responses(attempt.id)[question.id].value, question.correctOptionIds);
  await f.prep.pump();
  assert.equal(f.cloudCalls(), calls);
});

test('replica LAN admission is scoped to one run, rejects CSRF, avoids Supabase and survives handler restart', async (t) => {
  const f = await fixture(t),
    p = (await f.prepare()).preparation!,
    pass = f.remote.uploads.get(p.id)!.members[0].pass;
  f.store.launch(p.runId, f.owner);
  const calls = f.cloudCalls(),
    server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on(
    'request',
    await createHandler(f.db, { origin, candidateListener: true, identityMode: 'replica' }),
  );
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  let cookie = '',
    csrf = '';
  async function req(path: string, method = 'GET', body?: unknown, override = {}) {
    const res = await fetch(origin + '/api' + path, {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
        ...override,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.headers.has('set-cookie')) cookie = res.headers.get('set-cookie')!.split(';')[0];
    const json = await res.json();
    if (json.csrf) csrf = json.csrf;
    return { status: res.status, json };
  }
  assert.equal((await req('/auth')).json.offlineAdmissionAvailable, true);
  assert.equal((await req('/local-admission/login', 'POST', pass)).status, 200);
  const authResult = await req('/auth');
  assert.equal(authResult.status, 200, JSON.stringify(authResult.json));
  const auth = authResult.json;
  assert.equal(auth.offlineAdmission, true, JSON.stringify(auth));
  assert.equal(auth.accountId, f.account);
  const directory = (await req('/candidate/examinations')).json.examinations;
  assert.equal(directory.length, 1);
  assert.equal(directory[0].assessmentId, p.runId);
  for (const path of [
    '/candidate/rosters',
    '/candidate/local-passes',
    '/notifications',
    '/assessments',
    `/candidate/examinations/${f.paper.id}/state`,
  ])
    assert.equal((await req(path)).status, 403, path);
  assert.equal(
    (await req(`/candidate/examinations/${p.runId}/start`, 'POST', {}, { 'X-CSRF-Token': 'wrong' }))
      .status,
    403,
  );
  assert.equal((await req(`/candidate/examinations/${p.runId}/start`, 'POST', {})).status, 200);
  const view = await req(`/candidate/examinations/${p.runId}/state`);
  assert.equal(view.status, 200);
  assert.doesNotMatch(JSON.stringify(view.json), /correctOptionIds|pass_hash|credential/);
  server.removeAllListeners('request');
  server.on(
    'request',
    await createHandler(f.db, { origin, candidateListener: true, identityMode: 'replica' }),
  );
  assert.equal((await req('/auth')).json.offlineAdmission, true);
  assert.equal((await req(`/candidate/examinations/${p.runId}/state`)).status, 200);
  assert.equal(f.cloudCalls(), calls);
});

test('launch refuses altered pinned paper or membership; cancelled files cannot authenticate', async (t) => {
  const f = await fixture(t),
    p = (await f.prepare()).preparation!,
    pass = f.remote.uploads.get(p.id)!.members[0].pass;
  const definition = f.store.assessment(p.runId);
  f.db
    .prepare('UPDATE assessments SET definition=? WHERE id=?')
    .run(JSON.stringify({ ...definition, title: 'Tampered' }), p.runId);
  assert.throws(() => f.prep.assertLaunch(f.owner, p.runId), /pinned/);
  f.db
    .prepare('UPDATE assessments SET definition=? WHERE id=?')
    .run(JSON.stringify(definition), p.runId);
  f.db.prepare("UPDATE registrations SET status='rejected' WHERE assessment_id=?").run(p.runId);
  assert.throws(() => f.prep.assertLaunch(f.owner, p.runId), /admission/);
  f.prep.cancel(f.owner, p.id, 'Cancelled before exam');
  assert.throws(() => f.prep.login(pass), /not valid/);
  const status = f.prep.status(f.owner, p.runId);
  assert.equal(status.isPreparedRun, true);
  assert.equal(status.preparation!.state, 'cancelled');
});

test('a prepared run can be launched and controlled with its existing local administrator session even with cloud configuration removed', async (t) => {
  const f = await fixture(t),
    p = (await f.prepare()).preparation!,
    calls = f.cloudCalls(),
    server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on('request', await createHandler(f.db, { origin, preparationKey: f.key }));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  async function req(path: string, method = 'GET', body?: unknown) {
    const res = await fetch(origin + '/api' + path, {
      method,
      headers: {
        Origin: origin,
        Cookie: `mudu_session=${f.opened.raw}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': f.opened.csrf,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }
  const detail = await req(`/assessments/${p.runId}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.json));
  assert.equal(detail.json.deliveryReady, true);
  assert.equal((await req(`/assessments/${p.runId}/launch`, 'POST', {})).status, 200);
  assert.equal((await req(`/assessments/${p.runId}/monitor`)).status, 200);
  assert.equal(
    (
      await req(`/assessments/${p.runId}/controls`, 'POST', {
        action: 'announce',
        message: 'Continue with the examination.',
        expectedRevision: 0,
        operationId: randomUUID(),
      })
    ).status,
    200,
  );
  assert.equal((await req(`/assessments/${f.paper.id}`)).status, 503);
  assert.equal((await req(`/assessments/${p.runId}/rerun`, 'POST', {})).status, 503);
  assert.equal(f.cloudCalls(), calls);
});

test('expired access cannot start a new attempt but active and paused attempts retain offline recovery', async (t) => {
  const unused = await fixture(t),
    unusedPrep = (await unused.prepare()).preparation!,
    unusedPass = unused.remote.uploads.get(unusedPrep.id)!.members[0].pass;
  unused.store.now = () => unusedPass.expiresAt + 1;
  assert.equal(unused.prep.available(), false);
  assert.throws(() => unused.prep.login(unusedPass), /expired/);
  assert.equal(unused.prep.deliveryReady(unused.owner, unusedPrep.runId), false);
  const f = await fixture(t),
    p = (await f.prepare()).preparation!,
    pass = f.remote.uploads.get(p.id)!.members[0].pass;
  let now = pass.expiresAt - 1000;
  f.store.now = () => now;
  const sitting = f.store.launch(p.runId, f.owner),
    attempt = f.store.start(sitting.id, pass.candidateId);
  now += 2000;
  assert.equal(f.prep.available(), true);
  assert.ok(f.prep.login(pass));
  new ExamControls(f.store).perform(p.runId, f.owner, {
    action: 'pause',
    operationId: randomUUID(),
    expectedRevision: 0,
    reason: 'Network interruption',
  });
  now += 2 * 86400000;
  f.store.reconcile();
  assert.equal(f.prep.available(), true);
  assert.ok(f.prep.login(pass));
  assert.equal(f.store.findAttempt(sitting.id, pass.candidateId)!.id, attempt.id);
  assert.equal(f.store.findAttempt(sitting.id, pass.candidateId)!.status, 'active');
});

test('an actual database reopen retains sealed preparation, hashed admission and native account identity without cloud services', async (t) => {
  const f = await fixture(t),
    p = (await f.prepare()).preparation!,
    pass = f.remote.uploads.get(p.id)!.members[0].pass;
  const directory = mkdtempSync(join(tmpdir(), 'mudu-local-preparation-')),
    path = join(directory, 'host.sqlite');
  f.db.prepare('VACUUM INTO ?').run(path);
  const db = openDatabase(path),
    store = new ExamStore(db),
    authoring = new CloudAuthoring(store, null, null),
    prep = new LocalPreparation(store, authoring, null, null, f.key);
  t.after(async () => {
    await prep.stop();
    await authoring.stop();
    db.close();
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  });
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 21);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(prep.status(f.owner, f.paper.id).preparation!.state, 'ready');
  assert.doesNotThrow(() => prep.assertLaunch(f.owner, p.runId));
  assert.equal(prep.scope(prep.login(pass).raw), p.runId);
  assert.equal(
    db.prepare('SELECT password_hash FROM accounts WHERE id=?').get(f.account)!.password_hash,
    'native-password-must-stay',
  );
  assert.equal(store.session(f.opened.raw)!.principal_id, f.owner);
});
