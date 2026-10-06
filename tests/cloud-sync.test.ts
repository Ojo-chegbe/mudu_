import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../apps/host/database.ts';
import { ExamStore } from '../apps/host/store.ts';
import { CloudAdministrators } from '../apps/host/cloud-administrators.ts';
import { CloudSync, recordDigest } from '../apps/host/cloud-sync.ts';
import type { CloudRecords, UploadManifest, UploadReceipt } from '../apps/host/cloud-records.ts';
import type { CloudExamRecord } from '../packages/contracts/cloud-sync.ts';
import type { CloudAuthProvider, CloudSession } from '../apps/host/supabase-auth.ts';
import { DomainError } from '../packages/exam-core/model.ts';
import { assessment } from './fixtures.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createHandler } from '../apps/host/http.ts';
import { hashPassword } from '../apps/host/security.ts';

export class MemoryCloud implements CloudRecords {
  uploads = new Map<
    string,
    { manifest: UploadManifest; parts: Map<number, Buffer>; receipt?: UploadReceipt }
  >();
  documents = new Map<
    string,
    { record: CloudExamRecord; receipt: UploadReceipt; host: string; sitting: string }
  >();
  losePartAck = false;
  loseFinishAck = false;
  badReceipt = false;
  partsSent: number[] = [];
  unavailable = false;
  async ready() {
    if (this.unavailable) throw new DomainError('Offline', 503);
  }
  async begin(token: string, manifest: UploadManifest) {
    const key = token + manifest.id;
    let upload = this.uploads.get(key);
    if (!upload) {
      upload = { manifest, parts: new Map() };
      this.uploads.set(key, upload);
    }
    assert.deepEqual(upload.manifest, manifest);
    return {
      received: [...upload.parts.keys()],
      revision: upload.receipt?.revision ?? null,
      digest: manifest.digest,
    };
  }
  async part(token: string, id: string, index: number, data: string) {
    this.partsSent.push(index);
    this.uploads.get(token + id)!.parts.set(index, Buffer.from(data, 'base64'));
    if (this.losePartAck) {
      this.losePartAck = false;
      throw new DomainError('Connection lost after saving part.', 503);
    }
  }
  async finish(token: string, id: string) {
    const upload = this.uploads.get(token + id)!;
    if (upload.receipt) return upload.receipt;
    const m = upload.manifest,
      previous = this.documents.get(token + m.recordId);
    if (
      previous &&
      (previous.host !== m.hostId ||
        previous.sitting !== m.sittingId ||
        (previous.receipt.revision !== m.expectedRevision && previous.receipt.digest !== m.digest))
    )
      throw new DomainError('Conflicting cloud copy.', 409, 'SYNC_CONFLICT');
    assert.equal(upload.parts.size, m.parts);
    const bytes = Buffer.concat(
      [...upload.parts.entries()].sort((a, b) => a[0] - b[0]).map((p) => p[1]),
    );
    assert.equal(recordDigest(bytes), m.digest);
    const receipt = {
      id: m.recordId,
      revision: previous ? previous.receipt.revision + 1 : 1,
      digest: m.digest,
    };
    if (this.badReceipt) return { ...receipt, digest: 'invalid' };
    upload.receipt = receipt;
    this.documents.set(token + m.recordId, {
      record: JSON.parse(bytes.toString()),
      receipt,
      host: m.hostId,
      sitting: m.sittingId,
    });
    if (this.loseFinishAck) {
      this.loseFinishAck = false;
      throw new DomainError('Connection lost after commit.', 503);
    }
    return receipt;
  }
  async list(token: string, offset: number) {
    return [...this.documents.entries()]
      .filter(([key]) => key.startsWith(token))
      .slice(offset, offset + 20)
      .map(([, d]) => ({
        id: d.record.assessment.id,
        title: d.record.assessment.title,
        course: d.record.assessment.course,
        candidateCount: d.record.candidates.length,
        revision: d.receipt.revision,
        syncedAt: new Date().toISOString(),
      }));
  }
  async read(token: string, id: string) {
    const value = this.documents.get(token + id);
    if (!value) throw new DomainError('Cloud record not found.', 404);
    return value.record;
  }
}
export function cloudFixture(path = ':memory:') {
  const db = openDatabase(path);
  let now = Date.now();
  const store = new ExamStore(db, () => now),
    key = randomBytes(32);
  db.prepare('INSERT INTO administrators VALUES(?,?,?,1)').run(
    'admin',
    'Local',
    'private-password-verifier',
  );
  const identity: CloudSession = {
    userId: randomUUID(),
    name: 'Lecturer',
    email: 'lecturer@example.test',
    accessToken: randomUUID(),
    refreshToken: 'private-refresh-token',
    expiresAt: now + 3600000,
  };
  const provider: CloudAuthProvider = {
    signIn: async () => identity,
    signUp: async () => ({ pending: true }),
    verify: async (s) => s,
  };
  const cloud = new CloudAdministrators(store, provider, key);
  cloud.open(identity, 'admin');
  const records = new MemoryCloud(),
    sync = new CloudSync(store, cloud, records);
  const exam = assessment();
  for (let i = 0; i < 8; i++)
    exam.questions.push({
      ...exam.questions[0],
      id: randomUUID(),
      prompt: 'Question material. '.repeat(400),
    });
  exam.questions.push({
    id: randomUUID(),
    type: 'short',
    prompt: 'Explain.',
    marks: 5,
    options: [],
    correctOptionIds: [],
  });
  const candidate = randomUUID();
  store.createAssessment(
    exam,
    [{ id: candidate, identifier: '001', name: 'Candidate', hash: 'private-candidate-password' }],
    'admin',
  );
  const sitting = store.launch(exam.id, 'admin');
  store.start(sitting.id, candidate);
  store.save(sitting.id, candidate, exam.questions.at(-1)!.id, {
    value: 'α'.repeat(10000),
    expectedRevision: 0,
    operationId: randomUUID(),
  });
  function complete() {
    store.end(exam.id, 'admin');
  }
  return {
    db,
    store,
    records,
    sync,
    cloud,
    identity,
    key,
    provider,
    exam,
    candidate,
    sitting,
    complete,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('completed-record queue excludes credentials, rejects active/foreign exams, and recovers a lost part acknowledgment', async (t) => {
  const f = cloudFixture();
  t.after(() => f.db.close());
  assert.throws(() => f.sync.enqueue('admin', [f.exam.id]), /Finish/);
  assert.throws(() => f.sync.enqueue('another-admin', [f.exam.id]), /Connect|not found/);
  f.complete();
  const document = f.sync.snapshot(f.exam.id, 'admin');
  assert.equal(document.candidates[0].grade!.pendingManual, 1);
  assert.doesNotMatch(
    JSON.stringify(document),
    /private-password|private-candidate|private-refresh|accessToken|credential_hash|password_hash/,
  );
  assert.throws(() => f.sync.enqueue('admin', [f.exam.id, randomUUID()]), /not found/);
  assert.equal(f.db.prepare('select count(*) as n from cloud_sync_jobs').get()!.n, 0);
  const [job] = f.sync.enqueue('admin', [f.exam.id]);
  assert.deepEqual(f.sync.enqueue('admin', [f.exam.id]), [job]);
  f.records.losePartAck = true;
  await f.sync.pump();
  assert.equal(f.sync.status('admin', true).items[0].state, 'retry');
  f.advance(15001);
  const recovered = new CloudSync(f.store, f.cloud, f.records);
  await recovered.pump();
  assert.equal(recovered.status('admin', true).items[0].state, 'synced');
  assert.deepEqual(f.records.partsSent, [0, 1]);
  assert.equal(
    f.db.prepare('select payload from cloud_sync_jobs where id=?').get(job)!.payload,
    '',
  );
  assert.ok(f.store.responses(f.store.findAttempt(f.sitting.id, f.candidate)!.id));
  assert.deepEqual(
    recovered.enqueue('admin', [f.exam.id]),
    [job],
    'sync audit events must not create spurious revisions',
  );
  f.store.mark(
    f.exam.id,
    f.candidate,
    { questionId: f.exam.questions.at(-1)!.id, score: 4, expectedRevision: 0 },
    'admin',
  );
  const [updated] = recovered.enqueue('admin', [f.exam.id]);
  assert.notEqual(updated, job);
  await recovered.pump();
  assert.equal((await recovered.read('admin', f.exam.id)).candidates[0].grade!.pendingManual, 0);
  assert.equal(recovered.status('admin', true).items[0].revision, 2);
});

test('lost commit acknowledgments resume with the same receipt; malformed receipts never mark synced', async (t) => {
  const f = cloudFixture();
  t.after(() => f.db.close());
  f.complete();
  f.records.loseFinishAck = true;
  const [job] = f.sync.enqueue('admin', [f.exam.id]);
  await f.sync.pump();
  assert.equal(f.sync.status('admin', true).items[0].state, 'retry');
  f.advance(15001);
  await f.sync.pump();
  assert.equal(f.sync.status('admin', true).items[0].revision, 1);
  assert.equal(f.records.documents.size, 1);
  const other = cloudFixture();
  t.after(() => other.db.close());
  other.complete();
  other.records.badReceipt = true;
  other.sync.enqueue('admin', [other.exam.id]);
  await other.sync.pump();
  assert.equal(other.sync.status('admin', true).items[0].state, 'retry');
  assert.notEqual(other.db.prepare('select payload from cloud_sync_jobs').get()!.payload, '');
  assert.equal(f.sync.status('someone-else', true).items.length, 0);
  assert.throws(() => f.sync.retry('someone-else', job), /not found/);
});

test('conflicting cloud revisions are quarantined and cannot be forced through Retry', async (t) => {
  const f = cloudFixture();
  t.after(() => f.db.close());
  f.complete();
  f.sync.enqueue('admin', [f.exam.id]);
  await f.sync.pump();
  const remote = f.records.documents.get(f.identity.accessToken + f.exam.id)!;
  remote.host = randomUUID();
  f.store.mark(
    f.exam.id,
    f.candidate,
    { questionId: f.exam.questions.at(-1)!.id, score: 3, expectedRevision: 0 },
    'admin',
  );
  const [job] = f.sync.enqueue('admin', [f.exam.id]);
  await f.sync.pump();
  assert.equal(f.sync.status('admin', true).items[0].state, 'conflict');
  assert.throws(() => f.sync.retry('admin', job), /conflicting/);
  assert.notEqual(
    f.db.prepare('select payload from cloud_sync_jobs where id=?').get(job)!.payload,
    '',
  );
  assert.equal(remote.record.candidates[0].grade!.pendingManual, 1);
});

test('queued records, Host identity and encrypted authorization survive a real database restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mudu-cloud-restart-')),
    path = join(directory, 'exam.sqlite');
  const f = cloudFixture(path);
  f.complete();
  const [job] = f.sync.enqueue('admin', [f.exam.id]);
  const host = f.db.prepare('select id from cloud_instance').get()!.id;
  f.db.prepare("update cloud_sync_jobs set state='uploading' where id=?").run(job);
  f.db.close();
  const db = openDatabase(path);
  try {
    const store = new ExamStore(db),
      cloud = new CloudAdministrators(store, f.provider, f.key),
      sync = new CloudSync(store, cloud, f.records);
    assert.equal(db.prepare('select id from cloud_instance').get()!.id, host);
    assert.equal(sync.status('admin', true).items[0].state, 'retry');
    await sync.pump();
    assert.equal(sync.status('admin', true).items[0].state, 'synced');
  } finally {
    db.close();
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  }
});

test('cloud HTTP access is authenticated, owner-scoped, CSRF-protected and exports an exam-specific filename', async (t) => {
  const f = cloudFixture();
  f.complete();
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on(
    'request',
    await createHandler(f.db, {
      origin: base,
      cloudAuth: { provider: f.provider, sessionKey: f.key },
      cloudRecords: f.records,
    }),
  );
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.db.close();
  });
  const session = f.cloud.open(f.identity);
  const other = f.cloud.open({
    ...f.identity,
    userId: randomUUID(),
    email: 'other@example.test',
    accessToken: randomUUID(),
  });
  function request(path: string, method = 'GET', input?: unknown, who = session, csrf = who.csrf) {
    return fetch(base + '/api' + path, {
      method,
      headers: {
        Origin: base,
        Cookie: `mudu_session=${who.raw}`,
        'X-CSRF-Token': csrf,
        'Content-Type': 'application/json',
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
  }
  assert.equal((await fetch(base + '/api/cloud-sync/status')).status, 401);
  assert.equal(
    (await request('/cloud-sync/queue', 'POST', { assessmentIds: [f.exam.id] }, session, 'invalid'))
      .status,
    403,
  );
  assert.equal(
    (await request('/cloud-sync/queue', 'POST', { assessmentIds: [f.exam.id] }, other)).status,
    404,
  );
  const candidate = f.store.createSession('candidate', f.candidate, f.sitting.id);
  assert.equal((await request('/cloud-sync/status', 'GET', undefined, candidate)).status, 403);
  assert.equal(
    (await request('/cloud-sync/queue', 'POST', { assessmentIds: [f.exam.id] })).status,
    202,
  );
  let status;
  for (let i = 0; i < 10; i++) {
    status = await (await request('/cloud-sync/status')).json();
    if (status.items[0].state === 'synced') break;
  }
  assert.equal(status.items[0].state, 'synced');
  assert.equal(
    (await (await request('/cloud-sync/status', 'GET', undefined, other)).json()).items.length,
    0,
  );
  assert.equal(
    (await request(`/cloud-sync/jobs/${status.items[0].id}/retry`, 'POST', {}, other)).status,
    404,
  );
  assert.equal(
    (await request(`/cloud-sync/records/${f.exam.id}`, 'GET', undefined, other)).status,
    404,
  );
  const list = await (await request('/cloud-sync/records')).json();
  assert.equal(list.records.length, 1);
  const csv = await request(`/cloud-sync/records/${f.exam.id}/results.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition')!, /Foundations/);
  assert.match(await csv.text(), /Candidate ID/);
  assert.equal((await request('/cloud-sync/records?offset=-1')).status, 400);
});

test('background cloud synchronization waits while any examination is running', async (t) => {
  const f = cloudFixture();
  t.after(() => f.db.close());
  f.complete();
  f.sync.enqueue('admin', [f.exam.id]);
  const another = assessment();
  f.store.createAssessment(
    another,
    [{ id: randomUUID(), identifier: '002', name: 'Another', hash: 'local-only' }],
    'admin',
  );
  f.store.launch(another.id, 'admin');
  assert.equal(f.sync.status('admin', true).pausedForExam, true);
  await f.sync.pump();
  assert.equal(f.records.uploads.size, 0);
  f.store.end(another.id, 'admin');
  await f.sync.pump();
  assert.equal(f.sync.status('admin', true).items[0].state, 'synced');
});

test('a provider outage cannot block bootstrap or password-authenticated offline Host access', async (t) => {
  const f = cloudFixture();
  const password = 'native fallback testing password';
  f.db
    .prepare('update administrators set password_hash=? where id=?')
    .run(await hashPassword(password), 'admin');
  const session = f.cloud.open(f.identity);
  f.provider.verify = async () => {
    throw new DomainError('Provider unavailable', 503);
  };
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on(
    'request',
    await createHandler(f.db, {
      origin: base,
      cloudAuth: { provider: f.provider, sessionKey: f.key },
      cloudRecords: f.records,
    }),
  );
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.db.close();
  });
  const cookie = `mudu_session=${session.raw}`;
  const auth = await fetch(base + '/api/auth', { headers: { Cookie: cookie } });
  assert.equal(auth.status, 200);
  assert.equal((await auth.json()).cloudSignedIn, true);
  assert.equal(
    (await fetch(base + '/api/assessments', { headers: { Cookie: cookie } })).status,
    503,
  );
  const local = await fetch(base + '/api/admin/login', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  assert.equal(local.status, 200);
  const localCookie = local.headers.get('set-cookie')!.split(';')[0];
  assert.equal(
    (await fetch(base + '/api/assessments', { headers: { Cookie: localCookie } })).status,
    200,
  );
  assert.equal(
    (await (await fetch(base + '/api/auth', { headers: { Cookie: localCookie } })).json())
      .cloudSignedIn,
    false,
  );
});
