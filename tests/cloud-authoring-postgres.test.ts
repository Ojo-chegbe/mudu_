import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { canonicalBank } from '../apps/host/cloud-question-bank.ts';
import { assessmentInput } from '../packages/contracts/assessment-authoring.ts';
import { assessment } from './fixtures.ts';
import type {
  AuthoringDocument,
  AuthoringReceipt,
  AuthoringRecord,
} from '../packages/contracts/cloud-authoring.ts';

test('PostgreSQL authoring migration enforces private reads, confirmed writes, CAS, idempotence and immutable delivery authority', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  const owner = randomUUID(),
    other = randomUUID(),
    unconfirmed = randomUUID();
  await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated,anon;`);
  for (const id of [owner, other, unconfirmed])
    await db.query('insert into auth.users values($1,$2)', [
      id,
      id === unconfirmed ? null : '2026-10-05T10:00:00Z',
    ]);
  await db.exec(
    readFileSync(
      new URL('../supabase/migrations/202610050004_assessment_authoring.sql', import.meta.url),
      'utf8',
    ),
  );
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
  const doc: AuthoringDocument = {
    version: 1,
    id: randomUUID(),
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
  await become(null);
  await assert.rejects(rpc('mudu_authoring_list'), /permission denied/);
  await assert.rejects(
    db.query('select * from public.mudu_authoring_documents'),
    /permission denied/,
  );
  await become(unconfirmed);
  await assert.rejects(
    rpc('mudu_authoring_write', [0, canonicalBank(doc)]),
    /Confirmed authentication/,
  );
  await become(owner);
  const first = await rpc<AuthoringReceipt>('mudu_authoring_write', [0, canonicalBank(doc)]);
  assert.equal(first.revision, 1);
  assert.equal(
    (await rpc<AuthoringReceipt>('mudu_authoring_write', [0, canonicalBank(doc)])).revision,
    1,
  );
  await assert.rejects(
    db.query("update public.mudu_authoring_documents set payload='{}'"),
    /permission denied/,
  );
  assert.equal(
    (await rpc<AuthoringRecord>('mudu_authoring_read', [doc.id])).payload,
    canonicalBank(doc),
  );
  await become(other);
  assert.deepEqual(await rpc('mudu_authoring_list'), []);
  await assert.rejects(rpc('mudu_authoring_read', [doc.id]), /not found/);
  await assert.rejects(
    rpc('mudu_authoring_write', [
      1,
      canonicalBank({ ...doc, input: { ...doc.input, title: 'Hijacked' } }),
    ]),
    /unavailable/,
  );
  assert.equal((await db.query('select * from public.mudu_authoring_documents')).rows.length, 0);
  await become(owner);
  const changed = { ...doc, input: { ...doc.input, title: 'New title' } };
  await assert.rejects(rpc('mudu_authoring_write', [0, canonicalBank(changed)]), /changed/);
  const updated = await rpc<AuthoringReceipt>('mudu_authoring_write', [1, canonicalBank(changed)]);
  assert.equal(updated.revision, 2);
  await assert.rejects(
    rpc('mudu_authoring_write', [2, canonicalBank({ ...changed, executionHostId: randomUUID() })]),
    /authority/,
  );
  await assert.rejects(
    rpc('mudu_authoring_write', [2, canonicalBank({ ...changed, password: 'not-allowed' })]),
    /Unsupported/,
  );
  await assert.rejects(
    rpc('mudu_authoring_write', [
      2,
      canonicalBank({ version: 1, id: doc.id, kind: 'draft', draft: null }),
    ]),
    /authority/,
  );
  const { questions, ...details } = doc.input,
    id = randomUUID(),
    draft = {
      requestId: id,
      createdId: null,
      step: 1,
      details,
      questions,
      candidates: [{ identifier: '001', name: 'Student', credential: '' }],
      accessMode: 'accounts',
      registrationPolicy: 'approval',
      registrationCloses: '',
      registrationCapacity: 100,
      keysSaved: false,
      useRoster: false,
      accessChoiceConfirmed: true,
      roster: null,
    };
  await rpc('mudu_authoring_write', [0, canonicalBank({ version: 1, id, kind: 'draft', draft })]);
  await assert.rejects(
    rpc('mudu_authoring_write', [
      1,
      canonicalBank({
        version: 1,
        id,
        kind: 'draft',
        draft: {
          ...draft,
          candidates: [{ identifier: '001', name: 'Student', credential: 'password' }],
        },
      }),
    ]),
    /Credentials/,
  );
  await rpc('mudu_authoring_write', [
    1,
    canonicalBank({ version: 1, id, kind: 'draft', draft: null }),
  ]);
  assert.equal((await rpc<AuthoringRecord>('mudu_authoring_read', [id])).revision, 2);
  await assert.rejects(
    rpc('mudu_authoring_write', [
      0,
      canonicalBank({
        version: 1,
        id: randomUUID(),
        kind: 'assessment',
        input: { ...doc.input, instructions: 'x'.repeat(1048577) },
      }),
    ]),
    /Invalid assessment/,
  );
});
