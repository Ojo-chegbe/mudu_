import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { canonicalRoster } from '../apps/host/cloud-rosters.ts';
import { digest } from '../apps/host/security.ts';
import type {
  CloudRosterDocument,
  CloudRosterRecord,
  CloudRosterReceipt,
  CloudCandidateGroup,
} from '../packages/contracts/cloud-rosters.ts';

test('PostgreSQL roster migration isolates owners, authenticates candidates, protects new requests and supports invitation retries', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  const owner = randomUUID(),
    other = randomUUID(),
    candidate = randomUUID(),
    second = randomUUID(),
    unconfirmed = randomUUID();
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated,anon;`);
  for (const [id, email, confirmed] of [
    [owner, 'owner@example.test', true],
    [other, 'other@example.test', true],
    [candidate, 'candidate@example.test', true],
    [second, 'second@example.test', true],
    [unconfirmed, 'unconfirmed@example.test', false],
  ] as const)
    await db.query('insert into auth.users values($1,$2,$3,$4)', [
      id,
      email,
      confirmed ? '2026-10-05T10:00:00Z' : null,
      JSON.stringify({ name: 'Confirmed name' }),
    ]);
  await db.exec(
    readFileSync(
      new URL('../supabase/migrations/202610050003_rosters.sql', import.meta.url),
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
  const paper: CloudRosterDocument = {
    version: 1,
    id: randomUUID(),
    name: 'Pharmacy class',
    token: 'g'.repeat(43),
    restricted: false,
    open: true,
    archived: false,
    entries: [],
    members: [],
    invitations: [],
  };
  await become(owner);
  const first = await rpc<CloudRosterReceipt>('mudu_roster_write', [0, canonicalRoster(paper)]);
  assert.equal(first.revision, 1);
  assert.equal(first.digest, digest(canonicalRoster(paper)));
  assert.deepEqual(await rpc('mudu_roster_write', [0, canonicalRoster(paper)]), first);
  assert.equal((await rpc<CloudRosterReceipt[]>('mudu_roster_list')).length, 1);
  await assert.rejects(db.exec('update public.mudu_rosters set revision=900'), /permission denied/);
  await become(other);
  assert.deepEqual(await rpc('mudu_roster_list'), []);
  assert.equal((await db.query('select * from public.mudu_rosters')).rows.length, 0);
  await assert.rejects(rpc('mudu_roster_read', [paper.id]), /Not found/);
  await assert.rejects(
    rpc('mudu_roster_write', [1, canonicalRoster({ ...paper, name: 'Take over' })]),
    /Not found/,
  );
  await become(null);
  const publicView = await rpc('mudu_roster_invitation', [paper.token, false]);
  assert.deepEqual(publicView, {
    name: paper.name,
    accepting: true,
    restricted: false,
    status: null,
    claimed: false,
  });
  assert.doesNotMatch(JSON.stringify(publicView), /@|members|ownerId|identifier/);
  await assert.rejects(rpc('mudu_roster_list'), /permission denied/);
  await assert.rejects(rpc('mudu_roster_group', [paper.id, candidate]), /permission denied/);
  await assert.rejects(db.exec('select * from public.mudu_roster_members'), /permission denied/);
  await become(unconfirmed);
  await assert.rejects(rpc('mudu_roster_join', [paper.token, '001', false]), /Sign in/);
  await become(candidate);
  const joined = await rpc<CloudCandidateGroup>('mudu_roster_join', [paper.token, '001', false]);
  assert.equal(joined.member.id, candidate);
  assert.equal(joined.member.email, 'candidate@example.test');
  assert.equal(joined.member.name, 'Confirmed name');
  assert.equal(joined.member.status, 'pending');
  assert.equal(
    (await rpc<CloudCandidateGroup>('mudu_roster_join', [paper.token, 'tampered-number', false]))
      .revision,
    joined.revision,
  );
  assert.equal((await rpc<CloudCandidateGroup[]>('mudu_candidate_rosters')).length, 1);
  assert.equal((await db.query('select * from public.mudu_rosters')).rows.length, 0);
  assert.equal((await db.query('select * from public.mudu_roster_members')).rows.length, 0);
  await become(second);
  assert.deepEqual(await rpc('mudu_candidate_rosters'), []);
  await become(owner);
  await assert.rejects(
    rpc('mudu_roster_write', [1, canonicalRoster({ ...paper, name: 'Stale edit' })]),
    /Revision conflict/,
  );
  let record = await rpc<CloudRosterRecord>('mudu_roster_read', [paper.id]);
  assert.equal(record.revision, 2);
  assert.equal(digest(record.payload), record.digest);
  let document = JSON.parse(record.payload) as CloudRosterDocument;
  document.members[0].status = 'approved';
  document.members[0].reviewedAt = 1234;
  const invitation = {
    id: randomUUID(),
    email: 'second@example.test',
    name: 'Invited',
    identifier: '002',
    token: 'p'.repeat(43),
    createdAt: 1234,
  };
  document.invitations.push(invitation);
  const approved = await rpc<CloudRosterReceipt>('mudu_roster_write', [
    record.revision,
    canonicalRoster(document),
  ]);
  await become(candidate);
  const own = await rpc<CloudCandidateGroup[]>('mudu_candidate_rosters');
  assert.equal(own[0].member.status, 'approved');
  assert.doesNotMatch(JSON.stringify(own), /second@example|invitations|"entries"|"members"/);
  await assert.rejects(
    rpc('mudu_roster_join', [invitation.token, '002', true]),
    /Wrong invitation/,
  );
  await become(second);
  const claimed = await rpc<CloudCandidateGroup>('mudu_roster_join', [
    invitation.token,
    'ignored',
    true,
  ]);
  assert.equal(claimed.member.status, 'approved');
  assert.equal(claimed.member.identifier, '002');
  assert.deepEqual(await rpc('mudu_roster_join', [invitation.token, 'ignored', true]), claimed);
  const claimedView = await rpc<{ claimed: boolean }>('mudu_roster_invitation', [
    invitation.token,
    true,
  ]);
  assert.equal(claimedView.claimed, true);
  await become(owner);
  record = await rpc<CloudRosterRecord>('mudu_roster_read', [paper.id]);
  assert.equal(record.revision, approved.revision + 1);
  document = JSON.parse(record.payload);
  assert.equal(document.invitations.length, 0);
  assert.equal(document.members.length, 2);
  const forged = structuredClone(document);
  forged.members[0].email = 'someone-else@example.test';
  await assert.rejects(
    rpc('mudu_roster_write', [record.revision, canonicalRoster(forged)]),
    /Unconfirmed candidate/,
  );
  assert.equal(
    (await rpc<CloudRosterRecord>('mudu_roster_read', [paper.id])).revision,
    record.revision,
  );
  document.open = false;
  document.archived = true;
  await rpc('mudu_roster_write', [record.revision, canonicalRoster(document)]);
  await become(other);
  await assert.rejects(rpc('mudu_roster_join', [paper.token, '003', false]), /Closed/);
  await become(candidate);
  assert.equal(
    (await rpc<CloudCandidateGroup>('mudu_roster_join', [paper.token, '001', false])).member.status,
    'approved',
  );
  await become(owner);
  record = await rpc<CloudRosterRecord>('mudu_roster_read', [paper.id]);
  document = JSON.parse(record.payload);
  document.members[0].status = 'rejected';
  await rpc('mudu_roster_write', [record.revision, canonicalRoster(document)]);
  const another: CloudRosterDocument = {
    ...paper,
    id: randomUUID(),
    token: 'z'.repeat(43),
    members: [
      {
        id: other,
        name: 'Other',
        email: 'other@example.test',
        identifier: '001',
        status: 'approved',
        requestedAt: 0,
        reviewedAt: 0,
      },
    ],
  };
  await assert.rejects(
    rpc('mudu_roster_write', [0, canonicalRoster(another)]),
    /duplicate key|number conflict/,
  );
  assert.equal((await rpc<CloudRosterReceipt[]>('mudu_roster_list')).length, 1);
});
