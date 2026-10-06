import { randomUUID } from 'node:crypto';
import type {
  CloudBankReceipt,
  CloudBankSnapshot,
  CloudBankStatus,
} from '../../packages/contracts/cloud-question-bank.ts';
import { DomainError } from '../../packages/exam-core/model.ts';
import { object, text } from '../../packages/exam-core/engine.ts';
import type { ExamStore } from './store.ts';
import type { CloudAdministrators } from './cloud-administrators.ts';
import type { CloudBankStorage } from './cloud-bank-storage.ts';
import { bankId, validateBankContent } from './question-bank.ts';
import { digest } from './security.ts';
import { transaction } from './database.ts';

export function canonicalBank(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalBank).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalBank((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}
function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum)
    throw new DomainError(
      'Cloud question bank contains invalid data. Your local copy is unchanged.',
      503,
    );
  return Number(value);
}
export function validateCloudBank(raw: unknown): CloudBankSnapshot {
  const value = object(raw);
  if (
    value.version !== 1 ||
    !Array.isArray(value.projects) ||
    !Array.isArray(value.questions) ||
    value.projects.length > 500 ||
    value.questions.length > 10000
  )
    throw new DomainError('Cloud question bank has an unsupported format.', 503);
  const projects = value.projects
    .map((raw) => {
      const p = object(raw);
      if (typeof p.archived !== 'boolean') throw new DomainError('Invalid cloud project.', 503);
      return {
        id: bankId(p.id),
        name: text(p.name, 'Project name', 120),
        course: text(p.course, 'Course', 100, 0),
        description: text(p.description, 'Description', 1000, 0),
        archived: p.archived,
        revision: integer(p.revision, 1),
        updatedAt: integer(p.updatedAt),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const projectIds = new Set(projects.map((p) => p.id));
  if (projectIds.size !== projects.length) throw new DomainError('Duplicate cloud projects.', 503);
  const questions = value.questions
    .map((raw) => {
      const q = object(raw);
      if (
        !['draft', 'approved', 'archived'].includes(String(q.status)) ||
        !['manual', 'ai'].includes(String(q.origin)) ||
        !projectIds.has(bankId(q.projectId)) ||
        typeof q.creationFingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/.test(q.creationFingerprint)
      )
        throw new DomainError('Invalid cloud question.', 503);
      const content = validateBankContent(q, q.status === 'approved');
      return {
        ...content,
        id: bankId(q.id),
        projectId: bankId(q.projectId),
        revision: integer(q.revision, 1),
        updatedAt: integer(q.updatedAt),
        status: q.status as 'draft' | 'approved' | 'archived',
        origin: q.origin as 'manual' | 'ai',
        evidence: text(q.evidence, 'Evidence', 10000, 0),
        model: q.model === null ? null : text(q.model, 'Model', 200),
        deletedAt: q.deletedAt === null ? null : integer(q.deletedAt),
        creationFingerprint: q.creationFingerprint,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(questions.map((q) => q.id)).size !== questions.length)
    throw new DomainError('Duplicate cloud questions.', 503);
  const snapshot: CloudBankSnapshot = { version: 1, projects, questions };
  if (Buffer.byteLength(canonicalBank(snapshot)) > 8 * 1024 * 1024)
    throw new DomainError(
      'This question bank exceeds the current 8 MB synchronization limit. Your local work is safe.',
      413,
    );
  return snapshot;
}
interface Checkpoint extends CloudBankReceipt {
  localDigest: string;
  providerUserId: string;
  at: number;
}
function questionMeaning(q: CloudBankSnapshot['questions'][number] | undefined) {
  if (!q) return null;
  const { id, revision, updatedAt, creationFingerprint, ...content } = q;
  return content;
}
function projectMeaning(p: CloudBankSnapshot['projects'][number] | undefined) {
  if (!p) return null;
  const { id, revision, updatedAt, ...content } = p;
  return content;
}

export class CloudQuestionBank {
  readonly store: ExamStore;
  readonly administrators: CloudAdministrators;
  readonly storage: CloudBankStorage;
  private pending = new Map<string, Promise<void>>();
  private errors = new Map<string, { state: CloudBankStatus['state']; message: string }>();
  private due = new Map<string, number>();
  private resolutions = new Map<string, Promise<CloudBankStatus>>();
  private stopped = false;
  constructor(store: ExamStore, administrators: CloudAdministrators, storage: CloudBankStorage) {
    this.store = store;
    this.administrators = administrators;
    this.storage = storage;
  }
  snapshot(owner: string): CloudBankSnapshot {
    const db = this.store.db;
    const projects = db
      .prepare('SELECT * FROM bank_projects WHERE owner_id=? ORDER BY id')
      .all(owner)
      .map((p) => ({
        id: String(p.id),
        name: String(p.name),
        course: String(p.course),
        description: String(p.description),
        archived: Boolean(p.archived),
        revision: Number(p.revision),
        updatedAt: Number(p.updated_at),
      }));
    const questions = db
      .prepare(
        `SELECT q.*,m.project_id,d.deleted_at FROM bank_questions q JOIN bank_question_projects m ON m.question_id=q.id LEFT JOIN bank_deleted_questions d ON d.question_id=q.id WHERE q.owner_id=? ORDER BY q.id`,
      )
      .all(owner)
      .map((q) => ({
        ...JSON.parse(String(q.content)),
        id: String(q.id),
        projectId: String(q.project_id),
        revision: Number(q.revision),
        status: q.status,
        updatedAt: Number(q.updated_at),
        origin: q.origin,
        evidence: String(q.evidence),
        model: q.model == null ? null : String(q.model),
        deletedAt: q.deleted_at == null ? null : Number(q.deleted_at),
        creationFingerprint: String(q.creation_fingerprint),
      }));
    return validateCloudBank({ version: 1, projects, questions });
  }
  private binding(owner: string): string | null {
    const row = this.store.db
      .prepare('SELECT provider_user_id FROM admin_provider_identities WHERE administrator_id=?')
      .get(owner);
    return row ? String(row.provider_user_id) : null;
  }
  private checkpoint(owner: string): Checkpoint | null {
    const row = this.store.db
      .prepare(
        "SELECT detail FROM events WHERE actor_id=? AND kind='bank_cloud_checkpoint' ORDER BY id DESC LIMIT 1",
      )
      .get(owner);
    if (!row) return null;
    const checkpoint = JSON.parse(String(row.detail)) as Checkpoint;
    return checkpoint.providerUserId === this.binding(owner) ? checkpoint : null;
  }
  private recordCheckpoint(owner: string, remote: CloudBankReceipt) {
    this.store.event(null, owner, 'bank_cloud_checkpoint', {
      ...remote,
      localDigest: digest(canonicalBank(this.snapshot(owner))),
      providerUserId: this.binding(owner),
      at: this.store.now(),
    });
    this.errors.delete(owner);
  }
  private receipt(raw: CloudBankReceipt): CloudBankReceipt {
    if (
      !raw ||
      !Number.isSafeInteger(raw.revision) ||
      raw.revision < 0 ||
      (raw.revision === 0 ? raw.digest !== '' : !/^[a-f0-9]{64}$/.test(raw.digest))
    )
      throw new DomainError(
        'Cloud question bank returned an invalid receipt. Your local copy is safe.',
        503,
      );
    return raw;
  }
  private activeExam() {
    return Boolean(
      this.store.db
        .prepare(
          `SELECT 1 FROM sittings s LEFT JOIN exam_controls c ON c.sitting_id=s.id WHERE s.deadline>? OR c.paused_at IS NOT NULL UNION ALL SELECT 1 FROM attempts WHERE status='active' AND deadline>? LIMIT 1`,
        )
        .get(this.store.now(), this.store.now()),
    );
  }
  status(owner: string): CloudBankStatus {
    const base = this.checkpoint(owner);
    const common = {
      revision: base?.revision ?? 0,
      lastSyncedAt: base?.at ?? null,
      recoveryAvailable: Boolean(
        this.store.db
          .prepare(
            "SELECT 1 FROM events WHERE actor_id=? AND kind='bank_cloud_recovery_copy' LIMIT 1",
          )
          .get(owner),
      ),
    };
    if (!this.binding(owner)) return { ...common, state: 'local', message: null };
    const error = this.errors.get(owner);
    if (error) return { ...common, ...error };
    if (this.activeExam())
      return {
        ...common,
        state: 'paused',
        message:
          'Cloud updates will continue after the examination. Your questions are saved here.',
      };
    const dirty = !base || base.localDigest !== digest(canonicalBank(this.snapshot(owner)));
    return { ...common, state: dirty ? 'pending' : 'synced', message: null };
  }
  assertWritable(owner: string) {
    if (this.resolutions.has(owner))
      throw new DomainError('Cloud changes are being resolved. Please wait before editing.', 409);
    if (this.errors.get(owner)?.state === 'conflict')
      throw new DomainError(
        'Review the two question-bank copies before editing. Neither copy has been overwritten.',
        409,
        'BANK_CONFLICT',
      );
  }
  async synchronize(owner: string) {
    if (this.stopped || this.resolutions.has(owner) || !this.binding(owner) || this.activeExam())
      return;
    if (this.pending.has(owner)) return this.pending.get(owner);
    const action = this.synchronizeOnce(owner)
      .catch((error) => {
        const domain =
          error instanceof DomainError
            ? error
            : new DomainError('Cloud is unavailable. Your work is saved on this computer.', 503);
        this.errors.set(owner, {
          state:
            domain.code === 'BANK_CONFLICT'
              ? 'conflict'
              : domain.code === 'CLOUD_SETUP_REQUIRED'
                ? 'setup'
                : domain.status === 401
                  ? 'signin'
                  : 'offline',
          message: domain.message,
        });
      })
      .finally(() => {
        this.pending.delete(owner);
        this.due.set(owner, this.store.now() + 15000);
      });
    this.pending.set(owner, action);
    return action;
  }
  private async synchronizeOnce(owner: string) {
    const identity = await this.administrators.credentials(owner, this.binding(owner)!);
    const local = this.snapshot(owner),
      localDigest = digest(canonicalBank(local)),
      base = this.checkpoint(owner);
    const remote = this.receipt(await this.storage.metadata(identity.accessToken));
    if (this.stopped || this.activeExam()) return;
    if (remote.digest === localDigest) {
      if (!base || base.revision !== remote.revision || base.localDigest !== localDigest)
        this.recordCheckpoint(owner, remote);
      this.errors.delete(owner);
      return;
    }
    const empty = !local.projects.length && !local.questions.length;
    const dirty = base ? localDigest !== base.localDigest : !empty;
    if (
      (!base && remote.revision > 0 && !empty) ||
      (base && dirty && remote.revision !== base.revision)
    )
      throw new DomainError(
        'This computer and the cloud have different question-bank changes. Review both copies before continuing.',
        409,
        'BANK_CONFLICT',
      );
    if (remote.revision !== (base?.revision ?? 0) || (!base && remote.revision > 0)) {
      const value = await this.storage.read(identity.accessToken);
      const receipt = this.receipt(value);
      const snapshot = validateCloudBank(value.snapshot);
      if (digest(canonicalBank(snapshot)) !== receipt.digest)
        throw new DomainError(
          'Cloud question bank failed its integrity check. Your local copy is unchanged.',
          503,
        );
      if (
        this.stopped ||
        this.activeExam() ||
        digest(canonicalBank(this.snapshot(owner))) !== localDigest
      )
        return;
      transaction(this.store.db, () => {
        this.importSnapshot(owner, snapshot);
        this.recordCheckpoint(owner, receipt);
      });
      return;
    }
    if (dirty) {
      const receipt = this.receipt(
        await this.storage.write(identity.accessToken, remote.revision, canonicalBank(local)),
      );
      if (receipt.digest !== localDigest || receipt.revision <= remote.revision)
        throw new DomainError(
          'Cloud question bank did not confirm your changes. Your local copy is safe.',
          503,
        );
      // Record the actual snapshot acknowledged, not newer local edits made during the upload.
      this.store.event(null, owner, 'bank_cloud_checkpoint', {
        ...receipt,
        localDigest,
        providerUserId: identity.userId,
        at: this.store.now(),
      });
    } else if (!base) this.recordCheckpoint(owner, remote);
    this.errors.delete(owner);
  }
  private importSnapshot(owner: string, snapshot: CloudBankSnapshot) {
    const db = this.store.db;
    // All changes below run in one SQLite transaction; IDs owned by someone else can never be adopted.
    for (const p of snapshot.projects) {
      const old = db.prepare('SELECT * FROM bank_projects WHERE id=?').get(p.id);
      if (old && old.owner_id !== owner)
        throw new DomainError(
          'Cloud project conflicts with another workspace. No records were changed.',
          409,
          'BANK_CONFLICT',
        );
      const changed =
        old &&
        (old.name !== p.name ||
          old.course !== p.course ||
          old.description !== p.description ||
          Boolean(old.archived) !== p.archived);
      const revision = changed ? Math.max(Number(old.revision) + 1, p.revision) : p.revision;
      db.prepare(
        `INSERT INTO bank_projects VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,course=excluded.course,description=excluded.description,archived=excluded.archived,revision=excluded.revision,updated_at=excluded.updated_at`,
      ).run(
        p.id,
        owner,
        p.name,
        p.course,
        p.description,
        p.archived ? 1 : 0,
        revision,
        p.updatedAt,
      );
    }
    const questionIds = new Set(snapshot.questions.map((q) => q.id));
    for (const q of db.prepare('SELECT id FROM bank_questions WHERE owner_id=?').all(owner))
      if (!questionIds.has(String(q.id)))
        db.prepare('INSERT OR IGNORE INTO bank_deleted_questions VALUES(?,?,?)').run(
          q.id!,
          owner,
          this.store.now(),
        );
    const projectIds = new Set(snapshot.projects.map((p) => p.id));
    for (const p of db.prepare('SELECT id FROM bank_projects WHERE owner_id=?').all(owner))
      if (!projectIds.has(String(p.id)))
        db.prepare('UPDATE bank_projects SET archived=1,revision=revision+1 WHERE id=?').run(p.id!);
    for (const q of snapshot.questions) {
      const content = validateBankContent(q, q.status === 'approved');
      const serialized = JSON.stringify(content);
      const old = db
        .prepare(
          'SELECT q.*,m.project_id FROM bank_questions q JOIN bank_question_projects m ON m.question_id=q.id WHERE q.id=?',
        )
        .get(q.id);
      if (old && old.owner_id !== owner)
        throw new DomainError(
          'Cloud question conflicts with another workspace. No records were changed.',
          409,
          'BANK_CONFLICT',
        );
      const changed =
        old &&
        (canonicalBank(JSON.parse(String(old.content))) !== canonicalBank(content) ||
          old.status !== q.status ||
          old.project_id !== q.projectId);
      const revision = changed ? Math.max(Number(old.revision) + 1, q.revision) : q.revision;
      db.prepare(
        `INSERT INTO bank_questions VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,status=excluded.status,revision=excluded.revision,updated_at=excluded.updated_at,origin=excluded.origin,evidence=excluded.evidence,model=excluded.model,creation_fingerprint=excluded.creation_fingerprint`,
      ).run(
        q.id,
        owner,
        serialized,
        q.status,
        revision,
        q.updatedAt,
        q.origin,
        q.evidence,
        q.model,
        q.creationFingerprint,
      );
      db.prepare(
        'INSERT INTO bank_question_projects VALUES(?,?) ON CONFLICT(question_id) DO UPDATE SET project_id=excluded.project_id',
      ).run(q.id, q.projectId);
      db.prepare('INSERT OR IGNORE INTO bank_revisions VALUES(?,?,?,?,?)').run(
        q.id,
        revision,
        serialized,
        q.status,
        q.updatedAt,
      );
      if (q.deletedAt === null)
        db.prepare('DELETE FROM bank_deleted_questions WHERE question_id=?').run(q.id);
      else
        db.prepare(
          'INSERT INTO bank_deleted_questions VALUES(?,?,?) ON CONFLICT(question_id) DO UPDATE SET deleted_at=excluded.deleted_at',
        ).run(q.id, owner, q.deletedAt);
    }
  }
  async resolve(owner: string, keepBoth: boolean, stillAuthorised: () => void = () => {}) {
    if (this.resolutions.has(owner))
      throw new DomainError('Cloud changes are already being resolved.', 409);
    if (this.stopped)
      throw new DomainError('The Host is shutting down. Try again after restarting.', 503);
    const action = this.resolveOnce(owner, keepBoth, stillAuthorised).finally(() => {
      this.resolutions.delete(owner);
      this.due.set(owner, 0);
    });
    this.resolutions.set(owner, action);
    return action;
  }
  private async resolveOnce(owner: string, keepBoth: boolean, stillAuthorised: () => void) {
    await this.pending.get(owner);
    if (this.activeExam())
      throw new DomainError('Finish the active examination before resolving cloud changes.', 409);
    const identity = await this.administrators.credentials(owner, this.binding(owner) ?? undefined);
    const saved = this.snapshot(owner),
      savedDigest = digest(canonicalBank(saved));
    const remote = await this.storage.read(identity.accessToken),
      receipt = this.receipt(remote);
    const snapshot = validateCloudBank(remote.snapshot);
    if (!receipt.revision || digest(canonicalBank(snapshot)) !== receipt.digest)
      throw new DomainError('Cloud copy could not be checked. Neither copy has been changed.', 503);
    if (this.activeExam() || this.stopped)
      throw new DomainError(
        'An examination started or the Host is closing. Neither question-bank copy has been changed.',
        409,
      );
    if (digest(canonicalBank(this.snapshot(owner))) !== savedDigest)
      throw new DomainError('Your local questions changed. Review the copies again.', 409);
    stillAuthorised();
    transaction(this.store.db, () => {
      this.store.event(null, owner, 'bank_cloud_recovery_copy', {
        snapshot: saved,
        providerUserId: identity.userId,
        at: this.store.now(),
      });
      this.importSnapshot(owner, snapshot);
      this.recordCheckpoint(owner, receipt);
      if (keepBoth) {
        const cloudQuestions = new Map(snapshot.questions.map((q) => [q.id, q]));
        const different = saved.questions.filter(
          (q) =>
            q.deletedAt === null &&
            canonicalBank(questionMeaning(cloudQuestions.get(q.id))) !==
              canonicalBank(questionMeaning(q)),
        );
        const targets = new Map<string, string>();
        for (const p of saved.projects) {
          if (
            !different.some((q) => q.projectId === p.id) &&
            canonicalBank(
              projectMeaning(snapshot.projects.find((remote) => remote.id === p.id)),
            ) === canonicalBank(projectMeaning(p))
          )
            continue;
          const id = randomUUID();
          targets.set(p.id, id);
          this.store.db
            .prepare('INSERT INTO bank_projects VALUES(?,?,?,?,?,?,1,?)')
            .run(
              id,
              owner,
              `${p.name.slice(0, 95)} · Recovered copy`,
              p.course,
              p.description,
              p.archived ? 1 : 0,
              this.store.now(),
            );
        }
        for (const q of different) {
          const id = randomUUID(),
            content = JSON.stringify(validateBankContent(q, q.status === 'approved'));
          this.store.db
            .prepare('INSERT INTO bank_questions VALUES(?,?,?,?,1,?,?,?,?,?)')
            .run(
              id,
              owner,
              content,
              q.status,
              this.store.now(),
              q.origin,
              q.evidence,
              q.model,
              q.creationFingerprint,
            );
          this.store.db
            .prepare('INSERT INTO bank_question_projects VALUES(?,?)')
            .run(id, targets.get(q.projectId)!);
          this.store.db
            .prepare('INSERT INTO bank_revisions VALUES(?,1,?,?,?)')
            .run(id, content, q.status, this.store.now());
        }
      }
    });
    this.errors.delete(owner);
    return this.status(owner);
  }
  recovery(owner: string): CloudBankSnapshot {
    const row = this.store.db
      .prepare(
        "SELECT detail FROM events WHERE actor_id=? AND kind='bank_cloud_recovery_copy' ORDER BY id DESC LIMIT 1",
      )
      .get(owner);
    if (!row) throw new DomainError('No recovery copy is available.', 404);
    return JSON.parse(String(row.detail)).snapshot;
  }
  pump() {
    if (this.stopped || this.activeExam()) return;
    for (const row of this.store.db
      .prepare('SELECT administrator_id FROM admin_provider_identities')
      .all()) {
      const owner = String(row.administrator_id);
      if ((this.due.get(owner) ?? 0) <= this.store.now()) void this.synchronize(owner);
    }
  }
  async stop() {
    this.stopped = true;
    await Promise.allSettled([...this.pending.values(), ...this.resolutions.values()]);
  }
  async ensure(owner: string) {
    if ((this.due.get(owner) ?? 0) <= this.store.now()) await this.synchronize(owner);
    else await this.pending.get(owner);
  }
  changed(owner: string) {
    this.due.set(owner, 0);
  }
}
