import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { canonicalBank } from '../apps/host/cloud-question-bank.ts';
import { digest } from '../apps/host/security.ts';
import { assessmentInput } from '../packages/contracts/assessment-authoring.ts';
import { assessment } from './fixtures.ts';
import type { PreparationUpload } from '../apps/host/local-preparation-storage.ts';
import type { LocalExamPass, CandidateLocalPass } from '../packages/contracts/local-preparation.ts';

test('PostgreSQL local preparation enforces ownership, source CAS, private admission, reservation and idempotent retries', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  const owner = randomUUID(),
    other = randomUUID(),
    candidate = randomUUID(),
    unconfirmed = randomUUID();
  await db.exec(
    `create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;`,
  );
  for (const id of [owner, other, candidate, unconfirmed])
    await db.query('insert into auth.users values($1,$2,$3)', [
      id,
      id + '@example.test',
      id === unconfirmed ? null : '2026-10-06T10:00:00Z',
    ]);
  for (const file of [
    '202610050004_assessment_authoring.sql',
    '202610060001_local_preparation.sql',
  ])
    await db.exec(readFileSync(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
  async function become(id: string | null) {
    await db.exec(
      `reset role;select set_config('request.jwt.claim.sub','${id ?? ''}',false);set role ${id ? 'authenticated' : 'anon'};`,
    );
  }
  async function rpc<T>(name: string, args: unknown[] = []) {
    return (
      await db.query<{ v: T }>(
        `select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) v`,
        args,
      )
    ).rows[0].v;
  }
  const source = randomUUID(),
    doc = {
      version: 1,
      id: source,
      kind: 'assessment',
      input: assessmentInput(assessment()),
      executionHostId: randomUUID(),
      roster: null,
      registration: {
        policy: 'approval',
        token: 'a'.repeat(43),
        open: true,
        closesAt: null,
        capacity: 100,
      },
    };
  await become(owner);
  const receipt = await rpc<{ revision: number; digest: string }>('mudu_authoring_write', [
    0,
    canonicalBank(doc),
  ]);
  const id = randomUUID(),
    hostId = randomUUID(),
    runId = randomUUID(),
    candidateId = randomUUID(),
    expiresAt = Date.now() + 86400000,
    sealed = 'sealed-host-private-content';
  const pass: LocalExamPass = {
    version: 1,
    preparationId: id,
    hostId,
    runId,
    accountId: candidate,
    candidateId,
    credential: randomBytes(32).toString('base64url'),
    expiresAt,
    title: doc.input.title,
  };
  const input: PreparationUpload = {
    id,
    sourceId: source,
    sourceRevision: receipt.revision,
    sourceDigest: receipt.digest,
    hostId,
    runId,
    expiresAt,
    title: doc.input.title,
    course: doc.input.course,
    sealed,
    digest: digest(sealed),
    members: [
      {
        accountId: candidate,
        name: 'Candidate',
        email: candidate + '@example.test',
        identifier: '001',
        candidateId,
        registrationId: randomUUID(),
        pass,
      },
    ],
  };
  await become(null);
  await assert.rejects(rpc('mudu_prepare_local', [input]), /permission denied/);
  await become(unconfirmed);
  await assert.rejects(rpc('mudu_prepare_local', [input]), /Confirmed authentication/);
  await become(other);
  await assert.rejects(rpc('mudu_prepare_local', [input]), /Assessment unavailable/);
  await become(owner);
  await assert.rejects(rpc('mudu_prepare_local', [{ ...input, sourceRevision: 99 }]), /changed/);
  await assert.rejects(
    rpc('mudu_prepare_local', [
      { ...input, members: [{ ...input.members[0], email: 'spoof@example.test' }] },
    ]),
    /identity/,
  );
  await assert.rejects(
    rpc('mudu_prepare_local', [
      { ...input, members: [{ ...input.members[0], pass: { ...pass, accountId: other } }] },
    ]),
    /proof/,
  );
  assert.deepEqual(await rpc('mudu_prepare_local', [input]), { id, digest: input.digest });
  await assert.rejects(db.query('select * from public.mudu_local_admission'), /permission denied/);
  await assert.rejects(
    db.query('select * from public.mudu_local_preparations'),
    /permission denied/,
  );
  await assert.rejects(
    rpc('mudu_prepare_local', [{ ...input, id: randomUUID(), runId: randomUUID() }]),
    /reserved/,
  );
  assert.deepEqual(await rpc('mudu_local_status', [id]), { downloaded: 0 });
  await become(other);
  assert.deepEqual(await rpc('mudu_candidate_local_passes'), []);
  await assert.rejects(rpc('mudu_candidate_local_pass', [id]), /unavailable/);
  await assert.rejects(rpc('mudu_local_status', [id]), /unavailable/);
  await assert.rejects(rpc('mudu_close_local', [id, 'cancelled']), /unavailable/);
  await become(candidate);
  const list = await rpc<CandidateLocalPass[]>('mudu_candidate_local_passes');
  assert.equal(list.length, 1);
  assert.equal(list[0].preparationId, id);
  assert.doesNotMatch(JSON.stringify(list), /credential|sealed|members/);
  assert.deepEqual(await rpc('mudu_candidate_local_pass', [id]), pass);
  assert.deepEqual(await rpc('mudu_candidate_local_pass', [id]), pass);
  await become(owner);
  assert.deepEqual(await rpc('mudu_local_status', [id]), { downloaded: 1 });
  const edited = { ...doc, input: { ...doc.input, title: 'Later edit' } };
  await rpc('mudu_authoring_write', [1, canonicalBank(edited)]);
  assert.deepEqual(await rpc('mudu_prepare_local', [input]), { id, digest: input.digest });
  await rpc('mudu_close_local', [id, 'cancelled']);
  await rpc('mudu_close_local', [id, 'cancelled']);
  await assert.rejects(rpc('mudu_close_local', [id, 'completed']), /already closed/);
  await become(candidate);
  assert.deepEqual(await rpc('mudu_candidate_local_passes'), []);
  await assert.rejects(rpc('mudu_candidate_local_pass', [id]), /unavailable/);
});
