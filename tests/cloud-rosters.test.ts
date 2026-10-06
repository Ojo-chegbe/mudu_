import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { openDatabase } from '../apps/host/database.ts';
import { ExamStore } from '../apps/host/store.ts';
import { Rosters } from '../apps/host/rosters.ts';
import { IdentityService } from '../apps/host/identity.ts';
import { CloudAdministrators } from '../apps/host/cloud-administrators.ts';
import { CloudCandidates } from '../apps/host/cloud-candidates.ts';
import { CloudRosters, canonicalRoster } from '../apps/host/cloud-rosters.ts';
import type { CloudRosterStorage } from '../apps/host/cloud-roster-storage.ts';
import type {
  CloudCandidateGroup,
  CloudRosterDocument,
  CloudRosterRecord,
} from '../packages/contracts/cloud-rosters.ts';
import type { CloudAuthProvider, CloudSession } from '../apps/host/supabase-auth.ts';
import { DomainError } from '../packages/exam-core/model.ts';
import { digest } from '../apps/host/security.ts';
import { assessment } from './fixtures.ts';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { createHandler } from '../apps/host/http.ts';

const identity = (email: string): CloudSession => ({
  userId: randomUUID(),
  email,
  name: email.split('@')[0],
  accessToken: '',
  refreshToken: 'private-refresh',
  expiresAt: Date.now() + 3600000,
});
class MemoryRosters implements CloudRosterStorage {
  records = new Map<string, Map<string, CloudRosterRecord>>();
  people = new Map<string, CloudSession>();
  calls = 0;
  unavailable = false;
  loseAck = false;
  onRead: (() => void) | null = null;
  onWrite: (() => void) | null = null;
  corrupt = false;
  private available() {
    this.calls++;
    if (this.unavailable) throw new DomainError('Cloud unavailable', 503);
  }
  private directory(owner: string) {
    if (!this.records.has(owner)) this.records.set(owner, new Map());
    return this.records.get(owner)!;
  }
  async list(token: string) {
    this.available();
    return [...this.directory(token).values()].map(({ id, revision, digest }) => ({
      id,
      revision,
      digest,
    }));
  }
  async read(token: string, id: string) {
    this.available();
    const value = structuredClone(this.directory(token).get(id));
    if (!value) throw new DomainError('Not found', 404);
    this.onRead?.();
    return this.corrupt ? { ...value, payload: value.payload + ' ' } : value;
  }
  async write(token: string, expected: number, payload: string) {
    this.available();
    const doc = JSON.parse(payload) as CloudRosterDocument,
      directory = this.directory(token),
      old = directory.get(doc.id),
      hash = digest(payload);
    if (old?.digest === hash) return { id: doc.id, revision: old.revision, digest: hash };
    if ((old?.revision ?? 0) !== expected) throw new DomainError('Changed', 409, 'ROSTER_CONFLICT');
    const value = { id: doc.id, revision: (old?.revision ?? 0) + 1, digest: hash, payload };
    directory.set(doc.id, value);
    this.onWrite?.();
    if (this.loseAck) {
      this.loseAck = false;
      throw new DomainError('Lost acknowledgement', 503);
    }
    return { id: value.id, revision: value.revision, digest: value.digest };
  }
  private find(link: string, personal: boolean) {
    for (const [owner, directory] of this.records)
      for (const r of directory.values()) {
        const doc = JSON.parse(r.payload) as CloudRosterDocument;
        if (personal ? doc.invitations.some((i) => i.token === link) : doc.token === link)
          return { owner, r, doc };
      }
    throw new DomainError('Not found', 404);
  }
  async invitation(token: string | null, link: string, personal: boolean) {
    this.available();
    const { doc } = this.find(link, personal);
    return {
      name: doc.name,
      accepting: doc.open && !doc.archived,
      restricted: doc.restricted,
      status: doc.members.find((m) => m.id === token)?.status ?? null,
    };
  }
  private group(owner: string, r: CloudRosterRecord, token: string): CloudCandidateGroup {
    const d = JSON.parse(r.payload) as CloudRosterDocument;
    return {
      id: d.id,
      ownerId: owner,
      name: d.name,
      token: d.token,
      open: d.open,
      restricted: d.restricted,
      archived: d.archived,
      revision: r.revision,
      member: d.members.find((m) => m.id === token)!,
    };
  }
  async groups(token: string) {
    this.available();
    const rows: CloudCandidateGroup[] = [];
    for (const [owner, directory] of this.records)
      for (const r of directory.values()) {
        const g = this.group(owner, r, token);
        if (g.member) rows.push(g);
      }
    return rows;
  }
  async join(token: string, link: string, number: string, personal: boolean) {
    this.available();
    const { owner, r, doc } = this.find(link, personal),
      who = this.people.get(token)!;
    if (doc.members.some((m) => m.id === token) && !personal) return this.group(owner, r, token);
    if (!doc.open || doc.archived) throw new DomainError('Closed', 409);
    if (personal) {
      const i = doc.invitations.find((i) => i.token === link)!;
      if (i.email !== who.email) throw new DomainError('Wrong email', 403);
      number = i.identifier;
      doc.invitations = doc.invitations.filter((v) => v.id !== i.id);
      if (!doc.entries.some((e) => e.identifier === number))
        doc.entries.push({ identifier: number, name: who.name });
    }
    doc.members = doc.members.filter((m) => m.id !== token);
    doc.members.push({
      id: token,
      name: who.name,
      email: who.email,
      identifier: number,
      status: personal ? 'approved' : 'pending',
      requestedAt: 1234,
      reviewedAt: personal ? 1234 : null,
    });
    const payload = canonicalRoster(doc),
      next = { ...r, payload, digest: digest(payload), revision: r.revision + 1 };
    this.directory(owner).set(r.id, next);
    return this.group(owner, next, token);
  }
}
function fixture(t: TestContext, storage: MemoryRosters, cloud: CloudSession) {
  cloud = { ...cloud, accessToken: cloud.userId };
  const db = openDatabase(':memory:'),
    store = new ExamStore(db),
    key = randomBytes(32);
  const provider: CloudAuthProvider = {
    signIn: async () => cloud,
    signUp: async () => ({ pending: true }),
    verify: async (v) => v,
  };
  const auth = new CloudAdministrators(store, provider, key),
    s = auth.open(cloud),
    owner = store.session(s.raw)!.principal_id;
  const rosters = new Rosters(store),
    sync = new CloudRosters(store, auth, storage);
  t.after(async () => {
    await sync.stop();
    db.close();
  });
  const create = () =>
    rosters.save(randomUUID(), owner, {
      name: 'Class',
      revision: 0,
      restricted: false,
      open: true,
      archived: false,
      entries: [],
    });
  const candidate = (who: CloudSession) => {
    who = { ...who, accessToken: who.userId };
    storage.people.set(who.userId, who);
    return new CloudCandidates(store, key).open(who);
  };
  return { db, store, key, auth, owner, rosters, sync, create, candidate };
}
function rename(f: ReturnType<typeof fixture>, id: string, name: string) {
  const r = f.rosters.get(id, f.owner);
  f.rosters.save(id, f.owner, {
    name,
    revision: r.revision,
    restricted: Boolean(r.restricted),
    open: Boolean(r.is_open),
    archived: Boolean(r.archived),
    entries: r.entries,
  });
  f.sync.changed(f.owner);
}

test('rosters, links, joining requests, approvals and invitations follow their owner across Hosts', async (t) => {
  const storage = new MemoryRosters(),
    owner = identity('owner@example.test'),
    a = fixture(t, storage, owner),
    b = fixture(t, storage, owner),
    other = fixture(t, storage, identity('other@example.test'));
  const r = a.create();
  await a.sync.ensure(a.owner, true);
  await b.sync.ensure(b.owner, true);
  assert.equal(b.rosters.get(r.id, b.owner).token, r.token);
  await other.sync.ensure(other.owner, true);
  assert.equal(other.rosters.list(other.owner).length, 0);
  const who = identity('candidate@example.test');
  b.candidate(who);
  assert.equal((await b.sync.join(r.token, who.userId, false, () => {})).status, 'pending');
  await a.sync.ensure(a.owner, true);
  a.rosters.review(r.id, a.owner, who.userId, { decision: 'approved' });
  await a.sync.ensure(a.owner, true);
  assert.equal((await b.sync.candidateGroups(who.userId, () => {}))[0].member.status, 'approved');
  await b.sync.ensure(b.owner, true);
  assert.equal(b.rosters.get(r.id, b.owner).approved, 1);
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM accounts').get()!.n, 1);
  assert.doesNotMatch(
    storage.records.get(owner.userId)!.get(r.id)!.payload,
    /password|scrypt|private-refresh|accessToken/,
  );
  const second = identity('invited@example.test');
  b.candidate(second);
  const current = a.rosters.get(r.id, a.owner);
  a.rosters.enrol(r.id, a.owner, {
    revision: current.revision,
    email: second.email,
    name: 'Invited',
    identifier: '002',
  });
  await a.sync.ensure(a.owner, true);
  const invite = a.rosters.get(r.id, a.owner).invitations[0];
  assert.equal((await b.sync.invitation(invite.token, null, true)).name, r.name);
  await b.sync.join(invite.token, second.userId, true, () => {});
  await a.sync.ensure(a.owner, true);
  await b.sync.ensure(b.owner, true);
  assert.equal(a.rosters.get(r.id, a.owner).approved, 2);
  assert.equal(b.rosters.get(r.id, b.owner).invitations.length, 0);
});

test('offline changes and lost acknowledgements retry without duplicate cloud revisions', async (t) => {
  const storage = new MemoryRosters(),
    who = identity('owner@example.test'),
    f = fixture(t, storage, who),
    r = f.create();
  storage.unavailable = true;
  await f.sync.ensure(f.owner, true);
  assert.equal(f.sync.overview(f.owner).rosters[0].state, 'offline');
  storage.unavailable = false;
  storage.loseAck = true;
  await f.sync.ensure(f.owner, true);
  assert.equal(storage.records.get(who.userId)!.get(r.id)!.revision, 1);
  await f.sync.ensure(f.owner, true);
  assert.equal(storage.records.get(who.userId)!.get(r.id)!.revision, 1);
  assert.equal(f.sync.overview(f.owner).rosters[0].state, 'synced');
  rename(f, r.id, 'Offline edit');
  storage.unavailable = true;
  await f.sync.ensure(f.owner, true);
  storage.unavailable = false;
  await f.sync.ensure(f.owner, true);
  assert.equal(storage.records.get(who.userId)!.get(r.id)!.revision, 2);
});
test('concurrent changes retain both copies, require explicit recovery and preserve a private previous copy', async (t) => {
  const storage = new MemoryRosters(),
    who = identity('owner@example.test'),
    a = fixture(t, storage, who),
    b = fixture(t, storage, who),
    r = a.create();
  await a.sync.ensure(a.owner, true);
  await b.sync.ensure(b.owner, true);
  rename(a, r.id, 'A version');
  rename(b, r.id, 'B version');
  await a.sync.ensure(a.owner, true);
  await b.sync.ensure(b.owner, true);
  assert.equal(b.rosters.get(r.id, b.owner).name, 'B version');
  assert.equal(b.sync.overview(b.owner).rosters[0].state, 'conflict');
  assert.throws(() => b.sync.assertWritable(b.owner, r.id), /newer cloud/);
  await assert.rejects(
    b.sync.resolve(b.owner, r.id, () => {
      throw new DomainError('Expired', 401);
    }),
    /Expired/,
  );
  assert.equal(b.rosters.get(r.id, b.owner).name, 'B version');
  await b.sync.resolve(b.owner, r.id, () => {});
  assert.equal(b.rosters.get(r.id, b.owner).name, 'A version');
  assert.equal(JSON.parse(b.sync.recovery(b.owner, r.id)).name, 'B version');
  assert.equal(
    b.sync.overview(b.owner).rosters.find((row) => row.id === r.id)?.recoveryAvailable,
    true,
  );
  assert.throws(() => b.sync.recovery('another-owner', r.id), /not found/);
});
test('edits during downloads cannot be overwritten; newer edits during upload remain pending', async (t) => {
  const storage = new MemoryRosters(),
    who = identity('owner@example.test'),
    a = fixture(t, storage, who),
    b = fixture(t, storage, who),
    r = a.create();
  await a.sync.ensure(a.owner, true);
  await b.sync.ensure(b.owner, true);
  rename(a, r.id, 'Remote edit');
  await a.sync.ensure(a.owner, true);
  storage.onRead = () => {
    storage.onRead = null;
    rename(b, r.id, 'Edit during download');
  };
  await b.sync.ensure(b.owner, true);
  assert.equal(b.rosters.get(r.id, b.owner).name, 'Edit during download');
  assert.equal(b.sync.overview(b.owner).rosters[0].state, 'conflict');
  await b.sync.resolve(b.owner, r.id, () => {});
  rename(b, r.id, 'Uploaded edit');
  storage.onWrite = () => {
    storage.onWrite = null;
    rename(b, r.id, 'Newer edit');
  };
  await b.sync.ensure(b.owner, true);
  assert.equal(b.sync.overview(b.owner).rosters[0].state, 'pending');
  await b.sync.ensure(b.owner, true);
  assert.equal(b.sync.overview(b.owner).rosters[0].state, 'synced');
});
test('local-only members stay enrolled locally until explicitly connected; email collisions never merge identities', async (t) => {
  const storage = new MemoryRosters(),
    cloud = identity('owner@example.test'),
    a = fixture(t, storage, cloud),
    b = fixture(t, storage, cloud),
    r = a.create(),
    who = identity('candidate@example.test');
  const local = new IdentityService(a.store).createAccount({
      email: who.email,
      name: 'Local',
      hash: 'local-verifier',
    }),
    id = a.store.session(local.raw)!.account_id!;
  a.rosters.join(r.token, id);
  a.rosters.review(r.id, a.owner, id, { decision: 'approved' });
  await a.sync.ensure(a.owner, true);
  assert.equal(a.sync.overview(a.owner).rosters[0].state, 'connection');
  assert.equal(storage.records.get(cloud.userId)!.size, 0);
  new CloudCandidates(a.store, a.key).open({ ...who, accessToken: who.userId }, id);
  await a.sync.ensure(a.owner, true);
  const native = new IdentityService(b.store).createAccount({
      email: who.email,
      name: 'Existing',
      hash: 'retained',
    }),
    nativeId = b.store.session(native.raw)!.account_id!;
  await b.sync.ensure(b.owner, true);
  assert.equal(b.rosters.list(b.owner).length, 0);
  assert.equal(b.sync.overview(b.owner).rosters[0].state, 'connection');
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM candidate_provider_identities').get()!.n, 0);
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM accounts').get()!.n, 1);
  new CloudCandidates(b.store, b.key).open({ ...who, accessToken: who.userId }, nativeId);
  await b.sync.ensure(b.owner, true);
  assert.equal(b.rosters.get(r.id, b.owner).members[0].accountId, nativeId);
  assert.equal(b.rosters.get(r.id, b.owner).approved, 1);
  assert.equal(
    b.db.prepare('SELECT password_hash FROM accounts WHERE id=?').get(nativeId)!.password_hash,
    'retained',
  );
});
test('active local exams produce no roster cloud traffic; corrupt responses cannot partially import data', async (t) => {
  const storage = new MemoryRosters(),
    who = identity('owner@example.test'),
    a = fixture(t, storage, who),
    b = fixture(t, storage, who),
    r = a.create();
  await a.sync.ensure(a.owner, true);
  storage.corrupt = true;
  await b.sync.ensure(b.owner, true);
  assert.equal(b.rosters.list(b.owner).length, 0);
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM accounts').get()!.n, 0);
  storage.corrupt = false;
  await b.sync.ensure(b.owner, true);
  assert.equal(b.rosters.get(r.id, b.owner).name, r.name);
  const paper = assessment();
  a.store.createAssessment(paper, [], a.owner);
  a.store.launch(paper.id, a.owner);
  const calls = storage.calls;
  await a.sync.ensure(a.owner, true);
  a.sync.pump();
  assert.equal(storage.calls, calls);
  assert.equal(a.sync.overview(a.owner).rosters[0].state, 'paused');
  await assert.rejects(
    a.sync.resolve(a.owner, r.id, () => {}),
    /local examination/,
  );
  assert.equal(storage.calls, calls);
});

test('HTTP cloud rosters support cross-Host joining and approvals while enforcing owner scope, CSRF and candidate privacy', async (t) => {
  const storage = new MemoryRosters(),
    owner = identity('owner@example.test'),
    candidate = identity('candidate@example.test'),
    other = identity('other@example.test');
  const people = [owner, candidate, other].map((p) => ({ ...p, accessToken: p.userId }));
  for (const p of people) storage.people.set(p.userId, p);
  async function host() {
    const db = openDatabase(':memory:'),
      server = createServer();
    let sync: CloudRosters | undefined;
    const provider: CloudAuthProvider = {
      signIn: async (email) => {
        const person = people.find((p) => p.email === email);
        if (!person) throw new DomainError('Check credentials', 401);
        return person;
      },
      signUp: async () => ({ pending: true }),
      verify: async (v) => v,
    };
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    server.on(
      'request',
      await createHandler(db, {
        origin: base,
        cloudAuth: { provider, sessionKey: randomBytes(32) },
        cloudRosters: storage,
        onCloudRosters: (r) => {
          sync = r;
        },
      }),
    );
    t.after(async () => {
      await sync?.stop();
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
        data?: unknown,
        headers: Record<string, string> = {},
      ) => {
        const r = await fetch(base + '/api' + path, {
          method,
          headers: {
            Origin: base,
            Cookie: cookie,
            'X-CSRF-Token': csrf,
            'Content-Type': 'application/json',
            ...headers,
          },
          body: data === undefined ? undefined : JSON.stringify(data),
        });
        const value = await r.json(),
          next = r.headers.get('set-cookie');
        if (next) cookie = next.split(';')[0];
        if (value.csrf) csrf = value.csrf;
        return { status: r.status, value };
      };
    }
    return { client };
  }
  const a = await host(),
    b = await host(),
    admin = a.client(),
    student = b.client(),
    foreign = a.client(),
    secondAdmin = b.client(),
    anonymous = b.client();
  assert.equal(
    (
      await admin('/admin/cloud/login', 'POST', {
        email: owner.email,
        password: 'testing-password',
      })
    ).status,
    200,
  );
  const id = randomUUID();
  const saved = await admin('/rosters/' + id, 'POST', {
    name: 'Cloud class',
    revision: 0,
    restricted: false,
    open: true,
    archived: false,
    entries: [],
  });
  assert.equal(saved.status, 200);
  await admin('/rosters/cloud/retry', 'POST', {});
  const token = saved.value.token;
  assert.equal((await anonymous('/roster-join/' + token)).value.name, 'Cloud class');
  assert.equal((await anonymous('/rosters/cloud/status')).status, 401);
  await student('/candidate/cloud/login', 'POST', {
    email: candidate.email,
    password: 'testing-password',
  });
  assert.equal(
    (await student('/roster-join/' + token, 'POST', {}, { 'X-CSRF-Token': 'invalid' })).status,
    403,
  );
  assert.equal((await student('/roster-join/' + token, 'POST', {})).value.status, 'pending');
  assert.equal((await student('/rosters')).status, 403);
  const privateGroups = await student('/candidate/rosters');
  assert.equal(privateGroups.value.rosters.length, 1);
  assert.doesNotMatch(
    JSON.stringify(privateGroups.value),
    /email|identifier|members|invitations|refreshToken/,
  );
  await admin('/rosters/cloud/retry', 'POST', {});
  const roster = (await admin('/rosters/' + id)).value;
  assert.equal(roster.pending, 1);
  assert.equal(
    (
      await admin(`/rosters/${id}/members/${roster.members[0].accountId}`, 'POST', {
        decision: 'approved',
        revision: roster.revision,
      })
    ).status,
    200,
  );
  await admin('/rosters/cloud/retry', 'POST', {});
  assert.equal((await student('/candidate/rosters')).value.rosters[0].status, 'approved');
  const notices = await student('/notifications');
  assert.equal(notices.status, 200);
  assert.ok(notices.value.items.some((n: { title: string }) => n.title === 'Added to a group'));
  await secondAdmin('/admin/cloud/login', 'POST', {
    email: owner.email,
    password: 'testing-password',
  });
  assert.equal((await secondAdmin('/rosters?refresh=1')).value.rosters[0].approved, 1);
  await foreign('/admin/cloud/login', 'POST', { email: other.email, password: 'testing-password' });
  assert.equal((await foreign('/rosters/' + id)).status, 404);
  assert.equal((await foreign(`/rosters/${id}/cloud/resolve`, 'POST', {})).status, 404);
});

test('restricted roster requests can supply an initial student number but cannot take over an assigned number', (t) => {
  const storage = new MemoryRosters(),
    f = fixture(t, storage, identity('owner@example.test'));
  const roster = f.rosters.save(randomUUID(), f.owner, {
    name: 'Restricted',
    revision: 0,
    open: true,
    archived: false,
    restricted: true,
    entries: [
      { identifier: '001', name: 'Student' },
      { identifier: '002', name: 'Other' },
    ],
  });
  const service = new IdentityService(f.store),
    first = service.createAccount({ email: 'first@example.test', name: 'First', hash: 'test' }),
    id = f.store.session(first.raw)!.account_id!;
  assert.throws(() => f.rosters.join(roster.token, id), /not on this roster/);
  assert.equal(f.rosters.join(roster.token, id, '001').status, 'pending');
  f.rosters.review(roster.id, f.owner, id, { decision: 'approved' });
  const second = service.createAccount({
      email: 'second@example.test',
      name: 'Second',
      hash: 'test',
    }),
    secondId = f.store.session(second.raw)!.account_id!;
  f.rosters.join(roster.token, secondId, '001');
  assert.throws(
    () => f.rosters.review(roster.id, f.owner, secondId, { decision: 'approved' }),
    /another verified/,
  );
  const other = f.rosters.save(randomUUID(), f.owner, {
    name: 'Another',
    revision: 0,
    open: true,
    archived: false,
    restricted: true,
    entries: [{ identifier: '002', name: 'Other' }],
  });
  assert.throws(() => f.rosters.join(other.token, id, '002'), /already assigned/);
});
