import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { assessment } from './fixtures.ts';

test('PostgreSQL cloud migration enforces tenant isolation, resumable uploads, checksums, receipts and execution authority', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  const owner = randomUUID(),
    stranger = randomUUID(),
    host = randomUUID(),
    sitting = randomUUID();
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;
    insert into auth.users values('${owner}'),('${stranger}');`);
  await db.exec(
    readFileSync(
      new URL('../supabase/migrations/202610050001_exam_records.sql', import.meta.url),
      'utf8',
    ),
  );
  const exam = assessment();
  const initial = {
    version: 1,
    assessment: exam,
    sitting: { id: sitting, startedAt: 1, deadline: 2 },
    candidates: [
      {
        id: randomUUID(),
        status: 'submitted',
        name: 'Candidate',
        identifier: '001',
        responses: { essay: { value: 'α'.repeat(40000), revision: 1, savedAt: 1 } },
      },
    ],
    events: [],
  };
  async function become(id: string) {
    await db.exec(
      `reset role; select set_config('request.jwt.claim.sub','${id}',false);set role authenticated;`,
    );
  }
  async function rpc<T>(name: string, parameters: unknown[]) {
    const result = await db.query<{ value: T }>(
      `select public.${name}(${parameters.map((_, i) => '$' + (i + 1)).join(',')}) as value`,
      parameters,
    );
    return result.rows[0].value;
  }
  function upload(document = initial, revision = 0, authority = host) {
    const bytes = Buffer.from(JSON.stringify(document)),
      id = randomUUID(),
      digest = createHash('sha256').update(bytes).digest('hex');
    const chunks: Buffer[] = [];
    for (let i = 0; i < bytes.length; i += 65536) chunks.push(bytes.subarray(i, i + 65536));
    return {
      id,
      digest,
      chunks,
      begin: () =>
        rpc<{ received: number[]; revision: number | null }>('mudu_begin_exam_upload', [
          id,
          exam.id,
          sitting,
          authority,
          revision,
          digest,
          bytes.length,
          chunks.length,
        ]),
      put: (i: number) => rpc('mudu_put_exam_part', [id, i, chunks[i].toString('base64')]),
      finish: () =>
        rpc<{ id: string; revision: number; digest: string }>('mudu_finish_exam_upload', [id]),
    };
  }
  await become(owner);
  assert.equal(await rpc('mudu_cloud_version', []), 1);
  await assert.rejects(
    () =>
      db.query('insert into public.mudu_exam_records(owner_id,record_id) values($1,$2)', [
        owner,
        exam.id,
      ]),
    /permission denied/,
  );
  const first = upload();
  assert.deepEqual((await first.begin()).received, []);
  await first.put(0);
  assert.deepEqual((await first.begin()).received, [0]);
  await assert.rejects(() => first.finish(), /incomplete/);
  assert.equal((await db.query('select record_id from public.mudu_exam_records')).rows.length, 0);
  const wrong = Buffer.from(first.chunks[0]);
  wrong[0] ^= 1;
  await assert.rejects(
    () => rpc('mudu_put_exam_part', [first.id, 0, wrong.toString('base64')]),
    /conflict/,
  );
  await first.put(0);
  await first.put(1);
  const receipt = await first.finish();
  assert.equal(receipt.revision, 1);
  assert.equal(receipt.digest, first.digest);
  assert.deepEqual(await first.finish(), receipt);
  assert.equal((await first.begin()).revision, 1);
  const visible = await db.query<{ title: string; candidate_count: number }>(
    'select title,candidate_count from public.mudu_exam_records',
  );
  assert.equal(visible.rows[0].title, exam.title);
  assert.equal(visible.rows[0].candidate_count, 1);
  await become(stranger);
  assert.equal((await db.query('select record_id from public.mudu_exam_records')).rows.length, 0);
  await assert.rejects(() => first.finish(), /missing/);
  await assert.rejects(() => first.put(0), /missing/);
  await assert.rejects(() => db.query('select * from public.mudu_exam_parts'), /permission denied/);
  await become(owner);
  const changed = { ...initial, assessment: { ...exam, title: 'Updated marking copy' } };
  const second = upload(changed, 1);
  await second.begin();
  for (let i = 0; i < second.chunks.length; i++) await second.put(i);
  assert.equal((await second.finish()).revision, 2);
  assert.deepEqual(await first.finish(), receipt);
  const competing = upload({ ...changed, assessment: { ...exam, title: 'Conflicting copy' } }, 1);
  await competing.begin();
  for (let i = 0; i < competing.chunks.length; i++) await competing.put(i);
  await assert.rejects(() => competing.finish(), /Revision conflict/);
  const otherHost = upload(changed, 2, randomUUID());
  await otherHost.begin();
  for (let i = 0; i < otherHost.chunks.length; i++) await otherHost.put(i);
  await assert.rejects(() => otherHost.finish(), /authority conflict/);
  const corrupted = upload(changed, 2);
  await corrupted.begin();
  for (let i = 0; i < corrupted.chunks.length; i++) {
    const part = Buffer.from(corrupted.chunks[i]);
    if (i === 0) part[0] ^= 1;
    await rpc('mudu_put_exam_part', [corrupted.id, i, part.toString('base64')]);
  }
  await assert.rejects(() => corrupted.finish(), /checksum mismatch/);
  assert.equal(
    (await db.query<{ title: string }>('select title from public.mudu_exam_records')).rows[0].title,
    'Updated marking copy',
  );
  await db.exec('reset role;set role anon;');
  await assert.rejects(() => rpc('mudu_cloud_version', []), /permission denied/);
  await assert.rejects(
    () => db.query('select * from public.mudu_exam_records'),
    /permission denied/,
  );
});
