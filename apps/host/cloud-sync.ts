import { createHash, randomUUID } from 'node:crypto';
import { transaction } from './database.ts';
import type { ExamStore } from './store.ts';
import type { CloudAdministrators } from './cloud-administrators.ts';
import type { CloudRecords, UploadReceipt } from './cloud-records.ts';
import type {
  CloudExamRecord,
  CloudSyncStatus,
  SyncItem,
} from '../../packages/contracts/cloud-sync.ts';
import { DomainError } from '../../packages/exam-core/model.ts';

const partSize = 65536,
  maximumSize = 16 * 1024 * 1024;
export const recordDigest = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex');
type Job = {
  id: string;
  owner_id: string;
  provider_user_id: string;
  assessment_id: string;
  sitting_id: string;
  host_id: string;
  title: string;
  payload: string;
  digest: string;
  expected_revision: number;
  parts: number;
  attempts: number;
};

export class CloudSync {
  private store: ExamStore;
  private cloud: CloudAdministrators;
  private records: CloudRecords;
  private busy = false;
  private stopped = false;
  private completion: Promise<void> | undefined;
  constructor(store: ExamStore, cloud: CloudAdministrators, records: CloudRecords) {
    this.store = store;
    this.cloud = cloud;
    this.records = records;
    store.db
      .prepare(
        "UPDATE cloud_sync_jobs SET state='retry',retry_at=0,error='Synchronization was interrupted. Ready to resume.' WHERE state='uploading'",
      )
      .run();
    store.db.prepare('INSERT OR IGNORE INTO cloud_instance VALUES(1,?)').run(randomUUID());
  }
  private complete(id: string, owner: string) {
    this.store.assertOwner(id, owner);
    const detail = this.store.detail(id),
      sitting = detail.summary.sitting;
    if (
      !sitting ||
      detail.summary.status !== 'completed' ||
      sitting.pausedAt ||
      detail.candidates.some((c) => c.status === 'active')
    )
      throw new DomainError('Finish this examination before synchronizing its records.', 409);
    return detail;
  }
  private activeExamination() {
    return Boolean(
      this.store.db
        .prepare(
          `SELECT 1 FROM sittings s LEFT JOIN exam_controls c ON c.sitting_id=s.id
      WHERE s.deadline>? OR c.paused_at IS NOT NULL UNION ALL SELECT 1 FROM attempts WHERE status='active' AND deadline>? LIMIT 1`,
        )
        .get(this.store.now(), this.store.now()),
    );
  }
  snapshot(id: string, owner: string): CloudExamRecord {
    const detail = this.complete(id, owner),
      sitting = detail.summary.sitting!;
    return {
      version: 1,
      assessment: detail.assessment,
      sitting: { id: sitting.id, startedAt: sitting.startedAt, deadline: sitting.deadline },
      candidates: detail.candidates.map((c) => {
        const attempt = this.store.findAttempt(sitting.id, c.id);
        return {
          ...c,
          responses: attempt ? this.store.responses(attempt.id) : {},
          manualScores: attempt ? this.store.manualScores(attempt.id) : {},
        };
      }),
      events: this.store.db
        .prepare(
          "SELECT id,actor_id,kind,detail,created_at FROM events WHERE sitting_id=? AND kind NOT LIKE 'cloud_sync_%' ORDER BY id",
        )
        .all(sitting.id)
        .map((e) => ({
          id: Number(e.id),
          actor: String(e.actor_id),
          kind: String(e.kind),
          detail: JSON.parse(String(e.detail)),
          createdAt: Number(e.created_at),
        })),
    };
  }
  enqueue(owner: string, ids: unknown) {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 20 ||
      ids.some((id) => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) ||
      new Set(ids).size !== ids.length
    )
      throw new DomainError('Choose between one and twenty completed examinations.');
    const binding = this.store.db
      .prepare('SELECT provider_user_id FROM admin_provider_identities WHERE administrator_id=?')
      .get(owner);
    if (!binding) throw new DomainError('Connect your workspace to a cloud account first.', 409);
    // Prepare everything before insertion: one invalid selection cannot enqueue a partial set.
    const prepared = ids.map((id) => {
      const document = this.snapshot(id, owner),
        payload = JSON.stringify(document),
        bytes = Buffer.byteLength(payload);
      if (bytes > maximumSize)
        throw new DomainError(
          'This examination exceeds the current 16 MB sync limit. Export its results locally; no data has been truncated.',
          413,
        );
      return { id, document, payload, bytes, digest: recordDigest(payload) };
    });
    return transaction(this.store.db, () =>
      prepared.map((item) => {
        const pending = this.store.db
          .prepare(
            "SELECT id,digest FROM cloud_sync_jobs WHERE owner_id=? AND assessment_id=? AND state!='synced'",
          )
          .get(owner, item.id);
        if (pending) {
          if (pending.digest !== item.digest)
            throw new DomainError(
              'This examination has an unfinished synchronization. Finish it before syncing newer changes.',
              409,
            );
          return String(pending.id);
        }
        const previous = this.store.db
          .prepare(
            "SELECT id,digest,revision FROM cloud_sync_jobs WHERE owner_id=? AND provider_user_id=? AND assessment_id=? AND state='synced' ORDER BY revision DESC LIMIT 1",
          )
          .get(owner, binding.provider_user_id!, item.id);
        if (previous?.digest === item.digest) return String(previous.id);
        const id = randomUUID(),
          host = this.store.db.prepare('SELECT id FROM cloud_instance WHERE singleton=1').get()!;
        this.store.db
          .prepare(
            `INSERT INTO cloud_sync_jobs(id,owner_id,provider_user_id,assessment_id,sitting_id,host_id,title,payload,digest,expected_revision,state,parts,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?)`,
          )
          .run(
            id,
            owner,
            binding.provider_user_id!,
            item.id,
            item.document.sitting.id,
            host.id!,
            item.document.assessment.title,
            item.payload,
            item.digest,
            Number(previous?.revision ?? 0),
            Math.ceil(item.bytes / partSize),
            this.store.now(),
          );
        this.store.event(item.document.sitting.id, owner, 'cloud_sync_queued', { jobId: id });
        return id;
      }),
    );
  }
  status(owner: string, signedIn: boolean): CloudSyncStatus {
    const connected = Boolean(
      this.store.db
        .prepare('SELECT 1 FROM admin_provider_identities WHERE administrator_id=?')
        .get(owner),
    );
    const items = this.store.db
      .prepare(
        `SELECT id,assessment_id AS assessmentId,title,state,uploaded,parts AS total,error,synced_at AS syncedAt,revision
      FROM cloud_sync_jobs WHERE owner_id=? AND rowid IN (SELECT max(rowid) FROM cloud_sync_jobs WHERE owner_id=? GROUP BY assessment_id) ORDER BY created_at DESC,rowid DESC`,
      )
      .all(owner, owner) as unknown as SyncItem[];
    const ready = this.store
      .listAssessments(owner)
      .filter(
        (a) =>
          a.status === 'completed' &&
          !a.sitting?.pausedAt &&
          !this.store.db
            .prepare("SELECT 1 FROM attempts WHERE sitting_id=? AND status='active' LIMIT 1")
            .get(a.sitting?.id ?? ''),
      )
      .map((a) => ({ id: a.id, title: a.title, candidateCount: a.candidateCount }));
    return {
      available: true,
      connected,
      signedIn,
      items,
      ready,
      pausedForExam: this.activeExamination(),
    };
  }
  retry(owner: string, id: string) {
    const row = this.store.db
      .prepare('SELECT state FROM cloud_sync_jobs WHERE id=? AND owner_id=?')
      .get(id, owner);
    if (!row) throw new DomainError('Synchronization not found.', 404);
    if (row.state === 'conflict')
      throw new DomainError(
        'A conflicting cloud record must be reviewed before proceeding. Neither copy has been overwritten.',
        409,
        'SYNC_CONFLICT',
      );
    this.store.db
      .prepare(
        "UPDATE cloud_sync_jobs SET state='pending',retry_at=0,error=NULL WHERE id=? AND owner_id=? AND state='retry'",
      )
      .run(id, owner);
  }
  private ack(job: Job, receipt: UploadReceipt) {
    if (
      receipt?.id !== job.assessment_id ||
      receipt.digest !== job.digest ||
      !Number.isSafeInteger(receipt.revision) ||
      receipt.revision < 1
    )
      throw new DomainError(
        'Cloud storage returned an invalid acknowledgment. Your local record has been retained.',
        503,
      );
    transaction(this.store.db, () => {
      this.store.db
        .prepare(
          "UPDATE cloud_sync_jobs SET state='synced',uploaded=parts,synced_at=?,revision=?,error=NULL,payload='' WHERE id=? AND state='uploading'",
        )
        .run(this.store.now(), receipt.revision, job.id);
      this.store.event(job.sitting_id, job.owner_id, 'cloud_sync_confirmed', {
        jobId: job.id,
        revision: receipt.revision,
      });
    });
  }
  async pump() {
    if (this.busy || this.stopped || this.activeExamination()) return;
    this.busy = true;
    let resolveCompletion: () => void = () => {};
    this.completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    let job: Job | undefined;
    try {
      job = this.store.db
        .prepare(
          "SELECT * FROM cloud_sync_jobs WHERE state IN ('pending','retry') AND retry_at<=? ORDER BY created_at LIMIT 1",
        )
        .get(this.store.now()) as unknown as Job | undefined;
      if (!job) return;
      this.store.assertOwner(job.assessment_id, job.owner_id);
      const credentials = await this.cloud.credentials(job.owner_id, job.provider_user_id);
      if (this.stopped) return;
      this.store.db
        .prepare(
          "UPDATE cloud_sync_jobs SET state='uploading',attempts=attempts+1,error=NULL WHERE id=?",
        )
        .run(job.id);
      await this.records.ready(credentials.accessToken);
      const bytes = Buffer.from(job.payload),
        manifest = {
          id: job.id,
          recordId: job.assessment_id,
          sittingId: job.sitting_id,
          hostId: job.host_id,
          expectedRevision: job.expected_revision,
          digest: job.digest,
          byteLength: bytes.length,
          parts: job.parts,
        };
      if (recordDigest(bytes) !== job.digest)
        throw new DomainError(
          'The queued record failed its local integrity check. It has not been uploaded.',
          409,
          'SYNC_CONFLICT',
        );
      const start = await this.records.begin(credentials.accessToken, manifest);
      if (
        start?.digest !== job.digest ||
        !Array.isArray(start.received) ||
        start.received.length > job.parts ||
        start.received.some((i) => !Number.isInteger(i) || i < 0 || i >= job!.parts) ||
        new Set(start.received).size !== start.received.length
      )
        throw new DomainError('Cloud storage returned invalid upload progress.', 503);
      if (start.revision === null) {
        const received = new Set(start.received);
        this.store.db
          .prepare('UPDATE cloud_sync_jobs SET uploaded=? WHERE id=?')
          .run(received.size, job.id);
        for (let index = 0; index < job.parts; index++) {
          if (this.stopped) return;
          if (this.activeExamination()) {
            this.store.db
              .prepare("UPDATE cloud_sync_jobs SET state='pending' WHERE id=?")
              .run(job.id);
            return;
          }
          if (received.has(index)) continue;
          const fresh = await this.cloud.credentials(job.owner_id, job.provider_user_id);
          await this.records.part(
            fresh.accessToken,
            job.id,
            index,
            bytes.subarray(index * partSize, (index + 1) * partSize).toString('base64'),
          );
          received.add(index);
          this.store.db
            .prepare('UPDATE cloud_sync_jobs SET uploaded=? WHERE id=?')
            .run(received.size, job.id);
        }
      }
      if (this.stopped) return;
      if (this.activeExamination()) {
        this.store.db.prepare("UPDATE cloud_sync_jobs SET state='pending' WHERE id=?").run(job.id);
        return;
      }
      const fresh = await this.cloud.credentials(job.owner_id, job.provider_user_id);
      this.ack(job, await this.records.finish(fresh.accessToken, job.id));
    } catch (error) {
      if (job && !this.stopped) {
        const conflict = error instanceof DomainError && error.code === 'SYNC_CONFLICT';
        const message =
          error instanceof DomainError
            ? error.message
            : 'Cloud synchronization was interrupted. Your local records are safe.';
        const delay = Math.min(300000, 15000 * 2 ** Math.min(job.attempts, 5));
        this.store.db
          .prepare('UPDATE cloud_sync_jobs SET state=?,retry_at=?,error=? WHERE id=?')
          .run(conflict ? 'conflict' : 'retry', this.store.now() + delay, message, job.id);
      }
    } finally {
      this.busy = false;
      resolveCompletion();
    }
  }
  async list(owner: string, offset: number) {
    const session = await this.cloud.credentials(owner);
    return this.records.list(session.accessToken, offset);
  }
  async read(owner: string, id: string) {
    const session = await this.cloud.credentials(owner);
    return this.records.read(session.accessToken, id);
  }
  async stop() {
    this.stopped = true;
    await this.completion;
  }
}
