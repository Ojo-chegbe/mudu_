import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { DomainError } from '../../packages/exam-core/model.ts';
import type { Assessment } from '../../packages/exam-core/model.ts';
import { parseAssessment, object, text } from '../../packages/exam-core/engine.ts';
import { assessmentInput } from '../../packages/contracts/assessment-authoring.ts';
import type {
  LocalExamPass,
  LocalPreparationStatus,
} from '../../packages/contracts/local-preparation.ts';
import type { PreparationStorage, PreparationUpload } from './local-preparation-storage.ts';
import type { ExamStore } from './store.ts';
import type { CloudAdministrators } from './cloud-administrators.ts';
import type { CloudAuthoring } from './cloud-authoring.ts';
import { authoringId } from './cloud-authoring.ts';
import { canonicalBank } from './cloud-question-bank.ts';
import { digest } from './security.ts';
import { transaction } from './database.ts';
interface Manifest {
  version: 1;
  id: string;
  hostId: string;
  providerOwner: string;
  sourceId: string;
  sourceRevision: number;
  sourceDigest: string;
  run: Assessment;
  expiresAt: number;
  members: Array<{
    accountId: string;
    localAccountId: string;
    name: string;
    email: string;
    identifier: string;
    candidateId: string;
    registrationId: string;
    pass: LocalExamPass;
  }>;
}
export function parseLocalPass(raw: unknown): LocalExamPass {
  const p = object(raw);
  if (
    p.version !== 1 ||
    ![p.preparationId, p.runId, p.hostId, p.accountId, p.candidateId].every(authoringId) ||
    typeof p.credential !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(p.credential) ||
    !Number.isSafeInteger(p.expiresAt) ||
    Number(p.expiresAt) < 0
  )
    throw new DomainError('Choose a valid local exam access file.', 400);
  return {
    version: 1,
    preparationId: p.preparationId as string,
    runId: p.runId as string,
    hostId: p.hostId as string,
    accountId: p.accountId as string,
    candidateId: p.candidateId as string,
    credential: p.credential,
    expiresAt: Number(p.expiresAt),
    title: text(p.title, 'Assessment title', 180),
  };
}
export class LocalPreparation {
  store: ExamStore;
  auth: CloudAdministrators | null;
  authoring: CloudAuthoring;
  storage: PreparationStorage | null;
  key: Buffer | null;
  private flights = new Map<string, Promise<void>>();
  private due = new Map<string, number>();
  private stopped = false;
  constructor(
    store: ExamStore,
    authoring: CloudAuthoring,
    auth: CloudAdministrators | null,
    storage: PreparationStorage | null,
    key: Buffer | null,
  ) {
    this.store = store;
    this.authoring = authoring;
    this.auth = auth;
    this.storage = storage;
    this.key = key;
  }
  hostId() {
    this.store.db.prepare('INSERT OR IGNORE INTO cloud_instance VALUES(1,?)').run(randomUUID());
    return String(
      this.store.db.prepare('SELECT id FROM cloud_instance WHERE singleton=1').get()!.id,
    );
  }
  private provider(owner: string) {
    const r = this.store.db
      .prepare('SELECT provider_user_id FROM admin_provider_identities WHERE administrator_id=?')
      .get(owner);
    if (!r)
      throw new DomainError(
        'Connect this workspace to your cloud account before preparing cloud candidates.',
        409,
      );
    return String(r.provider_user_id);
  }
  private derivedKey() {
    if (!this.key || this.key.length !== 32)
      throw new DomainError(
        'The Host preparation key is unavailable. Keep the original Host data folder.',
        409,
      );
    return Buffer.from(hkdfSync('sha256', this.key, 'mudu.local-package', 'v1', 32));
  }
  private seal(value: unknown) {
    const iv = randomBytes(12),
      hostId = this.hostId(),
      c = createCipheriv('aes-256-gcm', this.derivedKey(), iv);
    c.setAAD(Buffer.from(`mudu.local-package.v1:${hostId}`));
    const data = Buffer.concat([c.update(canonicalBank(value), 'utf8'), c.final()]);
    return JSON.stringify({
      version: 1,
      hostId,
      iv: iv.toString('base64url'),
      tag: c.getAuthTag().toString('base64url'),
      data: data.toString('base64url'),
    });
  }
  private open(sealed: string): Manifest {
    try {
      if (Buffer.byteLength(sealed) > 4194304) throw new Error();
      const e = object(JSON.parse(sealed));
      if (e.version !== 1 || e.hostId !== this.hostId()) throw new Error();
      const iv = Buffer.from(String(e.iv), 'base64url'),
        tag = Buffer.from(String(e.tag), 'base64url');
      if (iv.length !== 12 || tag.length !== 16) throw new Error();
      const c = createDecipheriv('aes-256-gcm', this.derivedKey(), iv);
      c.setAAD(Buffer.from(`mudu.local-package.v1:${e.hostId}`));
      c.setAuthTag(tag);
      const m = JSON.parse(
        Buffer.concat([c.update(Buffer.from(String(e.data), 'base64url')), c.final()]).toString(
          'utf8',
        ),
      ) as Manifest;
      if (
        m.version !== 1 ||
        m.hostId !== this.hostId() ||
        ![m.id, m.sourceId, m.providerOwner, m.run.id].every(authoringId) ||
        !Array.isArray(m.members) ||
        m.members.length < 1 ||
        m.members.length > 500 ||
        new Set(m.members.map((x) => x.accountId)).size !== m.members.length ||
        new Set(m.members.map((x) => x.identifier)).size !== m.members.length
      )
        throw new Error();
      parseAssessment(
        { ...assessmentInput(m.run), accessMode: 'accounts', candidates: [] },
        randomUUID,
      );
      for (const member of m.members) {
        const p = parseLocalPass(member.pass);
        if (
          p.preparationId !== m.id ||
          p.runId !== m.run.id ||
          p.hostId !== m.hostId ||
          p.accountId !== member.accountId ||
          p.candidateId !== member.candidateId ||
          p.expiresAt !== m.expiresAt ||
          ![member.localAccountId, member.registrationId].every(authoringId)
        )
          throw new Error();
      }
      return m;
    } catch {
      throw new DomainError(
        'This examination package could not be verified on this Host. No examination data was changed.',
        409,
      );
    }
  }
  private row(owner: string, id: string) {
    const r = this.store.db
      .prepare('SELECT * FROM local_preparations WHERE id=? AND owner_id=?')
      .get(id, owner);
    if (!r) throw new DomainError('Local preparation not found.', 404);
    return r;
  }
  status(owner: string, sourceId: string): LocalPreparationStatus {
    this.store.assertOwner(sourceId, owner);
    const r = this.store.db
      .prepare(
        'SELECT * FROM local_preparations WHERE owner_id=? AND (source_id=? OR run_id=?) ORDER BY created_at DESC,id DESC LIMIT 1',
      )
      .get(owner, sourceId, sourceId);
    let enabled = false;
    try {
      enabled = Boolean(this.storage && this.auth && this.key && this.provider(owner));
    } catch {
      /* Native examinations keep their existing local access. */
    }
    const isPreparedRun = r?.run_id === sourceId;
    let candidates = r
      ? Number(
          this.store.db
            .prepare('SELECT COUNT(*) n FROM local_admission WHERE preparation_id=?')
            .get(r.id!)!.n,
        )
      : 0;
    if (r?.state === 'pending') {
      try {
        candidates = this.open(String(r.sealed)).members.length;
      } catch {
        /* Invalid retained packages are reported on retry. */
      }
    }
    return {
      enabled: enabled && !isPreparedRun,
      isPreparedRun,
      sourceId,
      sourceVersion: digest(JSON.stringify(this.store.assessment(sourceId))),
      preparation: r
        ? {
            id: String(r.id),
            runId: String(r.run_id),
            state: r.state as 'pending' | 'ready' | 'completed' | 'cancelled',
            candidates,
            started: Boolean(
              this.store.db.prepare('SELECT 1 FROM sittings WHERE assessment_id=?').get(r.run_id!),
            ),
            downloaded: r.downloaded === null ? null : Number(r.downloaded),
            expiresAt: Number(r.expires_at),
            error: r.error === null ? null : String(r.error),
          }
        : null,
    };
  }
  async prepare(
    owner: string,
    sourceId: string,
    raw: Record<string, unknown>,
    revalidate: () => void,
  ) {
    this.store.assertOwner(sourceId, owner);
    if (this.store.db.prepare('SELECT 1 FROM local_preparations WHERE run_id=?').get(sourceId))
      throw new DomainError('Use the original assessment to prepare another local run.', 409);
    if (!this.auth || !this.storage || !this.key)
      throw new DomainError(
        'Connect your cloud workspace to prepare candidate access on this Host.',
        409,
      );
    if (this.authoring.activeExam())
      throw new DomainError('Finish the current local examination before preparing another.', 409);
    if (this.flights.has(owner))
      throw new DomainError('Local preparation is already in progress.', 409);
    const providerOwner = this.provider(owner),
      expiresAt = Number(raw.expiresAt),
      now = this.store.now();
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt < now + 3600000 ||
      expiresAt > now + 30 * 86400000
    )
      throw new DomainError('Choose an access expiry between one hour and 30 days from now.');
    await this.authoring.ensure(owner, true, sourceId);
    revalidate();
    if (this.authoring.activeExam())
      throw new DomainError('A local examination started while preparation was loading.', 409);
    const source = this.authoring.preparedSource(owner, sourceId);
    if (raw.expectedVersion !== digest(JSON.stringify(this.store.assessment(sourceId))))
      throw new DomainError('The paper changed. Refresh before preparing it.', 409);
    const existing = this.store.db
      .prepare(
        "SELECT * FROM local_preparations WHERE source_id=? AND state IN ('pending','ready')",
      )
      .get(sourceId);
    if (existing) {
      if (existing.owner_id !== owner) throw new DomainError('Local preparation not found.', 404);
      await this.retry(owner, String(existing.id), revalidate);
      return this.status(owner, sourceId);
    }
    const db = this.store.db,
      approved = db
        .prepare(
          "SELECT r.account_id,a.name,a.email,c.identifier,b.provider_user_id FROM registrations r JOIN accounts a ON a.id=r.account_id JOIN candidates c ON c.id=r.candidate_id LEFT JOIN candidate_provider_identities b ON b.account_id=a.id WHERE r.assessment_id=? AND r.status='approved' ORDER BY a.id",
        )
        .all(sourceId);
    if (!approved.length)
      throw new DomainError('Approve at least one candidate before preparing local delivery.', 409);
    if (approved.length > 500) throw new DomainError('Use at most 500 candidates.');
    if (approved.some((r) => !r.provider_user_id))
      throw new DomainError(
        'Every admitted candidate must connect their existing account before cloud access can be prepared. No candidates were omitted.',
        409,
      );
    const run = parseAssessment(
        {
          ...source.document.input,
          allowLateAdmission: false,
          accessMode: 'accounts',
          candidates: [],
        },
        randomUUID,
      ).assessment,
      id = randomUUID(),
      hostId = this.hostId();
    if (run.timing?.lastStartAt && expiresAt < run.timing.lastStartAt)
      throw new DomainError('Local access must remain valid through the last start time.');
    const members = approved.map((r) => {
      const accountId = String(r.provider_user_id),
        candidateId = randomUUID();
      return {
        accountId,
        localAccountId: String(r.account_id),
        name: String(r.name),
        email: String(r.email),
        identifier: String(r.identifier),
        candidateId,
        registrationId: randomUUID(),
        pass: {
          version: 1 as const,
          preparationId: id,
          runId: run.id,
          hostId,
          accountId,
          candidateId,
          credential: randomBytes(32).toString('base64url'),
          expiresAt,
          title: run.title,
        },
      };
    });
    const m: Manifest = {
        version: 1,
        id,
        hostId,
        providerOwner,
        sourceId,
        sourceRevision: source.revision,
        sourceDigest: source.digest,
        run,
        expiresAt,
        members,
      },
      sealed = this.seal(m);
    if (Buffer.byteLength(sealed) > 4194304)
      throw new DomainError('This examination package is too large.', 413);
    db.prepare(
      'INSERT INTO local_preparations(id,owner_id,source_id,run_id,state,sealed,digest,source_revision,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    ).run(
      id,
      owner,
      sourceId,
      run.id,
      'pending',
      sealed,
      digest(sealed),
      source.revision,
      now,
      expiresAt,
    );
    this.store.event(null, owner, 'local_preparation_queued', {
      preparationId: id,
      sourceAssessmentId: sourceId,
      runId: run.id,
      candidates: members.length,
    });
    await this.retry(owner, id, revalidate);
    return this.status(owner, sourceId);
  }
  async retry(owner: string, id: string, revalidate: () => void = () => {}) {
    if (this.stopped || this.authoring.activeExam()) return;
    if (this.flights.has(owner)) {
      await this.flights.get(owner);
      return;
    }
    const row = this.row(owner, id);
    if (row.state !== 'pending') return;
    const work = (async () => {
      try {
        if (!this.storage || !this.auth)
          throw new DomainError('Cloud preparation is not configured.', 409);
        const m = this.open(String(row.sealed));
        if (
          digest(String(row.sealed)) !== row.digest ||
          m.providerOwner !== this.provider(owner) ||
          m.id !== id ||
          m.run.id !== row.run_id
        )
          throw new DomainError('Package identity did not match.', 409);
        const session = await this.auth.credentials(owner, m.providerOwner);
        if (this.authoring.activeExam() || this.stopped) return;
        const input: PreparationUpload = {
          id: m.id,
          sourceId: m.sourceId,
          sourceRevision: m.sourceRevision,
          sourceDigest: m.sourceDigest,
          hostId: m.hostId,
          runId: m.run.id,
          expiresAt: m.expiresAt,
          title: m.run.title,
          course: m.run.course,
          sealed: String(row.sealed),
          digest: String(row.digest),
          members: m.members.map(({ localAccountId, ...r }) => r),
        };
        const receipt = await this.storage.prepare(session.accessToken, input);
        revalidate();
        if (receipt?.id !== id || receipt.digest !== row.digest)
          throw new DomainError('Preparation acknowledgement did not match.', 502);
        if (this.authoring.activeExam() || this.stopped) return;
        this.commit(owner, m);
      } catch (e) {
        this.store.db
          .prepare('UPDATE local_preparations SET error=? WHERE id=?')
          .run(
            e instanceof DomainError
              ? e.message
              : 'Local preparation could not complete. Your package is retained for retry.',
            id,
          );
      }
    })();
    this.flights.set(owner, work);
    try {
      await work;
    } finally {
      this.flights.delete(owner);
      this.due.set(id, this.store.now() + 15000);
    }
  }
  private commit(owner: string, m: Manifest) {
    const db = this.store.db;
    transaction(db, () => {
      const row = this.row(owner, m.id);
      if (row.state !== 'pending') return;
      if (db.prepare('SELECT 1 FROM assessments WHERE id=?').get(m.run.id))
        throw new DomainError('A different local run already uses this identity.', 409);
      db.prepare('INSERT INTO assessments VALUES(?,?,?)').run(
        m.run.id,
        JSON.stringify(m.run),
        this.store.now(),
      );
      db.prepare('INSERT INTO assessment_owners VALUES(?,?)').run(m.run.id, owner);
      db.prepare(
        "INSERT INTO registration_settings(assessment_id,mode,policy,link_token,is_open,closes_at,capacity) VALUES(?,'accounts','roster',?,0,NULL,?)",
      ).run(m.run.id, randomBytes(32).toString('base64url'), m.members.length);
      for (const r of m.members) {
        const binding = db
          .prepare('SELECT account_id FROM candidate_provider_identities WHERE provider_user_id=?')
          .get(r.accountId);
        if (
          binding?.account_id !== r.localAccountId ||
          db.prepare('SELECT email FROM accounts WHERE id=?').get(r.localAccountId)?.email !==
            r.email
        )
          throw new DomainError(
            'Candidate identity changed while preparing. No local run was committed.',
            409,
          );
        db.prepare('INSERT INTO candidates VALUES(?,?,?,?,?)').run(
          r.candidateId,
          m.run.id,
          r.identifier,
          r.name,
          'account-managed',
        );
        db.prepare("INSERT INTO registrations VALUES(?,?,?,?,'approved',?,?)").run(
          r.registrationId,
          m.run.id,
          r.localAccountId,
          r.candidateId,
          this.store.now(),
          this.store.now(),
        );
        db.prepare(
          'INSERT INTO local_admission(preparation_id,candidate_id,account_id,pass_hash,expires_at) VALUES(?,?,?,?,?)',
        ).run(m.id, r.candidateId, r.localAccountId, digest(r.pass.credential), m.expiresAt);
      }
      db.prepare("UPDATE local_preparations SET state='ready',error=NULL WHERE id=?").run(m.id);
      this.store.event(null, owner, 'local_run_prepared', {
        sourceAssessmentId: m.sourceId,
        assessmentId: m.run.id,
        preparationId: m.id,
        sourceRevision: m.sourceRevision,
        candidates: m.members.length,
      });
    });
  }
  assertLaunch(owner: string, runId: string) {
    const row = this.store.db
      .prepare('SELECT * FROM local_preparations WHERE run_id=? AND owner_id=?')
      .get(runId, owner);
    if (!row) return;
    if (row.state !== 'ready' || Number(row.expires_at) <= this.store.now())
      throw new DomainError(
        'This local run is not ready or its access has expired. Prepare a new run.',
        409,
      );
    const m = this.open(String(row.sealed));
    if (
      canonicalBank(this.store.assessment(runId)) !== canonicalBank(m.run) ||
      Number(
        this.store.db
          .prepare('SELECT COUNT(*) n FROM local_admission WHERE preparation_id=?')
          .get(row.id!)!.n,
      ) !== m.members.length
    )
      throw new DomainError(
        'The pinned local paper or admission list changed. Do not start this run.',
        409,
      );
    for (const member of m.members) {
      if (
        !this.store.db
          .prepare(
            "SELECT 1 FROM local_admission a JOIN registrations r ON r.candidate_id=a.candidate_id AND r.account_id=a.account_id WHERE a.preparation_id=? AND a.account_id=? AND a.candidate_id=? AND r.id=? AND r.assessment_id=? AND r.status='approved'",
          )
          .get(m.id, member.localAccountId, member.candidateId, member.registrationId, runId)
      )
        throw new DomainError(
          'The pinned candidate admission changed. Do not start this run.',
          409,
        );
    }
  }
  deliveryReady(owner: string, runId: string) {
    try {
      this.assertLaunch(owner, runId);
      return true;
    } catch {
      return false;
    }
  }
  available() {
    return Boolean(
      this.store.db
        .prepare(
          "SELECT 1 FROM local_preparations p WHERE p.state IN ('ready','completed') AND (p.expires_at>? OR EXISTS(SELECT 1 FROM sittings s JOIN attempts a ON a.sitting_id=s.id LEFT JOIN exam_controls c ON c.sitting_id=s.id WHERE s.assessment_id=p.run_id AND a.status='active' AND (a.deadline>? OR c.paused_at IS NOT NULL))) LIMIT 1",
        )
        .get(this.store.now(), this.store.now()),
    );
  }
  scope(rawSession: string) {
    const row = this.store.db
      .prepare(
        "SELECT p.run_id FROM offline_candidate_sessions s JOIN local_preparations p ON p.id=s.preparation_id WHERE s.token_hash=? AND p.state IN ('ready','completed')",
      )
      .get(digest(rawSession));
    return row ? String(row.run_id) : null;
  }
  login(raw: unknown) {
    const pass = parseLocalPass(raw),
      db = this.store.db,
      row = db
        .prepare(
          'SELECT a.*,p.run_id,p.state,b.provider_user_id FROM local_admission a JOIN local_preparations p ON p.id=a.preparation_id JOIN candidate_provider_identities b ON b.account_id=a.account_id WHERE a.preparation_id=? AND a.candidate_id=?',
        )
        .get(pass.preparationId, pass.candidateId);
    const expected = String(row?.pass_hash ?? '0'.repeat(64)),
      actual = digest(pass.credential);
    if (
      !timingSafeEqual(Buffer.from(expected), Buffer.from(actual)) ||
      !row ||
      pass.hostId !== this.hostId() ||
      pass.runId !== row.run_id ||
      pass.accountId !== row.provider_user_id ||
      pass.expiresAt !== row.expires_at ||
      !['ready', 'completed'].includes(String(row.state))
    )
      throw new DomainError(
        'This access file is not valid on this Host. Ask the invigilator for help.',
        401,
      );
    const sitting = db.prepare('SELECT id FROM sittings WHERE assessment_id=?').get(pass.runId),
      attempt = sitting && this.store.findAttempt(String(sitting.id), pass.candidateId);
    const paused =
      sitting &&
      db
        .prepare('SELECT 1 FROM exam_controls WHERE sitting_id=? AND paused_at IS NOT NULL')
        .get(sitting.id!);
    if (
      Number(row.expires_at) <= this.store.now() &&
      !(attempt?.status === 'active' && (attempt.deadline > this.store.now() || paused))
    )
      throw new DomainError(
        'This examination access has expired. Ask the invigilator for help.',
        401,
      );
    return transaction(db, () => {
      const s = this.store.createSession(
        'candidate',
        String(row.account_id),
        null,
        String(row.account_id),
      );
      db.prepare('INSERT INTO offline_candidate_sessions VALUES(?,?)').run(
        digest(s.raw),
        pass.preparationId,
      );
      this.store.event(
        sitting ? String(sitting.id) : null,
        pass.candidateId,
        'local_pass_signed_in',
        { preparationId: pass.preparationId, previousDeviceRevoked: true },
      );
      return { ...s, runId: pass.runId };
    });
  }
  replace(owner: string, id: string, accountId: string, reason: unknown, operationId: unknown) {
    const row = this.row(owner, id),
      why = text(reason, 'Reason', 500);
    if (!authoringId(operationId)) throw new DomainError('Invalid recovery request.');
    if (!['ready', 'completed'].includes(String(row.state)))
      throw new DomainError('This local run is not available for recovery.', 409);
    const previous = this.store.db
      .prepare(
        "SELECT detail FROM events WHERE actor_id=? AND kind='local_pass_replaced' AND json_extract(detail,'$.operationId')=?",
      )
      .get(owner, operationId);
    if (previous) {
      const d = JSON.parse(String(previous.detail));
      if (d.preparationId !== id || d.accountId !== accountId || d.reason !== why)
        throw new DomainError('This recovery request was already used for another action.', 409);
      return this.open(String(d.sealed)).members.find((r) => r.localAccountId === accountId)!.pass;
    }
    const m = this.open(String(row.sealed)),
      member = m.members.find((r) => r.localAccountId === accountId);
    if (!member) throw new DomainError('Candidate not found.', 404);
    member.pass = { ...member.pass, credential: randomBytes(32).toString('base64url') };
    return transaction(this.store.db, () => {
      this.store.db
        .prepare(
          'UPDATE local_admission SET pass_hash=?,revision=revision+1 WHERE preparation_id=? AND account_id=?',
        )
        .run(digest(member.pass.credential), id, accountId);
      this.store.db.prepare('DELETE FROM sessions WHERE account_id=?').run(accountId);
      this.store.event(null, owner, 'local_pass_replaced', {
        preparationId: id,
        accountId,
        operationId,
        reason: why,
        sealed: this.seal(m),
      });
      return member.pass;
    });
  }
  members(owner: string, id: string) {
    this.row(owner, id);
    return this.store.db
      .prepare(
        'SELECT a.account_id accountId,c.name,c.identifier FROM local_admission a JOIN candidates c ON c.id=a.candidate_id WHERE a.preparation_id=? ORDER BY c.name',
      )
      .all(id);
  }
  cancel(owner: string, id: string, reason: unknown) {
    const row = this.row(owner, id),
      why = text(reason, 'Reason', 500);
    if (this.store.db.prepare('SELECT 1 FROM sittings WHERE assessment_id=?').get(row.run_id!))
      throw new DomainError(
        'This run has started. End the examination instead of cancelling preparation.',
        409,
      );
    transaction(this.store.db, () => {
      this.store.db
        .prepare("UPDATE local_preparations SET state='cancelled',error=NULL WHERE id=?")
        .run(id);
      this.store.db
        .prepare(
          'DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM offline_candidate_sessions WHERE preparation_id=?)',
        )
        .run(id);
      this.store.event(null, owner, 'local_preparation_cancelled', {
        preparationId: id,
        reason: why,
      });
    });
    this.due.set(id, 0);
  }
  async candidatePasses(account: string, revalidate: () => void) {
    if (!this.auth || !this.storage || this.authoring.activeExam()) return [];
    const s = await this.auth.candidateCredentials(account),
      rows = await this.storage.passes(s.accessToken);
    revalidate();
    if (
      !Array.isArray(rows) ||
      rows.length > 1000 ||
      rows.some(
        (r) =>
          !authoringId(r.preparationId) ||
          !authoringId(r.runId) ||
          typeof r.title !== 'string' ||
          r.title.length > 180 ||
          !Number.isSafeInteger(r.expiresAt),
      )
    )
      throw new DomainError('Invalid local examination directory.', 502);
    return rows;
  }
  async candidatePass(account: string, id: string, revalidate: () => void) {
    if (!this.auth || !this.storage || this.authoring.activeExam())
      throw new DomainError('Download access before joining the offline examination network.', 409);
    const s = await this.auth.candidateCredentials(account),
      pass = parseLocalPass(await this.storage.pass(s.accessToken, id));
    revalidate();
    if (pass.accountId !== s.userId || pass.preparationId !== id)
      throw new DomainError('This access file belongs to another identity.', 403);
    return pass;
  }
  async pump() {
    if (this.stopped || this.authoring.activeExam() || !this.storage || !this.auth) return;
    for (const r of this.store.db
      .prepare('SELECT * FROM local_preparations WHERE cloud_closed=0 ORDER BY created_at')
      .all()) {
      const owner = String(r.owner_id);
      if (this.flights.has(owner) || (this.due.get(String(r.id)) ?? 0) > this.store.now()) continue;
      if (r.state === 'pending') {
        await this.retry(owner, String(r.id));
        continue;
      }
      const work = (async () => {
        try {
          if (r.state === 'ready') {
            const sitting = this.store.db
              .prepare('SELECT id,deadline FROM sittings WHERE assessment_id=?')
              .get(r.run_id!);
            if (sitting && Number(sitting.deadline) <= this.store.now())
              this.store.db
                .prepare("UPDATE local_preparations SET state='completed' WHERE id=?")
                .run(r.id!);
          }
          const current = this.row(owner, String(r.id)),
            s = await this.auth!.credentials(owner, this.provider(owner));
          if (this.stopped || this.authoring.activeExam()) return;
          if (['completed', 'cancelled'].includes(String(current.state))) {
            await this.storage!.close(
              s.accessToken,
              String(r.id),
              current.state as 'completed' | 'cancelled',
            );
            this.store.db
              .prepare('UPDATE local_preparations SET cloud_closed=1,error=NULL WHERE id=?')
              .run(r.id!);
          } else if (current.state === 'ready') {
            const status = await this.storage!.status(s.accessToken, String(r.id));
            if (
              !Number.isSafeInteger(status.downloaded) ||
              status.downloaded < 0 ||
              status.downloaded > 500
            )
              throw new Error();
            this.store.db
              .prepare('UPDATE local_preparations SET downloaded=?,error=NULL WHERE id=?')
              .run(status.downloaded, r.id!);
          }
        } catch {
          /* Cloud progress is optional after preparation. Offline state is unchanged. */
        }
      })();
      this.flights.set(owner, work);
      try {
        await work;
      } finally {
        this.flights.delete(owner);
        this.due.set(String(r.id), this.store.now() + 15000);
      }
    }
  }
  async stop() {
    this.stopped = true;
    await Promise.allSettled([...this.flights.values()]);
  }
}
