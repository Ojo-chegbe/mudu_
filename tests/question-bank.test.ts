import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../apps/host/database.ts';
import { ExamStore } from '../apps/host/store.ts';
import { QuestionBank, validateBankContent } from '../apps/host/question-bank.ts';
import { QuestionGeneration, googleGenerate } from '../apps/host/question-generation.ts';
import { createHandler } from '../apps/host/http.ts';
import { DomainError } from '../packages/exam-core/model.ts';
import { parseAssessment } from '../packages/exam-core/engine.ts';
import { emptyBankContent } from '../packages/contracts/question-bank.ts';

const projectIds = new Map<string, string>();
function projectId(owner = 'admin') {
  if (!projectIds.has(owner)) projectIds.set(owner, randomUUID());
  return projectIds.get(owner)!;
}
const content = (owner = 'admin') => ({
  ...emptyBankContent(),
  projectId: projectId(owner),
  course: 'Biology',
  topic: 'Cells',
  tags: ['revision'],
  question: {
    type: 'single' as const,
    prompt: 'Which structure contains genetic material?',
    marks: 2,
    options: ['Nucleus', 'Cell wall'],
    correctIndices: [0],
  },
  explanation: 'The nucleus contains genetic material.',
});
const source =
  'The nucleus contains genetic material. The cell wall supports the cell. These notes describe cell structures and their functions for introductory biology.';
const generated = () =>
  JSON.stringify({
    questions: [
      {
        question: content().question,
        explanation: content().explanation,
      },
    ],
  });
const request = (owner = 'admin') => ({
  projectId: projectId(owner),
  requestId: randomUUID(),
  source,
  course: 'Biology',
  topic: 'Cells',
  type: 'single',
  difficulty: 'medium',
  count: 1,
  consent: true,
});
function fixture() {
  const db = openDatabase(':memory:');
  const store = new ExamStore(db);
  const bank = new QuestionBank(store);
  for (const owner of ['admin', 'other', 'new-user', 'one', 'two', 'three', 'four'])
    bank.saveProject(owner, {
      id: projectId(owner),
      name: 'Biology questions',
      course: 'Biology',
      description: '',
      archived: false,
      expectedRevision: 0,
    });
  return { db, store, bank };
}

test('question drafts require explicit approval, validate answer keys and retain revision history', (t) => {
  const { db, bank } = fixture();
  t.after(() => db.close());
  const input = { ...content(), id: randomUUID(), status: 'draft', expectedRevision: 0 };
  const draft = bank.save('admin', input);
  assert.equal(draft.status, 'draft');
  assert.deepEqual(bank.save('admin', input), draft, 'create retry is idempotent');
  assert.throws(() => bank.select('admin', [{ id: draft.id, revision: 1 }]), /no longer approved/);
  assert.throws(
    () =>
      bank.save('admin', {
        ...draft,
        question: { ...draft.question, correctIndices: [] },
        status: 'approved',
        expectedRevision: 1,
      }),
    /correct answers/,
  );
  assert.throws(
    () =>
      validateBankContent(
        { ...content(), question: { ...content().question, options: ['Nucleus', 'nucleus'] } },
        true,
      ),
    /different/,
  );
  const approved = bank.save('admin', { ...draft, status: 'approved', expectedRevision: 1 });
  assert.equal(approved.revision, 2);
  assert.equal(
    bank.select('admin', [{ id: approved.id, revision: 2 }])[0].prompt,
    content().question.prompt,
  );
  assert.throws(() => bank.select('other', [{ id: approved.id, revision: 2 }]), /not found/);
  assert.throws(() => bank.save('other', { ...approved, expectedRevision: 2 }), /not found/);
  assert.throws(
    () =>
      bank.save('admin', {
        ...draft,
        question: { ...draft.question, prompt: 'Stale question' },
        expectedRevision: 1,
      }),
    /another window/,
  );
  const archived = bank.save('admin', { ...approved, status: 'archived', expectedRevision: 2 });
  assert.throws(
    () => bank.select('admin', [{ id: archived.id, revision: 3 }]),
    /no longer approved/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_revisions').get()?.n, 3);
  assert.equal(
    bank.save('admin', { ...archived, status: 'approved', expectedRevision: 3 }).status,
    'approved',
  );
});

test('bank selection creates independent assessment copies and rejects stale selection', (t) => {
  const { db, bank } = fixture();
  t.after(() => db.close());
  const item = bank.save('admin', {
    ...content(),
    id: randomUUID(),
    status: 'approved',
    expectedRevision: 0,
  });
  const selection = [{ id: item.id, revision: item.revision }];
  const questions = bank.select('admin', selection);
  const exam = parseAssessment(
    {
      title: 'Biology test',
      course: 'Biology',
      durationMinutes: 30,
      passPercent: 50,
      shuffleQuestions: false,
      shuffleOptions: false,
      accessMode: 'accounts',
      candidates: [],
      questions,
    },
    randomUUID,
  ).assessment;
  const before = JSON.stringify(exam);
  bank.save('admin', {
    ...item,
    question: { ...item.question, prompt: 'Changed bank question', correctIndices: [1] },
    expectedRevision: item.revision,
  });
  assert.throws(() => bank.select('admin', selection), /changed/);
  assert.equal(JSON.stringify(exam), before);
  assert.equal(questions[0].prompt, content().question.prompt);
  assert.throws(() => bank.select('admin', []), /1–200/);
});

test('bank search, pagination and status counts are owner scoped', (t) => {
  const { db, bank } = fixture();
  t.after(() => db.close());
  for (let i = 0; i < 32; i++)
    bank.save('admin', {
      ...content(),
      id: randomUUID(),
      status: i === 31 ? 'draft' : 'approved',
      expectedRevision: 0,
    });
  bank.save('other', {
    ...content('other'),
    id: randomUUID(),
    status: 'approved',
    expectedRevision: 0,
  });
  const page = bank.list(
    'admin',
    new URLSearchParams(
      `projectId=${projectId()}&status=approved&q=revision&type=single&difficulty=medium`,
    ),
  );
  assert.equal(page.total, 31);
  assert.equal(page.items.length, 30);
  assert.deepEqual(page.counts, { draft: 1, approved: 31, archived: 0 });
  assert.equal(
    bank.list('admin', new URLSearchParams(`projectId=${projectId()}&offset=30`)).items.length,
    1,
  );
  assert.equal(
    bank.list('admin', new URLSearchParams(`projectId=${projectId()}&q=notpresent`)).total,
    0,
  );
});

test('generation is consent gated, idempotent, draft only, and stores no complete source notes or key', async (t) => {
  const { db, store, bank } = fixture();
  t.after(() => db.close());
  let calls = 0;
  const ai = new QuestionGeneration(
    store,
    async (key, prompt) => {
      calls++;
      assert.equal(key, 'test-key');
      assert.match(prompt, /untrusted reference/);
      assert.doesNotMatch(prompt, /evidence|verbatim|supporting excerpt/);
      return generated();
    },
    'test-key',
  );
  const input = request();
  await assert.rejects(ai.generate('admin', { ...input, consent: false }), /Confirm/);
  assert.equal(calls, 0);
  const result = await ai.generate('admin', input);
  assert.equal(result.status, 'completed');
  assert.equal(result.questionIds.length, 1);
  const item = bank.get(result.questionIds[0], 'admin');
  assert.equal(item.status, 'draft');
  assert.equal(item.origin, 'ai');
  assert.equal(item.evidence, '');
  assert.deepEqual(await ai.generate('admin', input), result);
  assert.equal(calls, 1);
  await assert.rejects(ai.generate('admin', { ...input, count: 2 }), /different notes/);
  assert.throws(() => ai.job(input.requestId, 'other'), /not found/);
  assert.doesNotMatch(JSON.stringify(ai.availability()), /test-key|configured|model/);
  const stored = JSON.stringify(db.prepare('SELECT * FROM bank_generations').all());
  assert.ok(!stored.includes(source));
  assert.ok(!stored.includes('test-key'));
});

test('invalid and duplicate AI output never creates partial batches', async (t) => {
  const { db, store } = fixture();
  t.after(() => db.close());
  const invalid = [
    'not JSON',
    JSON.stringify({ questions: [] }),
    JSON.stringify({
      questions: [
        {
          ...JSON.parse(generated()).questions[0],
          question: { ...content().question, correctIndices: [9] },
        },
      ],
    }),
  ];
  for (const output of invalid) {
    const ai = new QuestionGeneration(store, async () => output, 'test-key');
    await assert.rejects(ai.generate('admin', request()));
  }
  const ai = new QuestionGeneration(
    store,
    async () =>
      JSON.stringify({
        questions: [JSON.parse(generated()).questions[0], JSON.parse(generated()).questions[0]],
      }),
    'test-key',
  );
  await assert.rejects(ai.generate('admin', { ...request(), count: 2 }), /repeated/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_questions').get()?.n, 0);
});

test('source references never block drafts and only lecturer approval makes them usable', async (t) => {
  const { db, store, bank } = fixture();
  t.after(() => db.close());
  for (const evidence of [
    undefined,
    null,
    '',
    'Not present in the supplied material',
    { invalid: true },
  ]) {
    const ai = new QuestionGeneration(
      store,
      async () =>
        JSON.stringify({
          questions: [{ ...JSON.parse(generated()).questions[0], evidence, status: 'approved' }],
        }),
      'test-key',
    );
    const input = request();
    const result = await ai.generate('admin', input);
    assert.equal(result.status, 'completed');
    assert.deepEqual(await ai.generate('admin', input), result);
    const item = bank.get(result.questionIds[0], 'admin');
    assert.equal(item.status, 'draft');
    assert.equal(item.evidence, '');
    assert.throws(
      () => bank.select('admin', [{ id: item.id, revision: item.revision }]),
      /no longer approved/,
    );
    const approved = bank.save('admin', {
      ...item,
      status: 'approved',
      expectedRevision: item.revision,
    });
    assert.deepEqual(bank.select('admin', [{ id: approved.id, revision: approved.revision }]), [
      item.question,
    ]);
  }
});

test('generation accepts complete nested, flat and array question layouts without guessing answers', async (t) => {
  const { db, store, bank } = fixture();
  t.after(() => db.close());
  const nested = JSON.parse(generated()).questions[0];
  const flat = { ...nested.question, explanation: nested.explanation, evidence: nested.evidence };
  const stringQuestion = { ...flat, question: flat.prompt };
  delete (stringQuestion as Record<string, unknown>).prompt;
  for (const output of [
    generated(),
    JSON.stringify({ questions: [flat] }),
    JSON.stringify({ questions: [stringQuestion] }),
    JSON.stringify([flat]),
    '```json\n' + generated() + '\n```',
  ]) {
    const ai = new QuestionGeneration(store, async () => output, 'test-key');
    const result = await ai.generate('admin', request());
    const item = bank.get(result.questionIds[0], 'admin');
    assert.equal(item.question.prompt, content().question.prompt);
    assert.deepEqual(item.question.correctIndices, [0]);
    assert.equal(item.status, 'draft');
  }
});

test('malformed question records produce safe actionable errors and never save a partial batch', async (t) => {
  const { db, store } = fixture();
  t.after(() => db.close());
  const valid = JSON.parse(generated()).questions[0];
  const malformed = [
    null,
    'Just question text',
    [],
    { question: 'A question without answers' },
    { ...valid, question: null },
    { ...valid, question: { ...valid.question, correctIndices: ['A'] } },
    { ...valid, question: { ...valid.question, options: null } },
  ];
  for (const bad of malformed) {
    const ai = new QuestionGeneration(
      store,
      async () => JSON.stringify({ questions: [valid, bad] }),
      'test-key',
    );
    const input = { ...request(), count: 2 };
    await assert.rejects(ai.generate('admin', input), (error) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.status, 502);
      assert.equal(error.code, 'INVALID_GENERATION_OUTPUT');
      assert.doesNotMatch(error.message, /Expected an object|TypeError|correctIndices/);
      assert.match(error.message, /Question 2.*material is unchanged/);
      return true;
    });
    const job = ai.job(input.requestId, 'admin');
    assert.equal(job.status, 'failed');
    assert.doesNotMatch(job.error, /Expected an object/);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_questions').get()?.n, 0);
});

test('old malformed-generation failures are readable when a page is restored', (t) => {
  const { db, store } = fixture();
  t.after(() => db.close());
  const id = randomUUID();
  db.prepare(
    "INSERT INTO bank_generations VALUES(?,?,'old','failed',?,'[]','Expected an object.')",
  ).run(id, 'admin', store.now());
  const ai = new QuestionGeneration(store, async () => generated(), 'test-key');
  assert.match(ai.job(id, 'admin').error, /unreadable format/);
  assert.equal(
    db.prepare('SELECT error FROM bank_generations WHERE id=?').get(id)?.error,
    'Expected an object.',
    'original diagnostic is preserved',
  );
});

test('generation rechecks authorisation and recovers interrupted jobs', async (t) => {
  const { db, store } = fixture();
  t.after(() => db.close());
  let release!: (value: string) => void;
  const ai = new QuestionGeneration(
    store,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    'test-key',
  );
  const input = request();
  const pending = ai.generate('admin', input, () => {
    throw new DomainError('Sign in again', 401);
  });
  assert.equal((await ai.generate('admin', input)).status, 'running');
  release(generated());
  await assert.rejects(pending, /Sign in again/);
  assert.equal(ai.job(input.requestId, 'admin').status, 'failed');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_questions').get()?.n, 0);
  const interrupted = randomUUID();
  db.prepare("INSERT INTO bank_generations VALUES(?,?,'fingerprint','running',?,'[]','')").run(
    interrupted,
    'admin',
    store.now() - 130000,
  );
  assert.equal(ai.job(interrupted, 'admin').status, 'failed');
});

test('missing configuration blocks generation but past per-user usage does not', async (t) => {
  const { db, store } = fixture();
  t.after(() => db.close());
  let calls = 0;
  const ai = new QuestionGeneration(
    store,
    async () => {
      calls++;
      return generated();
    },
    '',
  );
  await assert.rejects(ai.generate('admin', request()), /temporarily unavailable/);
  const configured = new QuestionGeneration(
    store,
    async () => {
      calls++;
      return generated();
    },
    'server-only-key',
  );
  for (let i = 0; i < 40; i++)
    db.prepare(
      "INSERT INTO bank_generations VALUES(?,?,'fingerprint','failed',?,'[]','failed')",
    ).run(randomUUID(), 'admin', store.now());
  assert.equal((await configured.generate('admin', request())).status, 'completed');
  assert.equal(calls, 1);
  assert.equal(ai.availability().available, false);
  assert.equal(configured.availability().retryAt, null);
});

test('shared historical usage no longer limits generation, including after restart', async (t) => {
  const { db, store } = fixture();
  t.after(() => db.close());
  let calls = 0;
  for (let i = 0; i < 100; i++)
    db.prepare(
      "INSERT INTO bank_generations VALUES(?,?,'fingerprint','failed',?,'[]','failed')",
    ).run(randomUUID(), `user-${i}`, store.now());
  const ai = new QuestionGeneration(
    store,
    async () => {
      calls++;
      return generated();
    },
    'server-key',
  );
  assert.equal(ai.availability().available, true);
  assert.equal((await ai.generate('new-user', request('new-user'))).status, 'completed');
  assert.equal(calls, 1);
  const restarted = new QuestionGeneration(store, async () => generated(), 'server-key');
  assert.equal(restarted.availability().available, true);
  db.prepare('UPDATE bank_generations SET created_at=?').run(store.now() - 86400001);
  assert.equal(restarted.availability().available, true);
});

test('concurrent generation is not capped while retries still avoid duplicate jobs', async (t) => {
  const { db, store } = fixture();
  t.after(() => db.close());
  const releases: Array<(value: string) => void> = [];
  const ai = new QuestionGeneration(
    store,
    () => new Promise((resolve) => releases.push(resolve)),
    'server-key',
  );
  const first = request('one');
  const jobs = [
    ai.generate('one', first),
    ai.generate('two', request('two')),
    ai.generate('three', request('three')),
    ai.generate('four', request('four')),
    ai.generate('one', request('one')),
  ];
  assert.equal((await ai.generate('one', first)).status, 'running');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_generations').get()?.n, 5);
  releases.forEach((release) => release(generated()));
  await Promise.all(jobs);
  assert.equal(ai.availability().available, true);
});

test('Google adapter uses a fixed model endpoint, no paid fallback, and safe errors', async (t) => {
  let count = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    count++;
    assert.equal(
      url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemma-4-26b-a4b-it:generateContent',
    );
    assert.equal((init.headers as Record<string, string>)['x-goog-api-key'], 'secret-test-key');
    assert.ok(!url.includes('secret-test-key'));
    return new Response('provider secret error', { status: 429 });
  });
  await assert.rejects(googleGenerate('secret-test-key', 'notes'), /No paid fallback/);
  assert.equal(count, 1);
});

test('Google adapter ignores thought text and rejects blocked or oversized responses', async (t) => {
  let response = JSON.stringify({
    candidates: [
      {
        finishReason: 'STOP',
        content: { parts: [{ thought: true, text: 'private thinking' }, { text: generated() }] },
      },
    ],
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(response));
  assert.equal(await googleGenerate('test-key', 'notes'), generated());
  response = JSON.stringify({
    candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'incomplete' }] } }],
  });
  await assert.rejects(googleGenerate('test-key', 'notes'), /incomplete or blocked/);
  response = 'x'.repeat(256001);
  await assert.rejects(googleGenerate('test-key', 'notes'), /read its response/);
});

test('question bank HTTP routes protect keys and answer content with admin auth and CSRF', async (t) => {
  const { db, store } = fixture();
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on('request', await createHandler(db, { origin }));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  const admin = store.createSession('admin', 'admin', null);
  const candidate = store.createSession('candidate', 'candidate', null);
  for (const path of [
    '/question-bank',
    '/question-bank/ai/status',
    '/question-bank/projects',
    `/question-bank/projects/${projectId()}`,
  ]) {
    assert.equal((await fetch(origin + '/api' + path)).status, 401);
    assert.equal(
      (
        await fetch(origin + '/api' + path, {
          headers: { Cookie: `mudu_session=${candidate.raw}` },
        })
      ).status,
      403,
    );
  }
  const headers = {
    Origin: origin,
    Cookie: `mudu_session=${admin.raw}`,
    'Content-Type': 'application/json',
  };
  const body = JSON.stringify({ key: 'test-key-at-least-twenty-characters' });
  assert.equal(
    (await fetch(origin + '/api/question-bank/ai/config', { method: 'PUT', headers, body })).status,
    403,
  );
  const config = await fetch(origin + '/api/question-bank/ai/config', {
    method: 'PUT',
    headers: { ...headers, 'X-CSRF-Token': admin.csrf },
    body,
  });
  assert.equal(config.status, 404, 'even administrators cannot set a provider key through the API');
  assert.doesNotMatch(await config.text(), /test-key/);
  assert.equal((await fetch(origin + '/api/question-bank/ai/config', { headers })).status, 404);
  const status = await fetch(origin + '/api/question-bank/ai/status', { headers });
  assert.equal(status.status, 200);
  assert.deepEqual(Object.keys(await status.json()).sort(), ['available', 'message', 'retryAt']);
  const projectInput = {
    id: randomUUID(),
    name: 'HTTP project',
    course: 'Biology',
    archived: false,
    expectedRevision: 0,
  };
  assert.equal(
    (
      await fetch(origin + '/api/question-bank/projects', {
        method: 'POST',
        headers,
        body: JSON.stringify(projectInput),
      })
    ).status,
    403,
  );
  const projectResponse = await fetch(origin + '/api/question-bank/projects', {
    method: 'POST',
    headers: { ...headers, 'X-CSRF-Token': admin.csrf },
    body: JSON.stringify(projectInput),
  });
  assert.equal(projectResponse.status, 200);
  const stranger = store.createSession('admin', 'stranger', null);
  assert.equal(
    (
      await fetch(`${origin}/api/question-bank/projects/${projectInput.id}`, {
        headers: { Cookie: `mudu_session=${stranger.raw}` },
      })
    ).status,
    404,
  );
  const input = { ...content(), id: randomUUID(), expectedRevision: 0, status: 'approved' };
  const saved = await fetch(origin + '/api/question-bank', {
    method: 'POST',
    headers: { ...headers, 'X-CSRF-Token': admin.csrf },
    body: JSON.stringify(input),
  });
  assert.equal(saved.status, 200);
  const moveBody = JSON.stringify({
    projectId: projectInput.id,
    selection: [{ id: input.id, revision: 1 }],
  });
  assert.equal(
    (await fetch(origin + '/api/question-bank/move', { method: 'POST', headers, body: moveBody }))
      .status,
    403,
  );
  assert.equal(
    (
      await fetch(origin + '/api/question-bank/move', {
        method: 'POST',
        headers: { ...headers, 'X-CSRF-Token': admin.csrf },
        body: moveBody,
      })
    ).status,
    200,
  );
  const scoped = await fetch(`${origin}/api/question-bank?projectId=${projectInput.id}`, {
    headers,
  });
  assert.equal(scoped.status, 200);
  assert.equal((await scoped.json()).items[0].projectId, projectInput.id);
  const reviewBody = JSON.stringify({
    action: 'delete',
    selection: [{ id: input.id, revision: 2 }],
  });
  assert.equal(
    (
      await fetch(origin + '/api/question-bank/review', {
        method: 'POST',
        headers,
        body: reviewBody,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(origin + '/api/question-bank/review', {
        method: 'POST',
        headers: { ...headers, 'X-CSRF-Token': admin.csrf },
        body: reviewBody,
      })
    ).status,
    200,
  );
  assert.equal((await fetch(`${origin}/api/question-bank/${input.id}`, { headers })).status, 404);
  assert.equal(
    (
      await fetch(`${origin}/api/question-bank/${input.id}`, {
        headers: { Cookie: `mudu_session=${candidate.raw}` },
      })
    ).status,
    403,
  );
});

test('v7 migration preserves existing data and bank records survive reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mudu-bank-migration-'));
  const path = join(dir, 'host.sqlite');
  let db = openDatabase(path);
  try {
    db.prepare('INSERT INTO administrators VALUES(?,?,?,1)').run(
      'admin',
      'Existing admin',
      'unchanged',
    );
    db.exec(
      'DROP TABLE workspace_connections; DROP TABLE account_preferences; DROP TABLE admin_device_sessions; DROP TABLE admin_device_access; DROP TABLE password_recovery; DROP TABLE offline_candidate_sessions; DROP TABLE local_admission; DROP TABLE local_preparations; DROP TABLE authoring_drafts; DROP TABLE candidate_provider_identities; DROP TABLE cloud_sync_jobs; DROP TABLE cloud_instance; DROP TABLE provider_sessions; DROP TABLE admin_provider_identities; DROP TABLE assessment_owners; DROP TABLE exam_control_receipts; DROP TABLE announcement_reads; DROP TABLE exam_announcements; DROP TABLE exam_controls; DROP TABLE candidate_presence; DROP TABLE bank_deleted_questions; DROP TABLE bank_question_projects; DROP TABLE bank_projects; DROP TABLE bank_revisions; DROP TABLE bank_questions; DROP TABLE bank_generations; PRAGMA user_version=7;',
    );
    db.close();
    db = openDatabase(path);
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 20);
    assert.equal(
      db.prepare('SELECT password_hash FROM administrators').get()?.password_hash,
      'unchanged',
    );
    const old = new DatabaseSync(`${path}.before-v8`, { readOnly: true });
    assert.equal(old.prepare('PRAGMA user_version').get()?.user_version, 7);
    old.close();
    const bank = new QuestionBank(new ExamStore(db));
    bank.saveProject('admin', {
      id: projectId(),
      name: 'Biology questions',
      archived: false,
      expectedRevision: 0,
    });
    const item = bank.save('admin', {
      ...content(),
      id: randomUUID(),
      expectedRevision: 0,
      status: 'draft',
    });
    db.close();
    db = openDatabase(path);
    assert.deepEqual(new QuestionBank(new ExamStore(db)).get(item.id, 'admin'), item);
  } finally {
    db.close();
    for (const name of readdirSync(dir)) unlinkSync(join(dir, name));
    rmdirSync(dir);
  }
});
