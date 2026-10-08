import { randomUUID } from 'node:crypto';
import type {
  CloudCandidateGroup,
  CloudRosterDocument,
  CloudRosterReceipt,
  CloudRosterRecord,
  RosterCloudOverview,
  RosterCloudStatus,
} from '../../packages/contracts/cloud-rosters.ts';
import type { CloudRosterStorage } from './cloud-roster-storage.ts';
import type { CloudAdministrators } from './cloud-administrators.ts';
import type { ExamStore } from './store.ts';
import { Rosters } from './rosters.ts';
import { IdentityService, emailAddress } from './identity.ts';
import { identifier, object, text } from '../../packages/exam-core/engine.ts';
import { DomainError } from '../../packages/exam-core/model.ts';
import { digest } from './security.ts';
import { transaction } from './database.ts';
import { syncLinkedRosters } from './roster-admission.ts';

export function canonicalRoster(value: CloudRosterDocument): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, sort(x)]),
          )
        : v;
  return JSON.stringify(
    sort({
      ...value,
      entries: [...value.entries].sort((a, b) => a.identifier.localeCompare(b.identifier)),
      members: [...value.members].sort((a, b) => a.id.localeCompare(b.id)),
      invitations: [...value.invitations].sort((a, b) => a.id.localeCompare(b.id)),
    }),
  );
}
const uuid = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const isLink = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(v);
const time = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function validatedGroup(group: CloudCandidateGroup, userId: string): CloudCandidateGroup {
  if (
    !uuid(group.ownerId) ||
    !Number.isSafeInteger(group.revision) ||
    group.revision < 1 ||
    typeof group.restricted !== 'boolean' ||
    group.member?.id !== userId
  )
    throw new DomainError('Invalid candidate membership.', 502);
  const doc = parseCloudRoster(
    JSON.stringify({
      version: 1,
      id: group.id,
      name: group.name,
      description: '',
      token: group.token,
      open: group.open,
      archived: group.archived,
      restricted: false,
      entries: [],
      members: [group.member],
      invitations: [],
    }),
  );
  return { ...group, name: doc.name, member: doc.members[0] };
}
export function parseCloudRoster(payload: string): CloudRosterDocument {
  if (typeof payload !== 'string' || Buffer.byteLength(payload) > 2097152)
    throw new DomainError('Invalid cloud roster.', 502);
  const r = object(JSON.parse(payload));
  if (
    r.version !== 1 ||
    !uuid(r.id) ||
    !isLink(r.token) ||
    typeof r.open !== 'boolean' ||
    typeof r.restricted !== 'boolean' ||
    typeof r.archived !== 'boolean' ||
    !Array.isArray(r.entries) ||
    r.entries.length > 500 ||
    !Array.isArray(r.members) ||
    r.members.length > 2000 ||
    !Array.isArray(r.invitations) ||
    r.invitations.length > 500
  )
    throw new DomainError('Invalid cloud roster.', 502);
  const entries = r.entries.map((v) => {
    const e = object(v);
    return { identifier: identifier(e.identifier), name: text(e.name, 'Name', 160) };
  });
  const members = r.members.map((v) => {
    const m = object(v);
    if (
      !uuid(m.id) ||
      !['pending', 'approved', 'rejected'].includes(String(m.status)) ||
      !time(m.requestedAt) ||
      (m.reviewedAt !== null && !time(m.reviewedAt))
    )
      throw new DomainError('Invalid cloud membership.', 502);
    return {
      id: m.id as string,
      name: text(m.name, 'Name', 160),
      email: emailAddress(m.email),
      identifier: identifier(m.identifier),
      status: m.status as 'pending' | 'approved' | 'rejected',
      requestedAt: m.requestedAt as number,
      reviewedAt: m.reviewedAt as number | null,
    };
  });
  const invitations = r.invitations.map((v) => {
    const i = object(v);
    if (!uuid(i.id) || !isLink(i.token) || !time(i.createdAt))
      throw new DomainError('Invalid cloud invitation.', 502);
    return {
      id: i.id as string,
      name: text(i.name, 'Name', 160),
      email: emailAddress(i.email),
      identifier: identifier(i.identifier),
      token: i.token as string,
      createdAt: i.createdAt as number,
    };
  });
  if (
    new Set(entries.map((e) => e.identifier)).size !== entries.length ||
    new Set(members.map((m) => m.id)).size !== members.length ||
    new Set(invitations.map((i) => i.id)).size !== invitations.length ||
    new Set(invitations.map((i) => i.email)).size !== invitations.length ||
    new Set(invitations.map((i) => i.token)).size !== invitations.length ||
    members.filter((m) => m.status === 'approved').length + invitations.length > 500 ||
    (r.restricted && !entries.length)
  )
    throw new DomainError('Conflicting cloud roster data.', 502);
  return {
    version: 1,
    id: r.id as string,
    name: text(r.name, 'Roster name', 160),
    description: text(r.description ?? '', 'Roster description', 500, 0),
    token: r.token as string,
    open: r.open,
    restricted: r.restricted,
    archived: r.archived,
    entries,
    members,
    invitations,
  };
}
interface Checkpoint {
  id: string;
  providerId: string;
  revision: number;
  cloudDigest: string;
  localDigest: string;
}

export class CloudRosters {
  store: ExamStore;
  auth: CloudAdministrators;
  storage: CloudRosterStorage;
  private flights = new Map<string, Promise<void>>();
  private due = new Map<string, number>();
  private errors = new Map<string, RosterCloudStatus>();
  private globalErrors = new Map<string, RosterCloudStatus>();
  private stopped = false;
  private resolutions = new Set<string>();
  private pendingResolutions = new Set<Promise<void>>();
  constructor(store: ExamStore, auth: CloudAdministrators, storage: CloudRosterStorage) {
    this.store = store;
    this.auth = auth;
    this.storage = storage;
  }
  private binding(owner: string) {
    return this.store.db
      .prepare('SELECT provider_user_id FROM admin_provider_identities WHERE administrator_id=?')
      .get(owner)?.provider_user_id as string | undefined;
  }
  activeExam() {
    return Boolean(
      this.store.db
        .prepare(
          "SELECT 1 FROM sittings s LEFT JOIN exam_controls c ON c.sitting_id=s.id WHERE s.deadline>? OR c.paused_at IS NOT NULL UNION ALL SELECT 1 FROM attempts WHERE status='active' AND deadline>? LIMIT 1",
        )
        .get(this.store.now(), this.store.now()),
    );
  }
  private checkpoint(owner: string, id: string): Checkpoint | null {
    const row = this.store.db
      .prepare(
        "SELECT detail FROM events WHERE actor_id=? AND kind='roster_cloud_checkpoint' AND json_extract(detail,'$.id')=? ORDER BY id DESC LIMIT 1",
      )
      .get(owner, id);
    return row ? JSON.parse(String(row.detail)) : null;
  }
  snapshot(owner: string, id: string): CloudRosterDocument {
    const r = new Rosters(this.store).get(id, owner);
    const members = this.store.db
      .prepare(
        `SELECT b.provider_user_id AS id,a.name,a.email,m.identifier,r.status,r.requested_at AS requestedAt,r.reviewed_at AS reviewedAt FROM roster_members r JOIN accounts a ON a.id=r.account_id JOIN memberships m ON m.account_id=a.id AND m.organization_id='default' LEFT JOIN candidate_provider_identities b ON b.account_id=a.id WHERE r.roster_id=? ORDER BY b.provider_user_id`,
      )
      .all(id);
    const missing = members.filter((m) => !m.id).length;
    if (missing)
      throw new DomainError(
        `${missing} ${missing === 1 ? 'member needs' : 'members need'} to connect their candidate account before this roster can be shared across computers. Existing local enrolment is unchanged.`,
        409,
        'CANDIDATE_LINK_REQUIRED',
      );
    const invitations = this.store.db
      .prepare(
        'SELECT id,email,name,identifier,token,created_at AS createdAt FROM roster_enrolment_invites WHERE roster_id=? AND claimed_account_id IS NULL ORDER BY id',
      )
      .all(id);
    return parseCloudRoster(
      JSON.stringify({
        version: 1,
        id,
        name: r.name,
        description: r.description,
        token: r.token,
        restricted: Boolean(r.restricted),
        open: Boolean(r.is_open),
        archived: Boolean(r.archived),
        entries: r.entries,
        members,
        invitations,
      }),
    );
  }
  private receipt(r: CloudRosterReceipt, id: string) {
    if (
      r.id !== id ||
      !Number.isSafeInteger(r.revision) ||
      r.revision < 1 ||
      !/^[a-f0-9]{64}$/.test(r.digest) ||
      (r.updatedAt !== undefined && (!Number.isSafeInteger(r.updatedAt) || r.updatedAt < 0))
    )
      throw new DomainError('Invalid cloud roster receipt.', 502);
  }
  private readRecord(r: CloudRosterRecord, id: string) {
    this.receipt(r, id);
    if (digest(r.payload) !== r.digest)
      throw new DomainError('Cloud roster checksum did not match.', 502);
    const doc = parseCloudRoster(r.payload);
    if (doc.id !== id) throw new DomainError('Cloud roster identity did not match.', 502);
    return doc;
  }
  private account(m: CloudRosterDocument['members'][number]) {
    const db = this.store.db;
    const bound = db
      .prepare('SELECT account_id FROM candidate_provider_identities WHERE provider_user_id=?')
      .get(m.id);
    if (bound) {
      const a = db.prepare('SELECT email FROM accounts WHERE id=?').get(bound.account_id!);
      if (!a) throw new DomainError('Candidate account mapping is missing.', 409);
      if (
        db.prepare('SELECT 1 FROM accounts WHERE email=? AND id<>?').get(m.email, bound.account_id!)
      )
        throw new DomainError(
          'An existing candidate must connect their account before importing this membership.',
          409,
          'CANDIDATE_LINK_REQUIRED',
        );
      db.prepare('UPDATE accounts SET email=? WHERE id=?').run(m.email, bound.account_id!);
      return String(bound.account_id);
    }
    if (db.prepare('SELECT 1 FROM accounts WHERE email=? OR id=?').get(m.email, m.id))
      throw new DomainError(
        'An existing candidate must connect their account before importing this membership. No accounts were merged.',
        409,
        'CANDIDATE_LINK_REQUIRED',
      );
    db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?)').run(
      m.id,
      m.email,
      m.name,
      'supabase-managed',
      this.store.now(),
    );
    db.prepare('INSERT INTO memberships VALUES(?,?,?,?,?,NULL)').run(
      randomUUID(),
      m.id,
      'default',
      m.identifier,
      'pending',
    );
    db.prepare('INSERT INTO candidate_provider_identities VALUES(?,?)').run(m.id, m.id);
    return m.id;
  }
  private import(
    owner: string,
    providerId: string,
    doc: CloudRosterDocument,
    updatedAt = this.store.now(),
  ) {
    transaction(this.store.db, () => {
      const db = this.store.db,
        existing = db.prepare('SELECT * FROM rosters WHERE id=?').get(doc.id);
      if (existing && existing.owner_id !== owner)
        throw new DomainError('Roster identity belongs to another workspace.', 409);
      const accounts = doc.members.map((m) => ({ m, id: this.account(m) }));
      if (existing)
        db.prepare(
          'UPDATE rosters SET name=?,description=?,token=?,restricted=?,is_open=?,archived=?,revision=revision+1,updated_at=? WHERE id=?',
        ).run(
          doc.name,
          doc.description,
          doc.token,
          Number(doc.restricted),
          Number(doc.open),
          Number(doc.archived),
          updatedAt,
          doc.id,
        );
      else
        db.prepare(
          'INSERT INTO rosters(id,owner_id,name,token,restricted,is_open,archived,revision,updated_at,description) VALUES(?,?,?,?,?,?,?,1,?,?)',
        ).run(
          doc.id,
          owner,
          doc.name,
          doc.token,
          Number(doc.restricted),
          Number(doc.open),
          Number(doc.archived),
          updatedAt,
          doc.description,
        );
      db.prepare('DELETE FROM roster_members WHERE roster_id=?').run(doc.id);
      db.prepare('DELETE FROM roster_entries WHERE roster_id=?').run(doc.id);
      db.prepare(
        'DELETE FROM roster_enrolment_invites WHERE roster_id=? AND claimed_account_id IS NULL',
      ).run(doc.id);
      for (const e of doc.entries)
        db.prepare('INSERT INTO roster_entries VALUES(?,?,?)').run(doc.id, e.identifier, e.name);
      for (const { m, id } of accounts) {
        const profile = new IdentityService(this.store).profile(id);
        if (profile.identityStatus === 'verified' && profile.identifier !== m.identifier)
          throw new DomainError(
            'A candidate has a different assigned number on this Host. Resolve the number before syncing this roster.',
            409,
          );
        db.prepare(
          "UPDATE memberships SET identifier=?,status=?,verified_at=CASE WHEN ?=1 THEN ? ELSE verified_at END WHERE account_id=? AND organization_id='default'",
        ).run(
          m.identifier,
          m.status === 'approved' ? 'verified' : profile.identityStatus,
          Number(m.status === 'approved'),
          this.store.now(),
          id,
        );
        db.prepare('INSERT INTO roster_members VALUES(?,?,?,?,?)').run(
          doc.id,
          id,
          m.status,
          m.requestedAt,
          m.reviewedAt,
        );
      }
      for (const i of doc.invitations) {
        const other = db
          .prepare(
            'SELECT roster_id,claimed_account_id FROM roster_enrolment_invites WHERE id=? OR token=?',
          )
          .get(i.id, i.token);
        if (other && (other.roster_id !== doc.id || other.claimed_account_id))
          throw new DomainError('An invitation conflicts with existing Host records.', 409);
        db.prepare('INSERT INTO roster_enrolment_invites VALUES(?,?,?,?,?,?,?,NULL)').run(
          i.id,
          doc.id,
          i.email,
          i.name,
          i.identifier,
          i.token,
          i.createdAt,
        );
      }
      this.store.event(null, owner, 'roster_cloud_imported', { rosterId: doc.id, providerId });
      syncLinkedRosters(this.store, owner, doc.id);
    });
  }
  private acknowledge(
    owner: string,
    providerId: string,
    r: CloudRosterReceipt,
    localDigest: string,
  ) {
    const old = this.checkpoint(owner, r.id);
    if (
      old?.revision === r.revision &&
      old.cloudDigest === r.digest &&
      old.localDigest === localDigest
    )
      return;
    this.store.event(null, owner, 'roster_cloud_checkpoint', {
      id: r.id,
      providerId,
      revision: r.revision,
      cloudDigest: r.digest,
      localDigest,
    });
  }
  overview(owner: string): RosterCloudOverview {
    const enabled = Boolean(this.binding(owner));
    const global = this.globalErrors.get(owner);
    const local = new Rosters(this.store).list(owner);
    const recoveries = new Set(
      this.store.db
        .prepare(
          "SELECT DISTINCT json_extract(detail,'$.rosterId') rosterId FROM events WHERE actor_id=? AND kind='roster_cloud_recovery_copy'",
        )
        .all(owner)
        .map((row) => String(row.rosterId)),
    );
    const extra = [...this.errors.entries()]
      .filter(
        ([key, value]) =>
          key.startsWith(owner + ':') && value.id !== '*' && !local.some((r) => r.id === value.id),
      )
      .map(([, value]) => value);
    return {
      enabled,
      state: global?.state,
      message: global?.message,
      rosters: [
        ...local.map<RosterCloudStatus>((r) => {
          if (!enabled) return { id: r.id, state: 'local', revision: r.revision };
          if (this.activeExam()) return { id: r.id, state: 'paused', revision: r.revision };
          const error = this.errors.get(`${owner}:${r.id}`);
          if (error) return { ...error, revision: r.revision };
          try {
            const hash = digest(canonicalRoster(this.snapshot(owner, r.id))),
              base = this.checkpoint(owner, r.id);
            return {
              id: r.id,
              state: base?.localDigest === hash ? 'synced' : 'pending',
              revision: r.revision,
            };
          } catch (e) {
            return {
              id: r.id,
              state: 'connection',
              message:
                e instanceof Error ? e.message : 'Connect existing candidate accounts first.',
            };
          }
        }),
        ...extra,
      ].map((row) => ({ ...row, recoveryAvailable: recoveries.has(row.id) })),
    };
  }
  changed(owner: string) {
    this.due.set(owner, 0);
    for (const [key, v] of this.errors)
      if (key.startsWith(owner + ':') && v.state !== 'conflict') this.errors.delete(key);
  }
  assertWritable(owner: string, id: string) {
    if (this.resolutions.has(owner) || this.errors.get(`${owner}:${id}`)?.state === 'conflict')
      throw new DomainError(
        'This roster has newer cloud changes. Review the latest copy before making another change.',
        409,
        'ROSTER_CONFLICT',
      );
  }
  async ensure(owner: string, force = false, focus?: string) {
    if (this.stopped || this.resolutions.has(owner) || !this.binding(owner) || this.activeExam())
      return;
    if (this.flights.has(owner)) return this.flights.get(owner);
    if (!force && (this.due.get(owner) ?? 0) > this.store.now()) return;
    const promise = this.sync(owner, focus).finally(() => {
      this.due.set(owner, this.store.now() + 15000);
      this.flights.delete(owner);
    });
    this.flights.set(owner, promise);
    return promise;
  }
  private error(owner: string, id: string, e: unknown) {
    const d = e instanceof DomainError ? e : null;
    this.errors.set(`${owner}:${id}`, {
      id,
      state:
        d?.code === 'ROSTER_CONFLICT'
          ? 'conflict'
          : d?.code === 'CANDIDATE_LINK_REQUIRED'
            ? 'connection'
            : d?.code === 'CLOUD_SETUP_REQUIRED'
              ? 'setup'
              : d?.status === 401
                ? 'signin'
                : d?.status === 409
                  ? 'blocked'
                  : 'offline',
      message: e instanceof Error ? e.message : 'Cloud rosters are temporarily unavailable.',
    });
  }
  private async sync(owner: string, focus?: string) {
    const providerId = this.binding(owner)!;
    try {
      const session = await this.auth.credentials(owner, providerId);
      if (this.activeExam() || this.stopped) return;
      const remote = await this.storage.list(session.accessToken);
      if (
        !Array.isArray(remote) ||
        remote.length > 100 ||
        new Set(remote.map((r) => r.id)).size !== remote.length
      )
        throw new DomainError('Invalid cloud roster directory.', 502);
      this.globalErrors.delete(owner);
      const local = new Rosters(this.store).list(owner),
        ids = new Set([
          ...(focus ? [focus] : []),
          ...local.map((r) => r.id),
          ...remote.map((r) => r.id),
        ]);
      const workStart = Date.now();
      let requests = 0;
      for (const id of ids) {
        if (!uuid(id)) throw new DomainError('Invalid cloud roster identity.', 502);
        if (this.activeExam() || this.stopped || (requests > 0 && Date.now() - workStart > 8000))
          return;
        try {
          const entry = remote.find((r) => r.id === id),
            hasLocal = local.some((r) => r.id === id),
            base = this.checkpoint(owner, id);
          if (entry) this.receipt(entry, id);
          if (base && base.providerId !== providerId)
            throw new DomainError('Roster cloud identity changed.', 409, 'ROSTER_CONFLICT');
          const payload = hasLocal ? canonicalRoster(this.snapshot(owner, id)) : null,
            hash = payload ? digest(payload) : null;
          const dirty = hasLocal && (!base || base.localDigest !== hash);
          if (
            entry &&
            (!base || entry.revision !== base.revision || entry.digest !== base.cloudDigest)
          ) {
            requests++;
            const record = await this.storage.read(session.accessToken, id),
              doc = this.readRecord(record, id);
            if (this.activeExam() || this.stopped) return;
            // Compare canonical documents, not PostgreSQL's whitespace formatting.
            if (payload === canonicalRoster(doc)) {
              this.acknowledge(owner, providerId, record, hash!);
              this.errors.delete(`${owner}:${id}`);
              continue;
            }
            if (dirty)
              throw new DomainError(
                'Both this Host and the cloud have changed. Neither copy was overwritten.',
                409,
                'ROSTER_CONFLICT',
              );
            if (hasLocal && canonicalRoster(this.snapshot(owner, id)) !== payload)
              throw new DomainError(
                'This roster was edited while cloud changes were loading. Both copies are safe.',
                409,
                'ROSTER_CONFLICT',
              );
            this.import(owner, providerId, doc, record.updatedAt);
            this.acknowledge(
              owner,
              providerId,
              record,
              digest(canonicalRoster(this.snapshot(owner, id))),
            );
          } else if (dirty && payload) {
            requests++;
            const receipt = await this.storage.write(
              session.accessToken,
              base?.revision ?? 0,
              payload,
            );
            this.receipt(receipt, id);
            if (receipt.digest !== hash)
              throw new DomainError('Cloud roster acknowledgement did not match.', 502);
            this.acknowledge(owner, providerId, receipt, hash!);
          } else if (base && !entry)
            throw new DomainError(
              'This roster is missing from the cloud. No local data was removed.',
              409,
              'ROSTER_CONFLICT',
            );
          this.errors.delete(`${owner}:${id}`);
        } catch (e) {
          this.error(owner, id, e);
        }
      }
    } catch (e) {
      this.error(owner, '*', e);
      this.globalErrors.set(owner, this.errors.get(`${owner}:*`)!);
      for (const r of new Rosters(this.store).list(owner)) this.error(owner, r.id, e);
    }
  }
  async resolve(owner: string, id: string, revalidate: () => void) {
    const promise = this.resolveOwner(owner, id, revalidate);
    this.pendingResolutions.add(promise);
    try {
      await promise;
    } finally {
      this.pendingResolutions.delete(promise);
    }
  }
  private async resolveOwner(owner: string, id: string, revalidate: () => void) {
    await this.ensure(owner, true);
    if (this.activeExam())
      throw new DomainError('Cloud changes wait until the local examination finishes.', 409);
    if (this.resolutions.has(owner))
      throw new DomainError('Please wait for the current roster update.', 409);
    this.resolutions.add(owner);
    try {
      new Rosters(this.store).get(id, owner);
      const providerId = this.binding(owner);
      if (!providerId) throw new DomainError('Connect your workspace first.', 409);
      const session = await this.auth.credentials(owner, providerId),
        record = await this.storage.read(session.accessToken, id),
        doc = this.readRecord(record, id);
      revalidate();
      if (this.activeExam())
        throw new DomainError('Cloud updates wait until the examination finishes.', 409);
      const recovery = canonicalRoster(this.snapshot(owner, id));
      this.store.event(null, owner, 'roster_cloud_recovery_copy', {
        rosterId: id,
        payload: recovery,
      });
      this.import(owner, providerId, doc, record.updatedAt);
      this.acknowledge(
        owner,
        providerId,
        record,
        digest(canonicalRoster(this.snapshot(owner, id))),
      );
      this.errors.delete(`${owner}:${id}`);
    } finally {
      this.resolutions.delete(owner);
    }
  }
  recovery(owner: string, id: string) {
    new Rosters(this.store).get(id, owner);
    const row = this.store.db
      .prepare(
        "SELECT detail FROM events WHERE actor_id=? AND kind='roster_cloud_recovery_copy' AND json_extract(detail,'$.rosterId')=? ORDER BY id DESC LIMIT 1",
      )
      .get(owner, id);
    if (!row) throw new DomainError('No recovery copy is available for this roster.', 404);
    return JSON.parse(String(row.detail)).payload as string;
  }
  async candidateGroups(account: string, revalidate: () => void): Promise<CloudCandidateGroup[]> {
    if (this.activeExam()) return this.cachedGroups(account);
    const session = await this.auth.candidateCredentials(account),
      groups = await this.storage.groups(session.accessToken);
    revalidate();
    if (
      !Array.isArray(groups) ||
      groups.length > 2000 ||
      Buffer.byteLength(JSON.stringify(groups)) > 2097152
    )
      throw new DomainError('Invalid group directory.', 502);
    for (let i = 0; i < groups.length; i++) groups[i] = validatedGroup(groups[i], session.userId);
    if (JSON.stringify(groups) !== JSON.stringify(this.cachedGroups(account)))
      this.store.event(null, account, 'candidate_cloud_rosters_cache', { groups });
    return groups;
  }
  private cachedGroups(account: string): CloudCandidateGroup[] {
    const row = this.store.db
      .prepare(
        "SELECT detail FROM events WHERE actor_id=? AND kind='candidate_cloud_rosters_cache' ORDER BY id DESC LIMIT 1",
      )
      .get(account);
    return row ? JSON.parse(String(row.detail)).groups : [];
  }
  async invitation(link: string, account: string | null, personal: boolean) {
    if (this.activeExam())
      throw new DomainError('Use the prepared local roster while the examination is running.', 409);
    const session = account ? await this.auth.candidateCredentials(account) : null;
    return this.storage.invitation(session?.accessToken ?? null, link, personal);
  }
  async join(
    link: string,
    account: string,
    personal: boolean,
    revalidate: () => void,
    claimedNumber?: unknown,
  ) {
    if (this.activeExam())
      throw new DomainError('Use the prepared local roster while the examination is running.', 409);
    const session = await this.auth.candidateCredentials(account);
    revalidate();
    const profile = new IdentityService(this.store).profile(account);
    const number = claimedNumber === undefined ? profile.identifier : identifier(claimedNumber);
    if (
      !personal &&
      number !== profile.identifier &&
      profile.identityStatus === 'verified' &&
      profile.identifier.startsWith('ACCOUNT-')
    )
      throw new DomainError(
        'Ask your organiser to assign your student number before joining this restricted group.',
        409,
      );
    if (!personal && number !== profile.identifier && !profile.identifier.startsWith('ACCOUNT-'))
      throw new DomainError('Use the candidate number already assigned to your account.', 409);
    const response = await this.storage.join(session.accessToken, link, number, personal);
    revalidate();
    const group = validatedGroup(response, session.userId);
    if (personal && group.member.status !== 'approved')
      throw new DomainError(
        'This invitation was already accepted. Contact the organiser about your current membership.',
        409,
      );
    for (const r of this.store.db
      .prepare('SELECT administrator_id FROM admin_provider_identities WHERE provider_user_id=?')
      .all(group.ownerId))
      this.changed(String(r.administrator_id));
    return {
      name: group.name,
      accepting: group.open && !group.archived,
      restricted: group.restricted,
      status: group.member.status,
      enrolled: personal,
    };
  }
  pump() {
    if (this.stopped || this.activeExam()) return;
    for (const row of this.store.db
      .prepare('SELECT administrator_id FROM admin_provider_identities')
      .all())
      void this.ensure(String(row.administrator_id));
  }
  async stop() {
    this.stopped = true;
    await Promise.allSettled([...this.flights.values(), ...this.pendingResolutions]);
  }
}
