import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../apps/host/database.ts';
import { ExamStore } from '../apps/host/store.ts';
import { CloudAdministrators } from '../apps/host/cloud-administrators.ts';
import { CloudCandidates } from '../apps/host/cloud-candidates.ts';
import { createHandler } from '../apps/host/http.ts';
import type { CloudSession, CloudAuthProvider } from '../apps/host/supabase-auth.ts';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { OnlineExecution } from '../apps/host/online-execution.ts';
import type { OnlineActor } from '../apps/host/online-execution.ts';
import type { OnlineDatabase } from '../apps/host/online-postgres.ts';
import { onlineDatabase } from '../apps/host/online-postgres.ts';
import { deliveryApiPath } from '../apps/web/api.ts';
import { AssessmentEditing } from '../apps/host/assessment-editing.ts';
import type { AuthoringStorage } from '../apps/host/cloud-authoring-storage.ts';
import type { AuthoringRecord } from '../packages/contracts/cloud-authoring.ts';
import { digest } from '../apps/host/security.ts';
import type { OnlineMember } from '../apps/host/online-runtime.ts';
import type { CandidateView } from '../packages/exam-core/model.ts';
import { assessment } from './fixtures.ts';

async function fixture(
  t: { after: (fn: () => Promise<void>) => void },
  individual = false,
  essay = false,
  roster = false,
) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`create role anon;create role authenticated;
    create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table public.mudu_authoring_documents(id uuid primary key,owner_id uuid,revision bigint,digest text,document jsonb);
    create table public.mudu_roster_members(roster_id uuid,owner_id uuid,account_id uuid,identifier text,status text);`);
  await db.exec(
    readFileSync(
      new URL('../supabase/migrations/202610060002_online_execution.sql', import.meta.url),
      'utf8',
    ),
  );
  const paper = assessment(),
    owner = randomUUID(),
    candidate = randomUUID(),
    other = randomUUID();
  const rosterId = roster ? randomUUID() : null;
  if (roster) paper.allowLateAdmission = true;
  if (individual)
    paper.timing = {
      mode: 'individual',
      opensAt: Date.now() - 1000,
      lastStartAt: Date.now() + 3600000,
      finishBy: null,
    };
  if (essay)
    paper.questions.push({
      id: randomUUID(),
      type: 'short',
      prompt: 'Explain your reasoning.',
      marks: 5,
      options: [],
      correctOptionIds: [],
    });
  for (const id of [owner, candidate, other])
    await db.query('insert into auth.users values($1,$2,now(),\'{"name":"Candidate"}\')', [
      id,
      id + '@example.test',
    ]);
  await db.query("insert into mudu_authoring_documents values($1,$2,1,'source-digest',$3)", [
    paper.id,
    owner,
    JSON.stringify({ roster: rosterId ? { id: rosterId } : null }),
  ]);
  const member: OnlineMember = {
    exam_id: paper.id,
    owner_id: owner,
    account_id: candidate,
    candidate_id: randomUUID(),
    registration_id: randomUUID(),
    identifier: '001',
    name: 'Test Candidate',
    email: 'candidate@example.test',
    status: 'approved',
    requested_at: Date.now(),
    reviewed_at: Date.now(),
  };
  const database: OnlineDatabase = {
    connect: async () => ({
      query: async (sql, values) => db.query(sql, values),
      release: () => {},
    }),
    end: async () => {},
  };
  const engine = new OnlineExecution(database);
  const admin: OnlineActor = { id: owner, role: 'admin', device: 'admin-device' },
    student: OnlineActor = { id: candidate, role: 'candidate', device: 'candidate-device' };
  await engine.publish(admin, paper, 1, 'source-digest', [member]);
  return { db, paper, owner, candidate, other, member, engine, admin, student, rosterId };
}

test('online attempts persist order, idempotent answer receipts, submission and grading across server instances', async (t) => {
  const { paper, engine, admin, student } = await fixture(t);
  await engine.command(student, paper.id, { kind: 'start' });
  const first = (await engine.command(student, paper.id, { kind: 'state' })) as CandidateView;
  assert.ok(first.attempt);
  assert.equal(JSON.stringify(first).includes('correctOptionIds'), false);
  const q = paper.questions[0],
    input = { value: q.correctOptionIds, expectedRevision: 0, operationId: randomUUID() };
  const receipt = await engine.command(student, paper.id, {
    kind: 'save',
    questionId: q.id,
    input,
  });
  assert.deepEqual(
    await engine.command(student, paper.id, { kind: 'save', questionId: q.id, input }),
    receipt,
  );
  const restarted = new OnlineExecution(engine.database);
  const restored = (await restarted.command(student, paper.id, { kind: 'state' })) as CandidateView;
  assert.deepEqual(restored.attempt?.questions, first.attempt.questions);
  assert.deepEqual(restored.attempt?.responses[q.id].value, q.correctOptionIds);
  await restarted.command(student, paper.id, { kind: 'submit' });
  const ended = (await restarted.command(student, paper.id, { kind: 'state' })) as CandidateView;
  assert.equal(ended.attempt?.status, 'submitted');
  await assert.rejects(() =>
    restarted.command(student, paper.id, {
      kind: 'save',
      questionId: q.id,
      input: { ...input, operationId: randomUUID(), expectedRevision: 1 },
    }),
  );
  const detail = await restarted.command(admin, paper.id, { kind: 'detail' });
  assert.ok(detail);
});

test('online controls preserve announcements, pause policy, time extensions and audit records', async (t) => {
  const { paper, engine, admin, student, member } = await fixture(t, true);
  const initial = (await engine.command(student, paper.id, { kind: 'start' })) as CandidateView;
  assert.ok(initial.attempt);
  let revision = 0;
  const control = (action: string, extra: Record<string, unknown> = {}) =>
    engine.command(admin, paper.id, {
      kind: 'control',
      input: {
        action,
        expectedRevision: revision++,
        operationId: randomUUID(),
        reason: 'Approved adjustment',
        ...extra,
      },
    });
  await control('announce', { message: 'Please read question two carefully.' });
  let view = (await engine.command(student, paper.id, { kind: 'state' })) as CandidateView;
  assert.equal(view.announcements?.[0].message, 'Please read question two carefully.');
  await engine.command(student, paper.id, {
    kind: 'acknowledge',
    input: { id: view.announcements![0].id },
  });
  view = (await engine.command(student, paper.id, { kind: 'state' })) as CandidateView;
  assert.equal(view.announcements![0].read, true);
  await control('pause');
  await assert.rejects(
    () =>
      engine.command(student, paper.id, {
        kind: 'save',
        questionId: paper.questions[0].id,
        input: {
          value: paper.questions[0].correctOptionIds,
          expectedRevision: 0,
          operationId: randomUUID(),
        },
      }),
    /paused/,
  );
  await assert.rejects(() => engine.command(student, paper.id, { kind: 'submit' }), /paused/);
  await control('resume');
  await control('extend', { minutes: 10, candidateId: member.candidate_id });
  view = (await engine.command(student, paper.id, { kind: 'state' })) as CandidateView;
  assert.ok(view.attempt!.deadline >= initial.attempt.deadline + 600000);
  await control('force_submit', { candidateId: member.candidate_id });
  view = (await engine.command(student, paper.id, { kind: 'state' })) as CandidateView;
  assert.equal(view.attempt?.status, 'submitted');
  const detail = (await engine.command(admin, paper.id, {
    kind: 'detail',
  })) as import('../packages/contracts/http.ts').AssessmentDetail;
  assert.ok(
    detail.events.some(
      (event) => event.kind === 'exam_force_submit' && event.reason === 'Approved adjustment',
    ),
  );
});

test('online written answers support private manual review and revision-checked marking', async (t) => {
  const { paper, engine, admin, student, member } = await fixture(t, false, true);
  const question = paper.questions.at(-1)!;
  await engine.command(student, paper.id, { kind: 'start' });
  await engine.command(student, paper.id, {
    kind: 'save',
    questionId: question.id,
    input: { value: 'My explanation.', expectedRevision: 0, operationId: randomUUID() },
  });
  await engine.command(student, paper.id, { kind: 'submit' });
  await assert.rejects(() =>
    engine.command(student, paper.id, { kind: 'review', candidateId: member.candidate_id }),
  );
  const detail = (await engine.command(admin, paper.id, {
    kind: 'detail',
  })) as import('../packages/contracts/http.ts').AssessmentDetail;
  assert.equal(detail.candidates[0].grade?.pendingManual, 1);
  await engine.command(admin, paper.id, {
    kind: 'mark',
    candidateId: member.candidate_id,
    input: { questionId: question.id, score: 4, expectedRevision: 0 },
  });
  await assert.rejects(() =>
    engine.command(admin, paper.id, {
      kind: 'mark',
      candidateId: member.candidate_id,
      input: { questionId: question.id, score: 3, expectedRevision: 0 },
    }),
  );
  const graded = (await engine.command(admin, paper.id, {
    kind: 'detail',
  })) as import('../packages/contracts/http.ts').AssessmentDetail;
  assert.equal(graded.candidates[0].grade?.pendingManual, 0);
  assert.equal(graded.candidates[0].grade?.manualScore, 4);
});

test('online directories expose summaries without answer keys or candidates from other workspaces', async (t) => {
  const { paper, engine, admin, student, other } = await fixture(t);
  const directory = await engine.directory(student);
  assert.equal(directory.length, 1);
  assert.equal((directory[0] as { assessmentId: string }).assessmentId, paper.id);
  assert.equal(JSON.stringify(directory).includes('correctOptionIds'), false);
  assert.equal((await engine.directory({ ...admin, id: other })).length, 0);
});

test('online authorization denies unrelated accounts, browser roles and shared-row candidate writes', async (t) => {
  const { db, paper, engine, student, other, member, owner } = await fixture(t);
  await assert.rejects(() =>
    engine.command({ ...student, id: other }, paper.id, { kind: 'state' }),
  );
  await assert.rejects(() => engine.command(student, paper.id, { kind: 'end' }));
  await db.exec(`set role authenticated;`);
  await assert.rejects(() => db.query('select * from mudu_online_exams'));
  await db.exec('reset role;begin;set local role mudu_execution;');
  await db.query(
    "select set_config('request.jwt.claim.sub',$1,true),set_config('mudu.exam_id',$2,true)",
    [student.id, paper.id],
  );
  assert.equal((await db.query('select * from mudu_online_members')).rows.length, 1);
  await assert.rejects(() => db.query('select * from auth.users'));
  await db.exec('rollback;begin;set local role mudu_execution;');
  await db.query(
    "select set_config('request.jwt.claim.sub',$1,true),set_config('mudu.exam_id',$2,true)",
    [student.id, paper.id],
  );
  assert.equal(
    (
      await db.query(
        "update mudu_online_rows set payload='{}' where candidate_id is null returning *",
      )
    ).rows.length,
    0,
  );
  assert.equal(
    (await db.query("update mudu_online_members set status='rejected' returning *")).rows.length,
    0,
  );
  await db.exec('rollback;');
  await db.exec('begin;set local role mudu_execution;');
  await db.query(
    "select set_config('request.jwt.claim.sub',$1,true),set_config('mudu.exam_id',$2,true)",
    [student.id, paper.id],
  );
  await assert.rejects(() =>
    db.query("insert into mudu_online_rows values($1,$2,'manual_marks','forged',$3,'{}')", [
      paper.id,
      owner,
      member.candidate_id,
    ]),
  );
  await db.exec('rollback;');
});

test('roster late admission respects approval, administrator choice, pause and closing without duplicate enrolment', async (t) => {
  const f = await fixture(t, false, false, true);
  const late = { ...f.student, id: f.other, device: 'late-device' };
  await f.db.query("insert into mudu_roster_members values($1,$2,$3,'002','pending')", [
    f.rosterId,
    f.owner,
    f.other,
  ]);
  assert.equal((await f.engine.directory(late)).length, 0);
  await f.db.query("update mudu_roster_members set status='approved' where account_id=$1", [
    f.other,
  ]);
  await f.engine.command(f.admin, f.paper.id, {
    kind: 'control',
    input: {
      action: 'pause',
      reason: 'Network adjustment',
      operationId: randomUUID(),
      expectedRevision: 0,
    },
  });
  assert.equal((await f.engine.directory(late)).length, 0);
  await f.engine.command(f.admin, f.paper.id, {
    kind: 'control',
    input: {
      action: 'resume',
      reason: 'Network restored',
      operationId: randomUUID(),
      expectedRevision: 1,
    },
  });
  assert.equal((await f.engine.directory(late)).length, 1);
  assert.equal((await f.engine.directory(late)).length, 1);
  assert.equal(
    (await f.db.query('select * from mudu_online_members where account_id=$1', [f.other])).rows
      .length,
    1,
  );
  await f.engine.command(f.admin, f.paper.id, {
    kind: 'admission',
    input: { allowLateAdmission: false, expectedAllowLateAdmission: true },
  });
  assert.ok(await f.engine.command(late, f.paper.id, { kind: 'start' }));
  await f.engine.command(f.admin, f.paper.id, { kind: 'end' });
  assert.equal(
    ((await f.engine.command(late, f.paper.id, { kind: 'state' })) as CandidateView).attempt
      ?.status,
    'submitted',
  );
});

test('publication source checks reject stale revisions and other owners without modifying cloud authoring', async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => f.engine.publish(f.admin, f.paper, 2, 'changed', [f.member]), {
    code: 'AUTHORING_CONFLICT',
  });
  const another = assessment();
  await f.db.query("insert into mudu_authoring_documents values($1,$2,2,'current-digest','{}')", [
    another.id,
    f.owner,
  ]);
  await assert.rejects(
    () =>
      f.engine.publish(f.admin, another, 1, 'stale-digest', [
        {
          ...f.member,
          exam_id: another.id,
          candidate_id: randomUUID(),
          registration_id: randomUUID(),
        },
      ]),
    { code: 'AUTHORING_CONFLICT' },
  );
  assert.equal(
    (await f.db.query('select * from mudu_online_exams where id=$1', [another.id])).rows.length,
    0,
  );
});

test('device recovery preserves saved work and invalidates the previous writer', async (t) => {
  const { paper, engine, student } = await fixture(t);
  await engine.command(student, paper.id, { kind: 'start' });
  const second = { ...student, device: 'replacement-device' };
  await assert.rejects(() => engine.command(second, paper.id, { kind: 'state' }), {
    code: 'ONLINE_DEVICE_CHANGED',
  });
  await engine.command(second, paper.id, { kind: 'claim' });
  assert.ok(((await engine.command(second, paper.id, { kind: 'state' })) as CandidateView).attempt);
  await assert.rejects(() => engine.command(student, paper.id, { kind: 'submit' }), {
    code: 'ONLINE_DEVICE_CHANGED',
  });
});

test('authorization revoked during processing rolls back online changes', async (t) => {
  const { paper, engine, student } = await fixture(t);
  await assert.rejects(() =>
    engine.command(student, paper.id, { kind: 'start' }, () => {
      throw new Error('revoked');
    }),
  );
  assert.equal(
    ((await engine.command(student, paper.id, { kind: 'state' })) as CandidateView).attempt,
    null,
  );
});

test('HTTP online journey uses cloud identity, CSRF, PUT autosave, candidate views, controls and named CSV export', async (t) => {
  const f = await fixture(t);
  const native = openDatabase(':memory:');
  t.after(() => native.close());
  const store = new ExamStore(native),
    key = randomBytes(32);
  const cloudSession = (id: string): CloudSession => ({
    userId: id,
    email: id + '@example.test',
    name: 'Test User',
    accessToken: 'test-private-access',
    refreshToken: 'test-private-refresh',
    expiresAt: Date.now() + 3600000,
  });
  const provider: CloudAuthProvider = {
    signIn: async () => cloudSession(f.candidate),
    signUp: async () => ({ pending: true }),
    verify: async (s) => s,
  };
  const adminSession = new CloudAdministrators(store, provider, key).open(cloudSession(f.owner));
  const candidateSession = new CloudCandidates(store, key).open(cloudSession(f.candidate));
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const records = new Map<string, AuthoringRecord>();
  const authoring: AuthoringStorage = {
    list: async () =>
      [...records.values()].map(({ id, revision, digest }) => ({ id, revision, digest })),
    read: async (_token, id) => {
      const record = records.get(id);
      if (!record) throw new Error('Missing record');
      return record;
    },
    write: async (_token, expected, payload) => {
      const doc = JSON.parse(payload),
        old = records.get(doc.id);
      if (old?.digest === digest(payload)) return old;
      assert.equal(expected, old?.revision ?? 0);
      const record = { id: doc.id, revision: expected + 1, digest: digest(payload), payload };
      records.set(doc.id, record);
      await f.db.query(
        'INSERT INTO mudu_authoring_documents VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,document=excluded.document',
        [doc.id, f.owner, record.revision, record.digest, JSON.stringify(doc)],
      );
      return record;
    },
  };
  server.on(
    'request',
    await createHandler(native, {
      origin,
      online: f.engine,
      cloudAuth: { provider, sessionKey: key },
      cloudAuthoring: authoring,
    }),
  );
  const request = (
    path: string,
    method = 'GET',
    body?: unknown,
    session = candidateSession,
    csrf = session.csrf,
  ) =>
    fetch(origin + '/api' + path, {
      method,
      headers: {
        Cookie: 'mudu_session=' + session.raw,
        Origin: origin,
        'X-CSRF-Token': csrf,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  assert.equal(
    (
      await request(
        `/online/candidate/examinations/${f.paper.id}/start`,
        'POST',
        {},
        candidateSession,
        'wrong',
      )
    ).status,
    403,
  );
  const started = await request(`/online/candidate/examinations/${f.paper.id}/start`, 'POST', {});
  assert.equal(started.status, 200);
  const view = (await started.json()) as CandidateView;
  assert.ok(view.attempt);
  assert.equal(JSON.stringify(view).includes('correctOptionIds'), false);
  const question = f.paper.questions[0];
  const saved = await request(
    `/online/candidate/examinations/${f.paper.id}/answers/${question.id}`,
    'PUT',
    { value: question.correctOptionIds, expectedRevision: 0, operationId: randomUUID() },
  );
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).revision, 1);
  assert.equal(
    (
      await request(
        `/online/assessments/${f.paper.id}/controls`,
        'POST',
        {
          action: 'announce',
          message: 'Keep going.',
          expectedRevision: 0,
          operationId: randomUUID(),
        },
        adminSession,
      )
    ).status,
    200,
  );
  const recovered = await request(`/online/candidate/examinations/${f.paper.id}/state`);
  assert.equal((await recovered.json()).announcements[0].message, 'Keep going.');
  const submission = await request(
    `/online/candidate/examinations/${f.paper.id}/submit`,
    'POST',
    {},
  );
  assert.equal(submission.status, 200);
  assert.equal((await submission.json()).attempt.status, 'submitted');
  const csv = await request(
    `/online/assessments/${f.paper.id}/results.csv`,
    'GET',
    undefined,
    adminSession,
  );
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition') ?? '', /Foundations/i);
  assert.match(await csv.text(), /Test Candidate/);
  assert.equal((await request(`/online/assessments/${f.paper.id}`)).status, 403);
  const second = assessment(),
    nativeOwner = store.session(adminSession.raw)!.principal_id,
    nativeCandidate = randomUUID();
  store.createAssessment(
    second,
    [{ id: nativeCandidate, identifier: '001', name: 'Candidate', hash: 'account-managed' }],
    nativeOwner,
    { mode: 'accounts', policy: 'approval', capacity: 500, closesAt: null },
  );
  native
    .prepare('INSERT INTO registrations VALUES(?,?,?,?,?,?,?)')
    .run(randomUUID(), second.id, f.candidate, nativeCandidate, 'approved', Date.now(), Date.now());
  const published = await request(`/assessments/${second.id}/online`, 'POST', {}, adminSession);
  assert.equal(published.status, 200, JSON.stringify(await published.json()));
  assert.equal(
    (await request(`/assessments/${second.id}/launch`, 'POST', {}, adminSession)).status,
    409,
  );
  assert.equal(
    (await request(`/online/assessments/${second.id}/end`, 'POST', {}, adminSession)).status,
    200,
  );
  const rerunInput = {
    title: 'Repeat online examination',
    requestId: randomUUID(),
    includeCandidates: true,
  };
  const rerun = await request(
    `/online/assessments/${second.id}/rerun`,
    'POST',
    rerunInput,
    adminSession,
  );
  const rerunResult = await rerun.json();
  assert.equal(rerun.status, 200, JSON.stringify(rerunResult));
  assert.notEqual(rerunResult.id, second.id);
  assert.equal(store.detail(rerunResult.id).candidates.length, 1);
  const retry = await request(
    `/online/assessments/${second.id}/rerun`,
    'POST',
    rerunInput,
    adminSession,
  );
  assert.equal((await retry.json()).id, rerunResult.id);
});

test('online rerun reuses the frozen paper and admitted identities without copying attempts, scores or passwords', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    () => f.engine.command(f.admin, f.paper.id, { kind: 'rerun_source' }),
    /Finish this assessment/,
  );
  await f.engine.command(f.student, f.paper.id, { kind: 'start' });
  await f.engine.command(f.admin, f.paper.id, { kind: 'end' });
  const source = (await f.engine.command(f.admin, f.paper.id, { kind: 'rerun_source' })) as {
    paper: typeof f.paper;
    members: OnlineMember[];
  };
  const native = openDatabase(':memory:');
  t.after(() => native.close());
  const store = new ExamStore(native);
  const localPaper = structuredClone(f.paper);
  native
    .prepare('INSERT INTO administrators VALUES(?,?,?,NULL)')
    .run(f.owner, 'Administrator', 'supabase-managed');
  localPaper.questions[0].prompt = 'Edited source after publication';
  store.createAssessment(localPaper, [], f.owner, {
    mode: 'accounts',
    policy: 'approval',
    capacity: 500,
    closesAt: null,
  });
  native
    .prepare('INSERT INTO accounts VALUES(?,?,?,?,?)')
    .run(f.candidate, f.member.email, f.member.name, 'supabase-managed', Date.now());
  const input = { title: 'Another run', requestId: randomUUID(), includeCandidates: true };
  const candidates = source.members.map((m) => ({
    account_id: m.account_id,
    identifier: m.identifier,
    name: m.name,
    serial: 0,
  }));
  const editing = new AssessmentEditing(store),
    run = editing.rerun(f.paper.id, f.owner, input, { paper: source.paper, candidates });
  assert.notEqual(run.id, f.paper.id);
  assert.equal(store.assessment(run.id).questions[0].prompt, f.paper.questions[0].prompt);
  assert.notEqual(store.assessment(run.id).questions[0].id, f.paper.questions[0].id);
  assert.equal(store.assessment(f.paper.id).questions[0].prompt, 'Edited source after publication');
  assert.equal(native.prepare('SELECT count(*) n FROM attempts').get()!.n, 0);
  assert.equal(native.prepare('SELECT count(*) n FROM responses').get()!.n, 0);
  assert.equal(
    editing.rerun(f.paper.id, f.owner, input, { paper: source.paper, candidates }).id,
    run.id,
  );
  assert.equal(store.detail(run.id).candidates.length, 1);
});

test('delivery route remapping is exact and does not redirect unrelated resources', () => {
  const id = randomUUID(),
    other = randomUUID();
  assert.equal(
    deliveryApiPath(`/candidate/examinations/${id}/answers/${other}`, `/exam/online/${id}`),
    `/online/candidate/examinations/${id}/answers/${other}`,
  );
  assert.equal(
    deliveryApiPath(`/assessments/${id}/controls`, `/online/assessments/${id}`),
    `/online/assessments/${id}/controls`,
  );
  assert.equal(
    deliveryApiPath(`/assessments/${other}`, `/online/assessments/${id}`),
    `/assessments/${other}`,
  );
  assert.equal(deliveryApiPath('/rosters', `/online/assessments/${id}`), '/rosters');
  assert.equal(
    deliveryApiPath(`/candidate/examinations/${id}/state`, `/exam/assessments/${id}`),
    `/candidate/examinations/${id}/state`,
  );
});

test('unchanged online state reads do not rewrite persisted attempts or answer receipts', async (t) => {
  const f = await fixture(t);
  await f.engine.command(f.student, f.paper.id, { kind: 'start' });
  const q = f.paper.questions[0];
  await f.engine.command(f.student, f.paper.id, {
    kind: 'save',
    questionId: q.id,
    input: { value: q.correctOptionIds, expectedRevision: 0, operationId: randomUUID() },
  });
  const versions = async () =>
    (
      await f.db.query(
        "SELECT table_name,row_key,xmin::text FROM mudu_online_rows WHERE exam_id=$1 AND table_name IN ('attempts','responses','operations') ORDER BY table_name,row_key",
        [f.paper.id],
      )
    ).rows;
  const before = await versions();
  await f.engine.command(f.student, f.paper.id, { kind: 'state' });
  await f.engine.command(f.student, f.paper.id, { kind: 'state' });
  assert.deepEqual(await versions(), before);
});

test('online database configuration strips URI options that could override TLS verification', async () => {
  assert.equal(onlineDatabase({}), null);
  assert.throws(
    () => onlineDatabase({ MUDU_DATABASE_URL: 'not-a-connection' }),
    /PostgreSQL connection/,
  );
  const pool = onlineDatabase({
    MUDU_DATABASE_URL:
      'postgresql://test-user:test-password@database.example.test:5432/postgres?ssl=0&sslmode=disable&host=localhost',
  }) as unknown as {
    options: { ssl: { rejectUnauthorized: boolean }; connectionString: string };
    end: () => Promise<void>;
  };
  assert.equal(pool.options.ssl.rejectUnauthorized, true);
  assert.equal(new URL(pool.options.connectionString).search, '');
  await pool.end();
});
