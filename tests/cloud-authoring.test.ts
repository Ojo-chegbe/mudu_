import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { openDatabase } from '../apps/host/database.ts';
import { ExamStore } from '../apps/host/store.ts';
import { CloudAdministrators } from '../apps/host/cloud-administrators.ts';
import { CloudAuthoring, validateWizard } from '../apps/host/cloud-authoring.ts';
import type { AuthoringStorage } from '../apps/host/cloud-authoring-storage.ts';
import type {
  AuthoringRecord,
  AssessmentWizardDraft,
  SavedWizard,
} from '../packages/contracts/cloud-authoring.ts';
import { DomainError } from '../packages/exam-core/model.ts';
import { digest } from '../apps/host/security.ts';
import { assessment } from './fixtures.ts';
import { assessmentInput } from '../packages/contracts/assessment-authoring.ts';
import { AssessmentEditing } from '../apps/host/assessment-editing.ts';
import type { CloudSession, CloudAuthProvider } from '../apps/host/supabase-auth.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createHandler } from '../apps/host/http.ts';

export function wizard(): AssessmentWizardDraft {
  const { questions, ...details } = assessmentInput(assessment());
  return {
    step: 1,
    details,
    questions,
    candidates: [],
    accessMode: 'accounts',
    registrationPolicy: 'approval',
    registrationCloses: '',
    registrationCapacity: 100,
    keysSaved: false,
    requestId: randomUUID(),
    createdId: null,
    useRoster: false,
    accessChoiceConfirmed: true,
    roster: null,
  };
}
class MemoryAuthoring implements AuthoringStorage {
  records = new Map<string, Map<string, AuthoringRecord>>();
  calls = 0;
  offline = false;
  lostAck = false;
  corrupt = false;
  onRead: (() => void) | null = null;
  onWrite: (() => void) | null = null;
  directory(owner: string) {
    if (!this.records.has(owner)) this.records.set(owner, new Map());
    return this.records.get(owner)!;
  }
  available() {
    this.calls++;
    if (this.offline) throw new DomainError('Unavailable', 503);
  }
  async list(owner: string) {
    this.available();
    return [...this.directory(owner).values()].map(({ id, revision, digest }) => ({
      id,
      revision,
      digest,
    }));
  }
  async read(owner: string, id: string) {
    this.available();
    const row = structuredClone(this.directory(owner).get(id));
    if (!row) throw new DomainError('Not found', 404);
    this.onRead?.();
    return this.corrupt ? { ...row, payload: row.payload + ' ' } : row;
  }
  async write(owner: string, expected: number, payload: string) {
    this.available();
    const doc = JSON.parse(payload),
      old = this.directory(owner).get(doc.id),
      hash = digest(payload);
    if (old?.digest === hash) return old;
    if ((old?.revision ?? 0) !== expected)
      throw new DomainError('Changed', 409, 'AUTHORING_CONFLICT');
    const row = { id: doc.id, revision: (old?.revision ?? 0) + 1, digest: hash, payload };
    this.directory(owner).set(doc.id, row);
    this.onWrite?.();
    if (this.lostAck) {
      this.lostAck = false;
      throw new DomainError('Lost acknowledgment', 503);
    }
    return row;
  }
}
function fixture(t: TestContext, storage: MemoryAuthoring, providerId: string = randomUUID()) {
  const db = openDatabase(':memory:'),
    store = new ExamStore(db),
    session: CloudSession = {
      userId: providerId,
      email: 'owner@example.test',
      name: 'Owner',
      accessToken: providerId,
      refreshToken: 'secret-refresh',
      expiresAt: Date.now() + 3600000,
    };
  const provider: CloudAuthProvider = {
    signIn: async () => session,
    signUp: async () => ({ pending: true }),
    verify: async (v) => v,
  };
  const key = randomBytes(32),
    auth = new CloudAdministrators(store, provider, key),
    opened = auth.open(session),
    owner = store.session(opened.raw)!.principal_id,
    sync = new CloudAuthoring(store, auth, storage);
  t.after(async () => {
    await sync.stop();
    db.close();
  });
  return { db, store, sync, owner, session, provider, opened, key };
}
function edit(f: ReturnType<typeof fixture>, id: string, title: string) {
  const editor = new AssessmentEditing(f.store),
    view = editor.editView(id);
  editor.update(id, f.owner, { ...view.input, title, expectedVersion: view.version });
  f.sync.changed(f.owner);
}
test('unfinished drafts follow their private workspace across Hosts, persist locally and exclude secrets', async (t) => {
  const storage = new MemoryAuthoring(),
    a = fixture(t, storage),
    b = fixture(t, storage, a.session.userId),
    other = fixture(t, storage),
    d = wizard();
  d.details.title = '';
  d.questions[0].prompt = '';
  d.candidates = [{ identifier: '001', name: 'Student', credential: 'never-transfer-this' }];
  const saved = a.sync.saveDraft(a.owner, d.requestId, d, 0);
  assert.equal(saved.draft.candidates[0].credential, '');
  assert.throws(() => a.sync.saveDraft(a.owner, d.requestId, { ...d, step: 2 }, 0), /changed/);
  assert.throws(() => a.sync.getDraft(other.owner, d.requestId), /not found/);
  await a.sync.ensure(a.owner, true);
  await b.sync.ensure(b.owner, true);
  await other.sync.ensure(other.owner, true);
  assert.equal(b.sync.listDrafts(b.owner)[0].id, d.requestId);
  assert.equal(other.sync.listDrafts(other.owner).length, 0);
  assert.doesNotMatch(
    storage.directory(a.session.userId).get(d.requestId)!.payload,
    /never-transfer|secret-refresh|password|accessToken/,
  );
  const reopened = new CloudAuthoring(a.store, null, null);
  assert.equal((reopened.getDraft(a.owner, d.requestId) as SavedWizard).revision, 1);
  const remote = b.sync.getDraft(b.owner, d.requestId) as SavedWizard;
  b.sync.discard(b.owner, d.requestId, remote.revision);
  await b.sync.ensure(b.owner, true);
  await a.sync.ensure(a.owner, true);
  assert.equal(a.sync.listDrafts(a.owner).length, 0);
  assert.throws(() => a.sync.getDraft(a.owner, d.requestId), /discarded/);
});
test('cloud authoring keeps stable assessment IDs, paper settings and joining links without copying candidate credentials or execution authority', async (t) => {
  const storage = new MemoryAuthoring(),
    a = fixture(t, storage),
    b = fixture(t, storage, a.session.userId),
    paper = assessment();
  a.store.createAssessment(paper, [], a.owner, {
    mode: 'accounts',
    policy: 'approval',
    closesAt: null,
    capacity: 100,
  });
  const token = a.db
    .prepare('SELECT link_token FROM registration_settings WHERE assessment_id=?')
    .get(paper.id)!.link_token;
  await a.sync.ensure(a.owner, true);
  await b.sync.ensure(b.owner, true);
  assert.equal(
    b.sync.overview(b.owner).items[0]?.state,
    'synced',
    JSON.stringify(b.sync.overview(b.owner)),
  );
  assert.equal(b.store.assessment(paper.id).title, paper.title);
  assert.equal(
    b.db
      .prepare('SELECT link_token FROM registration_settings WHERE assessment_id=?')
      .get(paper.id)!.link_token,
    token,
  );
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM candidates').get()!.n, 0);
  assert.throws(() => b.sync.assertDelivery(b.owner, paper.id), /original Host/);
  assert.doesNotThrow(() => a.sync.assertDelivery(a.owner, paper.id));
  edit(b, paper.id, 'Edited on B');
  await b.sync.ensure(b.owner, true);
  await a.sync.ensure(a.owner, true);
  assert.equal(a.store.assessment(paper.id).title, 'Edited on B');
  assert.equal(a.sync.overview(a.owner).items[0].state, 'synced');
  const accountId = randomUUID(),
    candidateId = randomUUID();
  a.db
    .prepare('INSERT INTO accounts VALUES(?,?,?,?,?)')
    .run(accountId, 'student@example.test', 'Student', 'native-only', Date.now());
  a.db
    .prepare('INSERT INTO candidates VALUES(?,?,?,?,?)')
    .run(candidateId, paper.id, '001', 'Student', 'account-managed');
  a.db
    .prepare("INSERT INTO registrations VALUES(?,?,?,?,'approved',?,?)")
    .run(randomUUID(), paper.id, accountId, candidateId, Date.now(), Date.now());
  a.store.launch(paper.id, a.owner);
  edit(b, paper.id, 'Later edit');
  await b.sync.ensure(b.owner, true);
  const calls = storage.calls;
  await a.sync.ensure(a.owner, true);
  assert.equal(storage.calls, calls);
  assert.equal(a.store.assessment(paper.id).title, 'Edited on B');
  a.store.end(paper.id, a.owner);
  await a.sync.ensure(a.owner, true);
  assert.equal(a.sync.overview(a.owner).items[0].state, 'conflict');
  assert.equal(a.store.assessment(paper.id).title, 'Edited on B');
  await assert.rejects(
    a.sync.resolve(a.owner, paper.id, () => {}),
    /already|started/,
  );
});
test('cloud outages and lost upload replies retain drafts without duplicate revisions', async (t) => {
  const storage = new MemoryAuthoring(),
    a = fixture(t, storage),
    d = wizard();
  a.sync.saveDraft(a.owner, d.requestId, d, 0);
  storage.offline = true;
  await a.sync.ensure(a.owner, true);
  assert.equal(a.sync.overview(a.owner).state, 'offline');
  assert.equal(a.sync.listDrafts(a.owner).length, 1);
  storage.offline = false;
  storage.lostAck = true;
  await a.sync.ensure(a.owner, true);
  assert.equal(storage.directory(a.session.userId).get(d.requestId)!.revision, 1);
  await a.sync.ensure(a.owner, true);
  assert.equal(storage.directory(a.session.userId).get(d.requestId)!.revision, 1);
  assert.equal(a.sync.overview(a.owner).items[0].state, 'synced');
});
test('concurrent drafts require explicit recovery and preserve both copies, with authorization rechecked after downloading', async (t) => {
  const storage = new MemoryAuthoring(),
    a = fixture(t, storage),
    b = fixture(t, storage, a.session.userId),
    d = wizard();
  a.sync.saveDraft(a.owner, d.requestId, d, 0);
  await a.sync.ensure(a.owner, true);
  await b.sync.ensure(b.owner, true);
  const da = a.sync.getDraft(a.owner, d.requestId) as SavedWizard,
    db = b.sync.getDraft(b.owner, d.requestId) as SavedWizard;
  a.sync.saveDraft(
    a.owner,
    d.requestId,
    { ...da.draft, details: { ...da.draft.details, title: 'A copy' } },
    da.revision,
  );
  b.sync.saveDraft(
    b.owner,
    d.requestId,
    { ...db.draft, details: { ...db.draft.details, title: 'B copy' } },
    db.revision,
  );
  await a.sync.ensure(a.owner, true);
  await b.sync.ensure(b.owner, true);
  assert.equal(b.sync.overview(b.owner).items[0].state, 'conflict');
  await assert.rejects(
    b.sync.resolve(b.owner, d.requestId, () => {
      throw new DomainError('Expired', 401);
    }),
    /Expired/,
  );
  assert.equal(
    (b.sync.getDraft(b.owner, d.requestId) as SavedWizard).draft.details.title,
    'B copy',
  );
  await b.sync.resolve(b.owner, d.requestId, () => {});
  assert.equal(
    (b.sync.getDraft(b.owner, d.requestId) as SavedWizard).draft.details.title,
    'A copy',
  );
  assert.equal(JSON.parse(b.sync.recovery(b.owner, d.requestId)).draft.details.title, 'B copy');
  assert.throws(() => b.sync.recovery(a.owner, d.requestId), /not found/);
  assert.equal(b.sync.overview(b.owner).items[0].recoveryAvailable, true);
});
test('edits during downloads are not overwritten; edits during uploads remain pending; bad checksums cannot import', async (t) => {
  const storage = new MemoryAuthoring(),
    a = fixture(t, storage),
    b = fixture(t, storage, a.session.userId),
    d = wizard();
  a.sync.saveDraft(a.owner, d.requestId, d, 0);
  await a.sync.ensure(a.owner, true);
  storage.corrupt = true;
  await b.sync.ensure(b.owner, true);
  assert.equal(b.sync.listDrafts(b.owner).length, 0);
  storage.corrupt = false;
  await b.sync.ensure(b.owner, true);
  let da = a.sync.getDraft(a.owner, d.requestId) as SavedWizard;
  a.sync.saveDraft(a.owner, d.requestId, { ...da.draft, step: 2 }, da.revision);
  await a.sync.ensure(a.owner, true);
  storage.onRead = () => {
    storage.onRead = null;
    const db = b.sync.getDraft(b.owner, d.requestId) as SavedWizard;
    b.sync.saveDraft(
      b.owner,
      d.requestId,
      { ...db.draft, details: { ...db.draft.details, title: 'During read' } },
      db.revision,
    );
  };
  await b.sync.ensure(b.owner, true);
  assert.equal(b.sync.overview(b.owner).items[0].state, 'conflict');
  assert.equal(
    (b.sync.getDraft(b.owner, d.requestId) as SavedWizard).draft.details.title,
    'During read',
  );
  da = a.sync.getDraft(a.owner, d.requestId) as SavedWizard;
  a.sync.saveDraft(a.owner, d.requestId, { ...da.draft, step: 3 }, da.revision);
  storage.onWrite = () => {
    storage.onWrite = null;
    const current = a.sync.getDraft(a.owner, d.requestId) as SavedWizard;
    a.sync.saveDraft(
      a.owner,
      d.requestId,
      { ...current.draft, details: { ...current.draft.details, title: 'During upload' } },
      current.revision,
    );
  };
  await a.sync.ensure(a.owner, true);
  assert.equal(a.sync.overview(a.owner).items[0].state, 'pending');
  await a.sync.ensure(a.owner, true);
  assert.equal(a.sync.overview(a.owner).items[0].state, 'synced');
});
test('draft validation excludes unknown fields and rejects legacy credentials and malformed IDs', () => {
  const d = wizard();
  assert.throws(() => validateWizard({ ...d, accessMode: 'legacy' }), /account-based/);
  assert.throws(() => validateWizard({ ...d, requestId: 'not-a-uuid' }), /account-based/);
  assert.equal('password' in validateWizard({ ...d, password: 'secret' }), false);
  assert.throws(
    () => validateWizard({ ...d, questions: [{ ...d.questions[0], prompt: 'x'.repeat(10001) }] }),
    /invalid/,
  );
});
test('authoring HTTP endpoints enforce owner boundaries, CSRF and stale draft guards', async (t) => {
  const storage = new MemoryAuthoring(),
    f = fixture(t, storage),
    server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on(
    'request',
    await createHandler(f.db, {
      origin: base,
      cloudAuth: { provider: f.provider, sessionKey: f.key },
      cloudAuthoring: storage,
    }),
  );
  const request = (path: string, method = 'GET', data?: unknown, csrf = f.opened.csrf) =>
    fetch(base + '/api' + path, {
      method,
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        Cookie: `mudu_session=${f.opened.raw}`,
        'X-CSRF-Token': csrf,
      },
      body: data ? JSON.stringify(data) : undefined,
    });
  const d = wizard();
  assert.equal(
    (await request(`/authoring/${d.requestId}`, 'PUT', { draft: d, expectedRevision: 0 }, 'bad'))
      .status,
    403,
  );
  const saved = await request(`/authoring/${d.requestId}`, 'PUT', {
    draft: d,
    expectedRevision: 0,
  });
  assert.equal(saved.status, 200);
  assert.equal(
    (
      await request(`/authoring/${d.requestId}`, 'PUT', {
        draft: { ...d, step: 2 },
        expectedRevision: 0,
      })
    ).status,
    409,
  );
  assert.equal((await request(`/authoring/${randomUUID()}`)).status, 404);
  const payload = {
    ...d.details,
    questions: d.questions,
    accessMode: 'accounts',
    candidates: [],
    creationRequestId: d.requestId,
    authoringRevision: 1,
  };
  const created = await request('/assessments', 'POST', payload);
  assert.equal(created.status, 201);
  assert.equal((await created.json()).id, d.requestId);
  assert.equal((await request(`/authoring/${d.requestId}`)).status, 200);
  assert.equal((await request('/authoring/drafts')).status, 200);
});
