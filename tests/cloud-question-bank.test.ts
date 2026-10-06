import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { openDatabase } from '../apps/host/database.ts';
import { ExamStore } from '../apps/host/store.ts';
import { QuestionBank } from '../apps/host/question-bank.ts';
import { CloudAdministrators } from '../apps/host/cloud-administrators.ts';
import { CloudQuestionBank, canonicalBank } from '../apps/host/cloud-question-bank.ts';
import type { CloudBankStorage } from '../apps/host/cloud-bank-storage.ts';
import type {
  CloudBankReceipt,
  CloudBankSnapshot,
} from '../packages/contracts/cloud-question-bank.ts';
import type { CloudSession, CloudAuthProvider } from '../apps/host/supabase-auth.ts';
import { digest } from '../apps/host/security.ts';
import { DomainError } from '../packages/exam-core/model.ts';
import { assessment } from './fixtures.ts';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { createHandler } from '../apps/host/http.ts';

class MemoryBank implements CloudBankStorage {
  values = new Map<string, CloudBankReceipt & { snapshot: CloudBankSnapshot }>();
  calls = 0;
  writes = 0;
  offline = false;
  loseAck = false;
  corrupt = false;
  beforeWrite: (() => void) | null = null;
  async metadata(token: string) {
    this.calls++;
    if (this.offline) throw new DomainError('Cloud unavailable', 503);
    const value = this.values.get(token);
    return value ? { revision: value.revision, digest: value.digest } : { revision: 0, digest: '' };
  }
  async read(token: string) {
    const receipt = await this.metadata(token);
    const snapshot: CloudBankSnapshot = structuredClone(
      this.values.get(token)?.snapshot ?? { version: 1 as const, projects: [], questions: [] },
    );
    return { ...receipt, snapshot, digest: this.corrupt ? '0'.repeat(64) : receipt.digest };
  }
  async write(token: string, revision: number, payload: string) {
    const current = await this.metadata(token),
      hash = digest(payload);
    if (current.digest === hash) return current;
    if (current.revision !== revision) throw new DomainError('Conflict', 409, 'BANK_CONFLICT');
    this.beforeWrite?.();
    const value = {
      revision: revision + 1,
      digest: hash,
      snapshot: JSON.parse(payload) as CloudBankSnapshot,
    };
    this.values.set(token, value);
    this.writes++;
    if (this.loseAck) {
      this.loseAck = false;
      throw new DomainError('Acknowledgment lost', 503);
    }
    return { revision: value.revision, digest: hash };
  }
}
const remoteIdentity = (): CloudSession => ({
  userId: randomUUID(),
  email: 'lecturer@example.test',
  name: 'Lecturer',
  accessToken: randomUUID(),
  refreshToken: 'test-refresh',
  expiresAt: Date.now() + 3600000,
});
function device(storage: MemoryBank, identity = remoteIdentity()) {
  const db = openDatabase(':memory:'),
    store = new ExamStore(db),
    owner = randomUUID();
  db.prepare('INSERT INTO administrators VALUES(?,?,?,1)').run(owner, 'Lecturer', 'local-verifier');
  const provider: CloudAuthProvider = {
    signIn: async () => identity,
    signUp: async () => ({ pending: true }),
    verify: async (value) => value,
  };
  const administrators = new CloudAdministrators(store, provider, randomBytes(32));
  administrators.open(identity, owner);
  const bank = new QuestionBank(store),
    sync = new CloudQuestionBank(store, administrators, storage);
  const project = (name = 'Pharmacology') =>
    bank.saveProject(owner, {
      id: randomUUID(),
      name,
      course: 'PCH 401',
      description: '',
      archived: false,
      expectedRevision: 0,
    });
  const question = (projectId: string, prompt = 'Which answer is correct?') =>
    bank.save(owner, {
      id: randomUUID(),
      projectId,
      expectedRevision: 0,
      status: 'draft',
      question: { type: 'single', prompt, marks: 1, options: ['A', 'B'], correctIndices: [0] },
      course: 'PCH 401',
      topic: 'Topic',
      difficulty: 'medium',
      tags: [],
      explanation: '',
    });
  const edit = (id: string, prompt: string) => {
    const saved = bank.get(id, owner);
    return bank.save(owner, {
      ...saved,
      expectedRevision: saved.revision,
      question: { ...saved.question, prompt },
    });
  };
  return { db, store, owner, identity, administrators, bank, sync, project, question, edit };
}

test('question projects and reviewed questions follow the same cloud identity to another computer; deletions and moves propagate', async (t) => {
  const cloud = new MemoryBank(),
    a = device(cloud),
    b = device(cloud, a.identity),
    other = device(cloud);
  t.after(() => {
    a.db.close();
    b.db.close();
    other.db.close();
  });
  const project = a.project(),
    target = a.project('Second project'),
    question = a.question(project.id);
  a.bank.reviewSelection(a.owner, {
    action: 'approve',
    reviewed: true,
    selection: [{ id: question.id, revision: 1 }],
  });
  const originalExam = assessment();
  a.store.createAssessment(originalExam, [], a.owner);
  await a.sync.synchronize(a.owner);
  assert.equal(a.sync.status(a.owner).state, 'synced');
  await b.sync.synchronize(b.owner);
  assert.equal(b.bank.project(b.owner, project.id).name, 'Pharmacology');
  assert.equal(b.bank.get(question.id, b.owner).status, 'approved');
  await other.sync.synchronize(other.owner);
  assert.equal(other.sync.snapshot(other.owner).projects.length, 0);
  assert.throws(() => other.bank.get(question.id, other.owner), /not found/);
  b.bank.move(b.owner, {
    projectId: target.id,
    selection: [{ id: question.id, revision: b.bank.get(question.id, b.owner).revision }],
  });
  await b.sync.synchronize(b.owner);
  await a.sync.synchronize(a.owner);
  assert.equal(a.bank.get(question.id, a.owner).projectId, target.id);
  const moved = a.bank.get(question.id, a.owner);
  a.bank.reviewSelection(a.owner, {
    action: 'delete',
    selection: [{ id: moved.id, revision: moved.revision }],
  });
  await a.sync.synchronize(a.owner);
  await b.sync.synchronize(b.owner);
  assert.throws(() => b.bank.get(question.id, b.owner), /not found/);
  assert.equal(
    a.store.detail(originalExam.id).assessment.questions.length,
    originalExam.questions.length,
  );
  assert.equal(a.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('concurrent edits never overwrite either bank; Keep both retains differing questions and a downloadable recovery snapshot', async (t) => {
  const cloud = new MemoryBank(),
    a = device(cloud),
    b = device(cloud, a.identity);
  t.after(() => {
    a.db.close();
    b.db.close();
  });
  const project = a.project(),
    question = a.question(project.id);
  await a.sync.synchronize(a.owner);
  await b.sync.synchronize(b.owner);
  a.edit(question.id, 'Cloud edit');
  b.edit(question.id, 'This computer edit');
  await a.sync.synchronize(a.owner);
  await b.sync.synchronize(b.owner);
  assert.equal(b.sync.status(b.owner).state, 'conflict');
  assert.equal(b.bank.get(question.id, b.owner).question.prompt, 'This computer edit');
  assert.throws(() => b.sync.assertWritable(b.owner), /Review/);
  const stale = b.bank.get(question.id, b.owner);
  await b.sync.resolve(b.owner, true);
  const bank = b.sync.snapshot(b.owner);
  assert.ok(bank.questions.some((q) => q.question.prompt === 'Cloud edit'));
  assert.ok(
    bank.questions.some((q) => q.question.prompt === 'This computer edit' && q.id !== question.id),
  );
  assert.equal(b.sync.recovery(b.owner).questions[0].question.prompt, 'This computer edit');
  assert.equal(b.sync.status(b.owner).recoveryAvailable, true);
  assert.throws(
    () => b.bank.save(b.owner, { ...stale, expectedRevision: stale.revision }),
    /changed/,
  );
  await b.sync.synchronize(b.owner);
  await a.sync.synchronize(a.owner);
  assert.equal(a.sync.snapshot(a.owner).questions.length, 2);
  assert.equal(b.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('Use cloud preserves the local recovery copy, and expired authorization cannot perform recovery', async (t) => {
  const cloud = new MemoryBank(),
    a = device(cloud),
    b = device(cloud, a.identity);
  t.after(() => {
    a.db.close();
    b.db.close();
  });
  const project = a.project(),
    question = a.question(project.id);
  await a.sync.synchronize(a.owner);
  await b.sync.synchronize(b.owner);
  a.edit(question.id, 'Cloud');
  b.edit(question.id, 'Local');
  await a.sync.synchronize(a.owner);
  await b.sync.synchronize(b.owner);
  await assert.rejects(
    b.sync.resolve(b.owner, false, () => {
      throw new DomainError('Session expired', 401);
    }),
    /Session expired/,
  );
  assert.equal(b.bank.get(question.id, b.owner).question.prompt, 'Local');
  assert.throws(() => b.sync.recovery(b.owner), /No recovery/);
  await b.sync.resolve(b.owner, false);
  assert.equal(b.bank.get(question.id, b.owner).question.prompt, 'Cloud');
  assert.equal(b.sync.recovery(b.owner).questions[0].question.prompt, 'Local');
});

test('offline edits and lost acknowledgments recover without duplicate cloud revisions; newer local edits remain pending', async (t) => {
  const cloud = new MemoryBank(),
    a = device(cloud);
  t.after(() => a.db.close());
  const project = a.project(),
    question = a.question(project.id);
  cloud.offline = true;
  await a.sync.synchronize(a.owner);
  assert.equal(a.sync.status(a.owner).state, 'offline');
  a.edit(question.id, 'Offline edit');
  cloud.offline = false;
  cloud.loseAck = true;
  await a.sync.synchronize(a.owner);
  assert.equal(cloud.writes, 1);
  assert.equal(a.sync.status(a.owner).state, 'offline');
  await a.sync.synchronize(a.owner);
  assert.equal(cloud.writes, 1);
  assert.equal(a.sync.status(a.owner).state, 'synced');
  const restored = new CloudQuestionBank(a.store, a.administrators, cloud);
  assert.equal(restored.status(a.owner).state, 'synced');
  const before = Number(
    a.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='bank_cloud_checkpoint'").get()!.n,
  );
  await restored.synchronize(a.owner);
  assert.equal(
    Number(
      a.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='bank_cloud_checkpoint'").get()!.n,
    ),
    before,
  );
  a.edit(question.id, 'First edit');
  cloud.beforeWrite = () => {
    cloud.beforeWrite = null;
    a.edit(question.id, 'Newer edit');
  };
  await restored.synchronize(a.owner);
  assert.equal(restored.status(a.owner).state, 'pending');
  await restored.synchronize(a.owner);
  assert.equal(
    cloud.values.get(a.identity.accessToken)!.snapshot.questions[0].question.prompt,
    'Newer edit',
  );
});

test('corrupt cloud data is rejected before import, and IDs owned by another workspace cannot be adopted', async (t) => {
  const cloud = new MemoryBank(),
    a = device(cloud),
    b = device(cloud, a.identity);
  t.after(() => {
    a.db.close();
    b.db.close();
  });
  const project = a.project();
  a.question(project.id);
  await a.sync.synchronize(a.owner);
  cloud.corrupt = true;
  await b.sync.synchronize(b.owner);
  assert.equal(b.sync.status(b.owner).state, 'offline');
  assert.equal(b.sync.snapshot(b.owner).projects.length, 0);
  cloud.corrupt = false;
  const stranger = randomUUID();
  b.db
    .prepare('INSERT INTO administrators VALUES(?,?,?,NULL)')
    .run(stranger, 'Other', 'supabase-managed');
  b.db
    .prepare('INSERT INTO bank_projects VALUES(?,?,?,?,?,0,1,?)')
    .run(project.id, stranger, 'Private', '', '', 1);
  await b.sync.synchronize(b.owner);
  assert.equal(b.sync.status(b.owner).state, 'conflict');
  assert.equal(
    b.db.prepare('SELECT owner_id FROM bank_projects WHERE id=?').get(project.id)!.owner_id,
    stranger,
  );
  assert.equal(b.sync.snapshot(b.owner).questions.length, 0);
});

test('active local examinations defer cloud bank traffic completely', async (t) => {
  const cloud = new MemoryBank(),
    a = device(cloud);
  t.after(() => a.db.close());
  a.project();
  const exam = assessment();
  a.store.createAssessment(exam, [], a.owner);
  a.store.launch(exam.id, a.owner);
  await a.sync.synchronize(a.owner);
  a.sync.pump();
  assert.equal(cloud.calls, 0);
  assert.equal(a.sync.status(a.owner).state, 'paused');
  await assert.rejects(a.sync.resolve(a.owner, true), /Finish the active/);
  assert.equal(cloud.calls, 0);
});

test('canonical question-bank serialization is independent of object key order', () => {
  assert.equal(
    canonicalBank({ b: 2, a: { z: 1, y: ['α', true] } }),
    canonicalBank({ a: { y: ['α', true], z: 1 }, b: 2 }),
  );
  assert.notEqual(canonicalBank(['a', 'b']), canonicalBank(['b', 'a']));
});

test('cloud bank HTTP routes isolate administrators, protect recovery with CSRF and deny candidate access', async (t) => {
  const db = openDatabase(':memory:'),
    cloud = new MemoryBank(),
    first = remoteIdentity(),
    second = remoteIdentity();
  second.email = 'other@example.test';
  let now = Date.now();
  const provider: CloudAuthProvider = {
    signIn: async (email) => (email === first.email ? first : second),
    signUp: async () => ({ pending: true }),
    verify: async (value) => value,
  };
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on(
    'request',
    await createHandler(db, {
      origin: base,
      cloudBank: cloud,
      cloudAuth: { provider, sessionKey: randomBytes(32) },
      now: () => now,
    }),
  );
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  function client() {
    let cookie = '',
      csrf = '';
    return async (
      path: string,
      method = 'GET',
      body?: unknown,
      headers: Record<string, string> = {},
    ) => {
      const response = await fetch(base + '/api' + path, {
        method,
        headers: {
          Origin: base,
          Cookie: cookie,
          'X-CSRF-Token': csrf,
          'Content-Type': 'application/json',
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const next = response.headers.get('set-cookie');
      if (next) cookie = next.split(';')[0];
      const value = await response.json();
      if (value.csrf) csrf = value.csrf;
      return { status: response.status, value };
    };
  }
  const a = client(),
    b = client(),
    outsider = client();
  assert.equal((await outsider('/question-bank/cloud/status')).status, 401);
  for (const [call, email] of [
    [a, first.email],
    [b, second.email],
  ] as const)
    assert.equal(
      (await call('/admin/cloud/login', 'POST', { email, password: 'Cloud123' })).status,
      200,
    );
  const project = randomUUID();
  assert.equal(
    (
      await a('/question-bank/projects', 'POST', {
        id: project,
        name: 'Private',
        course: '',
        description: '',
        archived: false,
        expectedRevision: 0,
      })
    ).status,
    200,
  );
  assert.equal((await a('/question-bank/cloud/status')).value.state, 'synced');
  assert.equal((await b('/question-bank/projects/' + project)).status, 404);
  assert.equal((await b('/question-bank/projects')).value.items.length, 0);
  const remote = structuredClone(cloud.values.get(first.accessToken)!.snapshot);
  remote.projects[0].name = 'Cloud';
  remote.projects[0].revision++;
  await cloud.write(first.accessToken, 1, canonicalBank(remote));
  db.prepare('UPDATE bank_projects SET name=?,revision=revision+1 WHERE id=?').run(
    'Local',
    project,
  );
  now += 16000;
  assert.equal((await a('/question-bank/cloud/status')).value.state, 'conflict');
  assert.equal(
    (
      await a(
        '/question-bank/cloud/resolve',
        'POST',
        { choice: 'both' },
        { 'X-CSRF-Token': 'wrong' },
      )
    ).status,
    403,
  );
  assert.equal(
    (await a('/question-bank/cloud/resolve', 'POST', { choice: 'overwrite-all' })).status,
    400,
  );
  assert.equal(
    (
      await a('/question-bank/cloud/resolve', 'POST', {
        choice: 'both',
        ownerId: (await b('/auth')).value.adminId,
      })
    ).status,
    200,
  );
  assert.equal((await a('/question-bank/cloud/recovery')).value.projects[0].name, 'Local');
  assert.equal((await b('/question-bank/cloud/recovery')).status, 404);
  const candidate = new ExamStore(db, () => now).createSession('candidate', randomUUID(), null);
  assert.equal(
    (
      await outsider('/question-bank/cloud/status', 'GET', undefined, {
        Cookie: `mudu_session=${candidate.raw}`,
      })
    ).status,
    403,
  );
});
