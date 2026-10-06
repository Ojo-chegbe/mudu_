import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { canonicalBank } from '../apps/host/cloud-question-bank.ts';
import { digest } from '../apps/host/security.ts';

test('cloud question-bank PostgreSQL migration enforces RLS, atomic writes and revision conflicts', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  const owner = randomUUID(),
    other = randomUUID(),
    project = randomUUID(),
    question = randomUUID();
  await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;insert into auth.users values('${owner}'),('${other}');`);
  await db.exec(
    readFileSync(
      new URL('../supabase/migrations/202610050002_question_bank.sql', import.meta.url),
      'utf8',
    ),
  );
  async function become(id: string) {
    await db.exec(
      `reset role;select set_config('request.jwt.claim.sub','${id}',false);set role authenticated;`,
    );
  }
  async function rpc<T>(name: string, params: unknown[] = []) {
    return (
      await db.query<{ value: T }>(
        `select public.${name}(${params.map((_, i) => '$' + (i + 1)).join(',')}) as value`,
        params,
      )
    ).rows[0].value;
  }
  const snapshot = {
    version: 1,
    projects: [
      {
        id: project,
        name: 'Pharmacology',
        course: 'PCH 401',
        description: '',
        archived: false,
        revision: 1,
        updatedAt: 1,
      },
    ],
    questions: [
      {
        id: question,
        projectId: project,
        question: {
          type: 'single',
          prompt: 'Which option?',
          marks: 1,
          options: ['A', 'B'],
          correctIndices: [0],
        },
        course: 'PCH 401',
        topic: 'Topic',
        difficulty: 'medium',
        tags: [],
        explanation: '',
        revision: 1,
        status: 'draft',
        updatedAt: 1,
        origin: 'manual',
        evidence: '',
        model: null,
        deletedAt: null,
        creationFingerprint: 'a'.repeat(64),
      },
    ],
  };
  await become(owner);
  assert.deepEqual(await rpc('mudu_bank_metadata'), { revision: 0, digest: '' });
  const payload = canonicalBank(snapshot);
  const first = await rpc<{ revision: number; digest: string }>('mudu_write_bank', [0, payload]);
  assert.equal(first.revision, 1);
  assert.equal(first.digest, digest(payload));
  assert.deepEqual(
    await rpc('mudu_write_bank', [0, payload]),
    first,
    'A lost receipt must be replayable',
  );
  assert.deepEqual((await rpc<{ snapshot: unknown }>('mudu_read_bank')).snapshot, snapshot);
  await assert.rejects(
    () => db.query('delete from public.mudu_bank_questions'),
    /permission denied/,
  );
  await become(other);
  assert.equal((await db.query('select * from public.mudu_bank_projects')).rows.length, 0);
  assert.equal((await db.query('select * from public.mudu_bank_questions')).rows.length, 0);
  assert.deepEqual(await rpc('mudu_bank_metadata'), { revision: 0, digest: '' });
  await become(owner);
  const updated = structuredClone(snapshot);
  updated.questions[0].question.prompt = 'Updated';
  updated.questions[0].revision = 2;
  const second = await rpc<{ revision: number }>('mudu_write_bank', [1, canonicalBank(updated)]);
  assert.equal(second.revision, 2);
  await assert.rejects(() => rpc('mudu_write_bank', [1, payload]), /changed/);
  const invalid = structuredClone(updated);
  invalid.questions[0].projectId = randomUUID();
  await assert.rejects(() => rpc('mudu_write_bank', [2, canonicalBank(invalid)]), /foreign key/);
  assert.equal((await rpc<{ revision: number }>('mudu_bank_metadata')).revision, 2);
  assert.deepEqual((await rpc<{ snapshot: unknown }>('mudu_read_bank')).snapshot, updated);
  const duplicates = structuredClone(updated);
  duplicates.projects.push(duplicates.projects[0]);
  await assert.rejects(() => rpc('mudu_write_bank', [2, canonicalBank(duplicates)]), /duplicate/);
  await db.exec('reset role;set role anon;');
  await assert.rejects(() => rpc('mudu_read_bank'), /permission denied/);
  await assert.rejects(() => rpc('mudu_write_bank', [0, payload]), /permission denied/);
  await assert.rejects(
    () => db.query('select * from public.mudu_bank_questions'),
    /permission denied/,
  );
});
