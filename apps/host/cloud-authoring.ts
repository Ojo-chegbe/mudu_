import { randomUUID } from 'node:crypto';
import type {
  AuthoringDocument,
  AuthoringOverview,
  AuthoringReceipt,
  AuthoringRecord,
  AuthoringStatus,
  AssessmentWizardDraft,
  SavedWizard,
} from '../../packages/contracts/cloud-authoring.ts';
import { assessmentInput } from '../../packages/contracts/assessment-authoring.ts';
import { object, parseAssessment } from '../../packages/exam-core/engine.ts';
import { parseTiming } from '../../packages/exam-core/timing.ts';
import { DomainError } from '../../packages/exam-core/model.ts';
import { canonicalBank } from './cloud-question-bank.ts';
import { digest } from './security.ts';
import { transaction } from './database.ts';
import type { ExamStore } from './store.ts';
import type { CloudAdministrators } from './cloud-administrators.ts';
import type { AuthoringStorage } from './cloud-authoring-storage.ts';
import { syncLinkedRosters } from './roster-admission.ts';

export const authoringId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
function fail(message = 'This draft contains invalid data.'): never {
  throw new DomainError(message, 400);
}
const string = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : fail());
const number = (v: unknown, min: number, max: number) =>
  Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max ? Number(v) : fail();
const boolean = (v: unknown) => (typeof v === 'boolean' ? v : fail());
function roster(raw: unknown): { id: string; name: string; revision: number } | null {
  if (raw == null) return null;
  const r = object(raw);
  if (!authoringId(r.id)) fail();
  return {
    id: r.id as string,
    name: string(r.name, 160),
    revision: number(r.revision, 1, Number.MAX_SAFE_INTEGER),
  };
}
export function validateWizard(raw: unknown): AssessmentWizardDraft {
  const d = object(raw),
    a = object(d.details);
  if (!authoringId(d.requestId) || d.createdId !== null || d.accessMode !== 'accounts')
    fail('Only account-based unfinished drafts can be saved across devices.');
  if (
    !Array.isArray(d.questions) ||
    d.questions.length < 1 ||
    d.questions.length > 200 ||
    !Array.isArray(d.candidates) ||
    d.candidates.length > 500
  )
    fail();
  if (!['approval', 'roster'].includes(String(d.registrationPolicy))) fail();
  const questions = d.questions.map((raw) => {
    const q = object(raw);
    if (
      !['single', 'multiple', 'short'].includes(String(q.type)) ||
      !Array.isArray(q.options) ||
      q.options.length > 8 ||
      !Array.isArray(q.correctIndices) ||
      q.correctIndices.length > 8
    )
      fail();
    return {
      type: q.type as AssessmentWizardDraft['questions'][number]['type'],
      prompt: string(q.prompt, 10000),
      marks: number(q.marks, 1, 100),
      options: q.options.map((v) => string(v, 2000)),
      correctIndices: q.correctIndices.map((v) => number(v, 0, 7)),
    };
  });
  const result: AssessmentWizardDraft = {
    requestId: d.requestId as string,
    createdId: null,
    step: number(d.step, 0, 3),
    useRoster: d.useRoster === undefined ? false : boolean(d.useRoster),
    accessChoiceConfirmed:
      d.accessChoiceConfirmed === undefined ? false : boolean(d.accessChoiceConfirmed),
    roster: roster(d.roster),
    details: {
      title: string(a.title, 180),
      course: string(a.course, 100),
      instructions: string(a.instructions, 10000),
      durationMinutes: number(a.durationMinutes, 1, 480),
      passPercent: number(a.passPercent, 0, 100),
      shuffleQuestions: boolean(a.shuffleQuestions),
      shuffleOptions: boolean(a.shuffleOptions),
      timing: parseTiming(a.timing),
      allowLateAdmission:
        a.allowLateAdmission === undefined ? false : boolean(a.allowLateAdmission),
    },
    questions,
    candidates: d.candidates.map((raw) => {
      const c = object(raw);
      return { identifier: string(c.identifier, 80), name: string(c.name, 100), credential: '' };
    }),
    accessMode: 'accounts',
    registrationPolicy: d.registrationPolicy as 'approval' | 'roster',
    registrationCloses: string(d.registrationCloses, 64),
    registrationCapacity: number(d.registrationCapacity, 1, 500),
    keysSaved: false,
  };
  if (Buffer.byteLength(canonicalBank(result)) > 900000) fail('This draft is too large to save.');
  return result;
}
export function validateAuthoring(raw: unknown): AuthoringDocument {
  const d = object(raw);
  if (d.version !== 1 || !authoringId(d.id)) fail();
  if (d.kind === 'draft') {
    const draft = d.draft === null ? null : validateWizard(d.draft);
    if (draft && draft.requestId !== d.id) fail();
    return { version: 1, id: d.id, kind: 'draft', draft };
  }
  if (d.kind !== 'assessment' || !authoringId(d.executionHostId)) fail();
  const input = assessmentInput(
      parseAssessment({ ...object(d.input), accessMode: 'accounts', candidates: [] }, randomUUID)
        .assessment,
    ),
    r = object(d.registration);
  if (
    !['approval', 'roster'].includes(String(r.policy)) ||
    typeof r.token !== 'string' ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(r.token)
  )
    fail();
  return {
    version: 1,
    id: d.id,
    kind: 'assessment',
    input,
    executionHostId: d.executionHostId as string,
    roster: roster(d.roster),
    registration: {
      policy: r.policy as 'approval' | 'roster',
      token: r.token,
      open: boolean(r.open),
      closesAt: r.closesAt === null ? null : number(r.closesAt, 0, Number.MAX_SAFE_INTEGER),
      capacity: number(r.capacity, 1, 500),
    },
  };
}
interface Checkpoint {
  providerId: string;
  revision: number;
  cloudDigest: string;
  localDigest: string;
}
export class CloudAuthoring {
  store: ExamStore;
  auth: CloudAdministrators | null;
  storage: AuthoringStorage | null;
  private flights = new Map<string, Promise<void>>();
  private due = new Map<string, number>();
  private errors = new Map<string, AuthoringStatus>();
  private global = new Map<string, AuthoringStatus>();
  private resolving = new Set<string>();
  private resolutions = new Set<Promise<void>>();
  private stopped = false;
  constructor(
    store: ExamStore,
    auth: CloudAdministrators | null,
    storage: AuthoringStorage | null,
  ) {
    this.store = store;
    this.auth = auth;
    this.storage = storage;
  }
  private binding(owner: string) {
    const row = this.store.db
      .prepare('SELECT provider_user_id FROM admin_provider_identities WHERE administrator_id=?')
      .get(owner);
    return row ? String(row.provider_user_id) : null;
  }
  private hostId() {
    this.store.db.prepare('INSERT OR IGNORE INTO cloud_instance VALUES(1,?)').run(randomUUID());
    return String(
      this.store.db.prepare('SELECT id FROM cloud_instance WHERE singleton=1').get()!.id,
    );
  }
  activeExam() {
    const db = this.store.db;
    return Boolean(
      db.prepare('SELECT 1 FROM sittings WHERE deadline>? LIMIT 1').get(this.store.now()) ||
      db.prepare('SELECT 1 FROM exam_controls WHERE paused_at IS NOT NULL LIMIT 1').get() ||
      db
        .prepare("SELECT 1 FROM attempts WHERE status='active' AND deadline>? LIMIT 1")
        .get(this.store.now()),
    );
  }
  private event(owner: string, id: string, kind: string) {
    const row = this.store.db
      .prepare(
        "SELECT detail FROM events WHERE actor_id=? AND kind=? AND json_extract(detail,'$.id')=? ORDER BY events.id DESC LIMIT 1",
      )
      .get(owner, kind, id);
    return row ? JSON.parse(String(row.detail)) : null;
  }
  private checkpoint(owner: string, id: string): Checkpoint | null {
    const c = this.event(owner, id, 'authoring_cloud_checkpoint');
    return c?.providerId === this.binding(owner) ? c : null;
  }
  private ack(owner: string, r: AuthoringReceipt, localDigest: string) {
    const old = this.checkpoint(owner, r.id);
    if (
      old?.revision === r.revision &&
      old.cloudDigest === r.digest &&
      old.localDigest === localDigest
    )
      return;
    this.store.event(null, owner, 'authoring_cloud_checkpoint', {
      id: r.id,
      providerId: this.binding(owner),
      revision: r.revision,
      cloudDigest: r.digest,
      localDigest,
    });
  }
  private ownedDraft(owner: string, id: string) {
    const row = this.store.db
      .prepare('SELECT * FROM authoring_drafts WHERE id=? AND owner_id=?')
      .get(id, owner);
    if (!row) throw new DomainError('Draft not found.', 404);
    return row;
  }
  getDraft(owner: string, id: string): SavedWizard | { createdId: string } {
    const owned = this.store.db
      .prepare('SELECT 1 FROM assessment_owners WHERE assessment_id=? AND owner_id=?')
      .get(id, owner);
    if (owned) return { createdId: id };
    const row = this.ownedDraft(owner, id);
    if (!row.payload) throw new DomainError('This draft was discarded.', 404);
    return {
      draft: validateWizard(JSON.parse(String(row.payload))),
      revision: Number(row.revision),
    };
  }
  listDrafts(owner: string) {
    return this.store.db
      .prepare(
        'SELECT d.* FROM authoring_drafts d LEFT JOIN assessments a ON a.id=d.id WHERE d.owner_id=? AND d.payload IS NOT NULL AND a.id IS NULL ORDER BY d.updated_at DESC',
      )
      .all(owner)
      .map((r) => {
        const d = validateWizard(JSON.parse(String(r.payload)));
        return {
          id: String(r.id),
          title: d.details.title || 'Untitled assessment',
          course: d.details.course,
          step: d.step,
          updatedAt: Number(r.updated_at),
        };
      });
  }
  saveDraft(owner: string, id: string, raw: unknown, expected: unknown): SavedWizard {
    if (!authoringId(id)) fail();
    const d = validateWizard(raw);
    if (d.requestId !== id) fail();
    this.assertWritable(owner, id);
    return transaction(this.store.db, () => {
      const db = this.store.db,
        old = db.prepare('SELECT * FROM authoring_drafts WHERE id=?').get(id),
        payload = canonicalBank(d);
      if (db.prepare('SELECT 1 FROM assessments WHERE id=?').get(id))
        throw new DomainError(
          'This draft has already become an assessment. Open the assessment instead.',
          409,
        );
      if (old && old.owner_id !== owner) throw new DomainError('Draft not found.', 404);
      if (old?.payload === payload) return { draft: d, revision: Number(old.revision) };
      if ((old?.revision ?? 0) !== expected)
        throw new DomainError(
          'This draft changed in another window. Your tab keeps its changes; reopen the saved draft before continuing.',
          409,
          'AUTHORING_CONFLICT',
        );
      if (
        !old &&
        Number(
          db.prepare('SELECT COUNT(*) n FROM authoring_drafts WHERE owner_id=?').get(owner)!.n,
        ) >= 500
      )
        throw new DomainError('This workspace has reached its draft limit.', 409);
      db.prepare(
        'INSERT INTO authoring_drafts VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,revision=excluded.revision,updated_at=excluded.updated_at',
      ).run(id, owner, payload, Number(old?.revision ?? 0) + 1, this.store.now());
      this.changed(owner);
      return { draft: d, revision: Number(old?.revision ?? 0) + 1 };
    });
  }
  discard(owner: string, id: string, expected: unknown) {
    this.assertWritable(owner, id);
    const row = this.ownedDraft(owner, id);
    if (row.revision !== expected)
      throw new DomainError('The draft changed. Reopen it before discarding.', 409);
    this.store.db
      .prepare(
        'UPDATE authoring_drafts SET payload=NULL,revision=revision+1,updated_at=? WHERE id=?',
      )
      .run(this.store.now(), id);
    this.changed(owner);
  }
  private snapshot(owner: string, id: string): AuthoringDocument | null {
    if (this.store.db.prepare('SELECT 1 FROM local_preparations WHERE run_id=?').get(id))
      return null;
    const db = this.store.db,
      owned = db
        .prepare('SELECT 1 FROM assessment_owners WHERE assessment_id=? AND owner_id=?')
        .get(id, owner);
    if (owned) {
      const r = db.prepare('SELECT * FROM registration_settings WHERE assessment_id=?').get(id)!;
      if (r.mode !== 'accounts') return null;
      const linked = db
        .prepare('SELECT roster_id id,name,revision FROM assessment_rosters WHERE assessment_id=?')
        .get(id);
      const imported = this.event(owner, id, 'authoring_cloud_import');
      return validateAuthoring({
        version: 1,
        id,
        kind: 'assessment',
        input: assessmentInput(this.store.assessment(id)),
        executionHostId: imported?.document?.executionHostId ?? this.hostId(),
        roster: linked ?? imported?.document?.roster ?? null,
        registration: {
          policy: r.policy,
          token: r.link_token,
          open: Boolean(r.is_open),
          closesAt: r.closes_at,
          capacity: r.capacity,
        },
      });
    }
    const row = db
      .prepare('SELECT payload FROM authoring_drafts WHERE id=? AND owner_id=?')
      .get(id, owner);
    return row
      ? {
          version: 1,
          id,
          kind: 'draft',
          draft: row.payload ? validateWizard(JSON.parse(String(row.payload))) : null,
        }
      : null;
  }
  private ids(owner: string) {
    return this.store.db
      .prepare(
        'SELECT id FROM authoring_drafts WHERE owner_id=? UNION SELECT assessment_id id FROM assessment_owners WHERE owner_id=?',
      )
      .all(owner, owner)
      .map((r) => String(r.id));
  }
  private import(owner: string, doc: AuthoringDocument) {
    const db = this.store.db;
    transaction(db, () => {
      const assessment = db
          .prepare('SELECT owner_id FROM assessment_owners WHERE assessment_id=?')
          .get(doc.id),
        draft = db.prepare('SELECT owner_id FROM authoring_drafts WHERE id=?').get(doc.id);
      if ((assessment && assessment.owner_id !== owner) || (draft && draft.owner_id !== owner))
        throw new DomainError('This identity belongs to another workspace.', 409);
      if (doc.kind === 'draft') {
        if (assessment)
          throw new DomainError('A created assessment cannot be replaced with a draft.', 409);
        db.prepare(
          'INSERT INTO authoring_drafts VALUES(?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,revision=authoring_drafts.revision+1,updated_at=excluded.updated_at',
        ).run(doc.id, owner, doc.draft ? canonicalBank(doc.draft) : null, this.store.now());
        return;
      }
      if (db.prepare('SELECT 1 FROM sittings WHERE assessment_id=?').get(doc.id))
        throw new DomainError(
          'This assessment has started here. Cloud changes cannot alter it.',
          409,
        );
      const parsed = parseAssessment(
        { ...doc.input, candidates: [], accessMode: 'accounts' },
        randomUUID,
      ).assessment;
      parsed.id = doc.id;
      if (assessment)
        db.prepare('UPDATE assessments SET definition=? WHERE id=?').run(
          JSON.stringify(parsed),
          doc.id,
        );
      else {
        db.prepare('INSERT INTO assessments VALUES(?,?,?)').run(
          doc.id,
          JSON.stringify(parsed),
          this.store.now(),
        );
        db.prepare('INSERT INTO assessment_owners VALUES(?,?)').run(doc.id, owner);
        db.prepare('INSERT INTO assessment_creations VALUES(?,?,?)').run(owner, doc.id, doc.id);
      }
      db.prepare(
        "INSERT INTO registration_settings(assessment_id,mode,policy,link_token,is_open,closes_at,capacity) VALUES(?,'accounts',?,?,?,?,?) ON CONFLICT(assessment_id) DO UPDATE SET policy=excluded.policy,link_token=excluded.link_token,is_open=excluded.is_open,closes_at=excluded.closes_at,capacity=excluded.capacity",
      ).run(
        doc.id,
        doc.registration.policy,
        doc.registration.token,
        Number(doc.registration.open),
        doc.registration.closesAt,
        doc.registration.capacity,
      );
      const localRoster =
        doc.roster &&
        db.prepare('SELECT 1 FROM rosters WHERE id=? AND owner_id=?').get(doc.roster.id, owner);
      db.prepare('DELETE FROM assessment_rosters WHERE assessment_id=?').run(doc.id);
      if (doc.roster && localRoster)
        db.prepare('INSERT INTO assessment_rosters VALUES(?,?,?,?)').run(
          doc.id,
          doc.roster.id,
          doc.roster.name,
          doc.roster.revision,
        );
      this.store.event(null, owner, 'authoring_cloud_import', { id: doc.id, document: doc });
      syncLinkedRosters(this.store, owner);
    });
  }
  assertDelivery(owner: string, id: string) {
    const doc = this.snapshot(owner, id);
    if (doc?.kind === 'assessment' && doc.executionHostId !== this.hostId())
      throw new DomainError(
        'Prepare a local run on this Host before starting, or run this assessment on its original Host.',
        409,
        'DELIVERY_NOT_PREPARED',
      );
  }
  deliveryReady(owner: string, id: string) {
    const doc = this.snapshot(owner, id);
    return doc?.kind !== 'assessment' || doc.executionHostId === this.hostId();
  }
  preparedSource(owner: string, id: string) {
    const document = this.snapshot(owner, id),
      checkpoint = this.checkpoint(owner, id);
    if (
      document?.kind !== 'assessment' ||
      !checkpoint ||
      checkpoint.localDigest !== digest(canonicalBank(document)) ||
      this.errors.has(owner + ':' + id)
    )
      throw new DomainError(
        'Save this assessment to the cloud before preparing local delivery.',
        409,
      );
    return { document, revision: checkpoint.revision, digest: checkpoint.cloudDigest };
  }
  assertWritable(owner: string, id: string) {
    if (this.resolving.has(owner) || this.errors.get(owner + ':' + id)?.state === 'conflict')
      throw new DomainError(
        'Cloud changes need review before this assessment can be changed. Your tab draft is kept.',
        409,
        'AUTHORING_CONFLICT',
      );
  }
  changed(owner: string) {
    this.due.set(owner, 0);
  }
  overview(owner: string): AuthoringOverview {
    const enabled = Boolean(this.auth && this.storage && this.binding(owner)),
      global = this.global.get(owner),
      ids = this.ids(owner);
    const rows = ids.map<AuthoringStatus>((id) => {
      const doc = this.snapshot(owner, id),
        base = this.checkpoint(owner, id);
      return {
        id,
        state:
          !enabled || !doc
            ? 'local'
            : this.activeExam()
              ? 'paused'
              : (this.errors.get(owner + ':' + id)?.state ??
                (doc && base?.localDigest === digest(canonicalBank(doc)) ? 'synced' : 'pending')),
        message: this.errors.get(owner + ':' + id)?.message,
        recoveryAvailable: Boolean(this.event(owner, id, 'authoring_cloud_recovery')),
        deliveryReady: doc?.kind !== 'assessment' || doc.executionHostId === this.hostId(),
      };
    });
    for (const [key, value] of this.errors)
      if (key.startsWith(owner + ':') && !ids.includes(value.id)) rows.push(value);
    return {
      enabled,
      state: enabled && this.activeExam() ? 'paused' : global?.state,
      message: global?.message,
      items: rows,
    };
  }
  private receipt(r: AuthoringReceipt, id: string) {
    if (
      r.id !== id ||
      !authoringId(id) ||
      !Number.isSafeInteger(r.revision) ||
      r.revision < 1 ||
      !/^[a-f0-9]{64}$/.test(r.digest)
    )
      throw new DomainError('Invalid cloud assessment receipt.', 502);
  }
  private read(r: AuthoringRecord, id: string) {
    this.receipt(r, id);
    if (
      typeof r.payload !== 'string' ||
      Buffer.byteLength(r.payload) > 1048576 ||
      digest(r.payload) !== r.digest
    )
      throw new DomainError('Cloud assessment checksum did not match.', 502);
    const d = validateAuthoring(JSON.parse(r.payload));
    if (d.id !== id) fail();
    return d;
  }
  private error(id: string, e: unknown): AuthoringStatus {
    const d = e instanceof DomainError ? e : null;
    return {
      id,
      state:
        d?.code === 'AUTHORING_CONFLICT'
          ? 'conflict'
          : d?.code === 'CLOUD_SETUP_REQUIRED'
            ? 'setup'
            : d?.status === 401
              ? 'signin'
              : d?.status === 409
                ? 'blocked'
                : 'offline',
      message: e instanceof Error ? e.message : 'Cloud assessment saving is unavailable.',
    };
  }
  async ensure(owner: string, force = false, focus?: string) {
    if (
      this.stopped ||
      this.activeExam() ||
      this.resolving.has(owner) ||
      !this.auth ||
      !this.storage ||
      !this.binding(owner)
    )
      return;
    if (this.flights.has(owner)) return this.flights.get(owner);
    if (!force && (this.due.get(owner) ?? 0) > this.store.now()) return;
    const p = this.sync(owner, focus).finally(() => {
      this.flights.delete(owner);
      this.due.set(owner, this.store.now() + 15000);
    });
    this.flights.set(owner, p);
    return p;
  }
  private async sync(owner: string, focus?: string) {
    try {
      const session = await this.auth!.credentials(owner, this.binding(owner)!);
      if (this.activeExam() || this.stopped) return;
      const directory = await this.storage!.list(session.accessToken);
      if (
        !Array.isArray(directory) ||
        directory.length > 1000 ||
        new Set(directory.map((r) => r.id)).size !== directory.length
      )
        throw new DomainError('Invalid cloud assessment directory.', 502);
      directory.forEach((r) => this.receipt(r, r.id));
      this.global.delete(owner);
      const ids = new Set([
          ...(focus ? [focus] : []),
          ...this.ids(owner),
          ...directory.map((r) => r.id),
        ]),
        start = Date.now();
      let work = 0;
      for (const id of ids) {
        if (this.activeExam() || this.stopped || (work > 0 && Date.now() - start > 8000)) return;
        try {
          const doc = this.snapshot(owner, id),
            payload = doc ? canonicalBank(doc) : null,
            hash = payload ? digest(payload) : null,
            base = this.checkpoint(owner, id),
            remote = directory.find((r) => r.id === id),
            dirty = Boolean(doc && base?.localDigest !== hash);
          if (
            !doc &&
            this.store.db
              .prepare('SELECT 1 FROM assessment_owners WHERE assessment_id=? AND owner_id=?')
              .get(id, owner)
          )
            continue;
          if (
            remote &&
            (!base || remote.revision !== base.revision || remote.digest !== base.cloudDigest)
          ) {
            work++;
            const record = await this.storage!.read(session.accessToken, id),
              next = this.read(record, id);
            if (this.activeExam() || this.stopped) return;
            if (payload === canonicalBank(next)) this.ack(owner, record, hash!);
            else {
              if (dirty || canonicalBank(this.snapshot(owner, id)) !== canonicalBank(doc))
                throw new DomainError(
                  'Both this Host and the cloud have changes. Neither copy was overwritten.',
                  409,
                  'AUTHORING_CONFLICT',
                );
              this.import(owner, next);
              this.ack(owner, record, digest(canonicalBank(this.snapshot(owner, id))));
            }
          } else if (dirty && payload) {
            work++;
            const result = await this.storage!.write(
              session.accessToken,
              base?.revision ?? 0,
              payload,
            );
            this.receipt(result, id);
            if (result.digest !== hash)
              throw new DomainError('Cloud assessment acknowledgement did not match.', 502);
            this.ack(owner, result, hash!);
          } else if (base && !remote)
            throw new DomainError(
              'The cloud copy is missing. Your local assessment was kept.',
              409,
              'AUTHORING_CONFLICT',
            );
          this.errors.delete(owner + ':' + id);
        } catch (e) {
          this.errors.set(owner + ':' + id, this.error(id, e));
        }
      }
    } catch (e) {
      this.global.set(owner, this.error('*', e));
    }
  }
  async resolve(owner: string, id: string, revalidate: () => void) {
    if (!this.storage || !this.auth || this.activeExam())
      throw new DomainError('Cloud changes cannot be loaded during a local examination.', 409);
    if (this.resolving.has(owner)) throw new DomainError('Cloud changes are already loading.', 409);
    this.resolving.add(owner);
    const run = (async () => {
      await this.flights.get(owner);
      const before = canonicalBank(this.snapshot(owner, id));
      if (before === 'null') throw new DomainError('Assessment not found.', 404);
      const session = await this.auth!.credentials(owner, this.binding(owner)!),
        record = await this.storage!.read(session.accessToken, id),
        doc = this.read(record, id);
      revalidate();
      if (this.activeExam() || before !== canonicalBank(this.snapshot(owner, id)))
        throw new DomainError(
          'The local assessment changed while loading. Both copies were kept.',
          409,
        );
      this.store.event(null, owner, 'authoring_cloud_recovery', { id, payload: before });
      this.import(owner, doc);
      this.ack(owner, record, digest(canonicalBank(this.snapshot(owner, id))));
      this.errors.delete(owner + ':' + id);
    })();
    this.resolutions.add(run);
    try {
      await run;
    } finally {
      this.resolving.delete(owner);
      this.resolutions.delete(run);
    }
  }
  recovery(owner: string, id: string) {
    const r = this.event(owner, id, 'authoring_cloud_recovery');
    if (!r) throw new DomainError('Recovery copy not found.', 404);
    return r.payload as string;
  }
  pump() {
    if (this.stopped || this.activeExam()) return;
    for (const r of this.store.db
      .prepare('SELECT administrator_id FROM admin_provider_identities')
      .all())
      void this.ensure(String(r.administrator_id));
  }
  async stop() {
    this.stopped = true;
    await Promise.allSettled([...this.flights.values(), ...this.resolutions]);
  }
}
