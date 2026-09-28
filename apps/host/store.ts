import { randomInt, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createOrder, grade, text, validateAnswer } from '../../packages/exam-core/engine.ts';
import { DomainError } from '../../packages/exam-core/model.ts';
import type {
  Assessment,
  Attempt,
  CandidateView,
  ResponseValue,
} from '../../packages/exam-core/model.ts';
import { transaction } from './database.ts';
import { digest, token } from './security.ts';

type SittingRow = {
  id: string;
  assessment_id: string;
  code: string;
  snapshot: string;
  started_at: number;
  deadline: number;
};
type AttemptRow = {
  id: string;
  sitting_id: string;
  candidate_id: string;
  status: Attempt['status'];
  started_at: number;
  deadline: number;
  submitted_at: number | null;
  question_order: string;
};
export interface Session {
  role: 'admin' | 'candidate';
  principal_id: string;
  sitting_id: string | null;
  csrf: string;
  expires_at: number;
  account_id: string | null;
}

export class ExamStore {
  db: DatabaseSync;
  now: () => number;
  constructor(db: DatabaseSync, now = Date.now) {
    this.db = db;
    this.now = now;
  }
  event(
    sittingId: string | null,
    actor: string,
    kind: string,
    detail: Record<string, unknown> = {},
  ) {
    this.db
      .prepare('INSERT INTO events(sitting_id,actor_id,kind,detail,created_at) VALUES(?,?,?,?,?)')
      .run(sittingId, actor, kind, JSON.stringify(detail), this.now());
  }
  createSession(
    role: Session['role'],
    principalId: string,
    sittingId: string | null,
    accountId: string | null = null,
  ) {
    const raw = token();
    const csrf = token();
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(this.now());
    if (accountId) this.db.prepare('DELETE FROM sessions WHERE account_id=?').run(accountId);
    else if (role === 'candidate')
      this.db
        .prepare("DELETE FROM sessions WHERE role='candidate' AND principal_id=? AND sitting_id=?")
        .run(principalId, sittingId);
    this.db
      .prepare(
        'INSERT INTO sessions(token_hash,role,principal_id,sitting_id,csrf,expires_at,account_id) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        digest(raw),
        role,
        principalId,
        sittingId,
        csrf,
        this.now() + 12 * 60 * 60 * 1000,
        accountId,
      );
    return { raw, csrf };
  }
  session(raw: string): Session | undefined {
    return this.db
      .prepare(
        'SELECT role,principal_id,sitting_id,csrf,expires_at,account_id FROM sessions WHERE token_hash=? AND expires_at>?',
      )
      .get(digest(raw), this.now()) as unknown as Session | undefined;
  }
  assessment(id: string): Assessment {
    const row = this.db.prepare('SELECT definition FROM assessments WHERE id=?').get(id);
    if (!row) throw new DomainError('Assessment not found.', 404);
    return JSON.parse(String(row.definition));
  }
  sitting(id: string): SittingRow {
    const row = this.db.prepare('SELECT * FROM sittings WHERE id=?').get(id) as unknown as
      SittingRow | undefined;
    if (!row) throw new DomainError('Sitting not found.', 404);
    return row;
  }
  createAssessment(
    assessment: Assessment,
    candidates: Array<{ id: string; identifier: string; name: string; hash: string }>,
    adminId: string,
    registration: {
      mode: 'legacy' | 'accounts';
      policy: 'approval' | 'roster';
      closesAt: number | null;
      capacity: number;
    } = { mode: 'legacy', policy: 'approval', closesAt: null, capacity: 500 },
    requestId?: string,
    roster?: { id: string; name: string; revision: number },
  ) {
    transaction(this.db, () => {
      this.db
        .prepare('INSERT INTO assessments VALUES(?,?,?)')
        .run(assessment.id, JSON.stringify(assessment), this.now());
      if (requestId)
        this.db
          .prepare('INSERT INTO assessment_creations VALUES(?,?,?)')
          .run(adminId, requestId, assessment.id);
      const insert = this.db.prepare('INSERT INTO candidates VALUES(?,?,?,?,?)');
      for (const candidate of candidates)
        insert.run(
          candidate.id,
          assessment.id,
          candidate.identifier,
          candidate.name,
          candidate.hash,
        );
      this.db
        .prepare(
          `INSERT INTO registration_settings(assessment_id,mode,policy,link_token,is_open,closes_at,capacity)
        VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          assessment.id,
          registration.mode,
          registration.policy,
          token(),
          registration.mode === 'accounts' ? 1 : 0,
          registration.closesAt,
          registration.capacity,
        );
      if (registration.mode === 'accounts') {
        // Only an already verified institutional identity can be matched automatically.
        for (const candidate of candidates) {
          const member = this.db
            .prepare(
              "SELECT account_id FROM memberships WHERE organization_id='default' AND identifier=? AND status='verified'",
            )
            .get(candidate.identifier);
          if (member)
            this.db
              .prepare('INSERT INTO registrations VALUES(?,?,?,?,?,?,?)')
              .run(
                randomUUID(),
                assessment.id,
                member.account_id!,
                candidate.id,
                'approved',
                this.now(),
                this.now(),
              );
        }
      }
      if (roster) {
        this.db
          .prepare('INSERT INTO assessment_rosters VALUES(?,?,?,?)')
          .run(assessment.id, roster.id, roster.name, roster.revision);
        this.db
          .prepare('UPDATE registration_settings SET is_open=0 WHERE assessment_id=?')
          .run(assessment.id);
      }
      this.event(null, adminId, 'assessment_created', {
        assessmentId: assessment.id,
        candidateCount: candidates.length,
      });
    });
  }
  launch(assessmentId: string, adminId: string) {
    return transaction(this.db, () => {
      const existing = this.db
        .prepare('SELECT * FROM sittings WHERE assessment_id=?')
        .get(assessmentId) as unknown as SittingRow | undefined;
      if (existing) return { id: existing.id, code: existing.code };
      if (this.db.prepare('SELECT id FROM sittings WHERE deadline>?').get(this.now()))
        throw new DomainError('Finish the current sitting before starting another.', 409);
      const assessment = this.assessment(assessmentId);
      const settings = this.db
        .prepare('SELECT mode FROM registration_settings WHERE assessment_id=?')
        .get(assessmentId);
      if (
        settings?.mode === 'accounts' &&
        !this.db
          .prepare("SELECT id FROM registrations WHERE assessment_id=? AND status='approved'")
          .get(assessmentId)
      ) {
        throw new DomainError(
          'Approve at least one candidate before starting the examination.',
          409,
        );
      }
      const id = randomUUID();
      const code = token().slice(0, 10).toUpperCase();
      const started = this.now();
      this.db
        .prepare('INSERT INTO sittings VALUES(?,?,?,?,?,?)')
        .run(
          id,
          assessmentId,
          code,
          JSON.stringify(assessment),
          started,
          started + assessment.durationMinutes * 60000,
        );
      this.event(id, adminId, 'sitting_started');
      this.db
        .prepare('UPDATE registration_settings SET is_open=0 WHERE assessment_id=?')
        .run(assessmentId);
      return { id, code };
    });
  }
  responses(attemptId: string): Record<string, ResponseValue> {
    const rows = this.db
      .prepare('SELECT question_id,value,revision FROM responses WHERE attempt_id=?')
      .all(attemptId);
    return Object.fromEntries(
      rows.map((row) => [
        String(row.question_id),
        { value: JSON.parse(String(row.value)), revision: Number(row.revision) },
      ]),
    );
  }
  end(assessmentId: string, adminId: string) {
    this.reconcile();
    return transaction(this.db, () => {
      const sitting = this.db
        .prepare('SELECT * FROM sittings WHERE assessment_id=?')
        .get(assessmentId) as unknown as SittingRow | undefined;
      if (!sitting) throw new DomainError('This examination has not started.', 409);
      if (sitting.deadline <= this.now()) return { ok: true };
      const now = this.now();
      const attempts = this.db
        .prepare("SELECT id,candidate_id FROM attempts WHERE sitting_id=? AND status='active'")
        .all(sitting.id);
      for (const attempt of attempts) {
        this.db
          .prepare("UPDATE attempts SET status='submitted',submitted_at=? WHERE id=?")
          .run(now, attempt.id!);
        this.event(sitting.id, adminId, 'attempt_force_submitted', {
          attemptId: attempt.id,
          candidateId: attempt.candidate_id,
          reason: 'Sitting ended by administrator',
        });
      }
      this.db.prepare('UPDATE sittings SET deadline=? WHERE id=?').run(now, sitting.id);
      this.event(sitting.id, adminId, 'sitting_ended');
      return { ok: true };
    });
  }
  reconcile() {
    transaction(this.db, () => {
      const rows = this.db
        .prepare(
          "SELECT id,sitting_id,candidate_id,deadline FROM attempts WHERE status='active' AND deadline<=?",
        )
        .all(this.now());
      for (const row of rows) {
        this.db
          .prepare("UPDATE attempts SET status='expired',submitted_at=deadline WHERE id=?")
          .run(row.id!);
        this.event(String(row.sitting_id), String(row.candidate_id), 'attempt_expired', {
          attemptId: row.id,
        });
      }
    });
  }
  findAttempt(sittingId: string, candidateId: string): Attempt | null {
    const row = this.db
      .prepare('SELECT * FROM attempts WHERE sitting_id=? AND candidate_id=?')
      .get(sittingId, candidateId) as unknown as AttemptRow | undefined;
    return row
      ? {
          id: row.id,
          sittingId: row.sitting_id,
          candidateId: row.candidate_id,
          status: row.status,
          startedAt: row.started_at,
          deadline: row.deadline,
          submittedAt: row.submitted_at,
          order: JSON.parse(row.question_order),
        }
      : null;
  }
  start(sittingId: string, candidateId: string) {
    this.reconcile();
    return transaction(this.db, () => {
      const sitting = this.sitting(sittingId);
      if (
        !this.db
          .prepare('SELECT id FROM candidates WHERE id=? AND assessment_id=?')
          .get(candidateId, sitting.assessment_id)
      )
        throw new DomainError('Candidate not eligible.', 403);
      const existing = this.findAttempt(sittingId, candidateId);
      if (existing) return existing;
      if (this.now() >= sitting.deadline)
        throw new DomainError('This examination has ended.', 409, 'EXAM_ENDED');
      const id = randomUUID();
      this.db
        .prepare('INSERT INTO attempts VALUES(?,?,?,?,?,?,?,?)')
        .run(
          id,
          sittingId,
          candidateId,
          'active',
          this.now(),
          sitting.deadline,
          null,
          JSON.stringify(createOrder(JSON.parse(sitting.snapshot), randomInt)),
        );
      this.event(sittingId, candidateId, 'attempt_started', { attemptId: id });
      return this.findAttempt(sittingId, candidateId)!;
    });
  }
  save(
    sittingId: string,
    candidateId: string,
    questionId: string,
    input: { value: unknown; expectedRevision: unknown; operationId: unknown },
  ) {
    this.reconcile();
    return transaction(this.db, () => {
      const attempt = this.findAttempt(sittingId, candidateId);
      if (!attempt) throw new DomainError('Start the examination first.', 409);
      const operationId = text(input.operationId, 'Operation ID', 100, 8);
      const expectedRevision = input.expectedRevision;
      if (
        typeof expectedRevision !== 'number' ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0
      )
        throw new DomainError('Invalid answer revision.');
      const assessment: Assessment = JSON.parse(this.sitting(sittingId).snapshot);
      const question = assessment.questions.find((q) => q.id === questionId);
      if (!question) throw new DomainError('Question not found.', 404);
      const value = validateAnswer(question, input.value);
      const fingerprint = digest(JSON.stringify({ questionId, value, expectedRevision }));
      const prior = this.db
        .prepare('SELECT * FROM operations WHERE attempt_id=? AND operation_id=?')
        .get(attempt.id, operationId);
      if (prior) {
        if (prior.request_fingerprint !== fingerprint)
          throw new DomainError(
            'This operation ID was already used for a different answer.',
            409,
            'OPERATION_CONFLICT',
          );
        return JSON.parse(String(prior.receipt)) as { revision: number; savedAt: number };
      }
      const acceptedAt = this.now();
      if (attempt.status !== 'active' || acceptedAt >= attempt.deadline)
        throw new DomainError(
          'This attempt is closed. Answers cannot be changed.',
          409,
          'ATTEMPT_CLOSED',
        );
      const current = this.db
        .prepare('SELECT revision FROM responses WHERE attempt_id=? AND question_id=?')
        .get(attempt.id, questionId);
      if (Number(current?.revision ?? 0) !== expectedRevision)
        throw new DomainError(
          'A newer answer is already saved. Reload the examination to restore it.',
          409,
          'REVISION_CONFLICT',
        );
      const receipt = { revision: expectedRevision + 1, savedAt: acceptedAt };
      this.db
        .prepare(
          `INSERT INTO responses VALUES(?,?,?,?,?) ON CONFLICT(attempt_id,question_id)
        DO UPDATE SET value=excluded.value,revision=excluded.revision,saved_at=excluded.saved_at`,
        )
        .run(attempt.id, questionId, JSON.stringify(value), receipt.revision, receipt.savedAt);
      this.db
        .prepare('INSERT INTO operations VALUES(?,?,?,?)')
        .run(attempt.id, operationId, fingerprint, JSON.stringify(receipt));
      this.event(sittingId, candidateId, 'answer_saved', {
        attemptId: attempt.id,
        questionId,
        revision: receipt.revision,
      });
      return receipt;
    });
  }
  submit(sittingId: string, candidateId: string) {
    this.reconcile();
    return transaction(this.db, () => {
      const attempt = this.findAttempt(sittingId, candidateId);
      if (!attempt) throw new DomainError('No examination attempt exists.', 409);
      if (attempt.status === 'active') {
        this.db
          .prepare("UPDATE attempts SET status='submitted',submitted_at=? WHERE id=?")
          .run(this.now(), attempt.id);
        this.event(sittingId, candidateId, 'attempt_submitted', { attemptId: attempt.id });
      }
      return this.findAttempt(sittingId, candidateId)!;
    });
  }
  candidateView(sittingId: string, candidateId: string): CandidateView {
    this.reconcile();
    const sitting = this.sitting(sittingId);
    const assessment: Assessment = JSON.parse(sitting.snapshot);
    const candidate = this.db
      .prepare('SELECT name,identifier FROM candidates WHERE id=? AND assessment_id=?')
      .get(candidateId, sitting.assessment_id);
    if (!candidate) throw new DomainError('Candidate not found.', 404);
    const attempt = this.findAttempt(sittingId, candidateId);
    return {
      serverNow: this.now(),
      candidate: { name: String(candidate.name), identifier: String(candidate.identifier) },
      sitting: {
        id: sittingId,
        title: assessment.title,
        course: assessment.course,
        instructions: assessment.instructions,
        deadline: sitting.deadline,
        questionCount: assessment.questions.length,
        durationMinutes: assessment.durationMinutes,
      },
      attempt: attempt
        ? {
            id: attempt.id,
            sittingId,
            status: attempt.status,
            startedAt: attempt.startedAt,
            deadline: attempt.deadline,
            submittedAt: attempt.submittedAt,
            responses: this.responses(attempt.id),
            questions:
              attempt.status === 'active'
                ? attempt.order.map((entry) => {
                    const q = assessment.questions.find(
                      (question) => question.id === entry.questionId,
                    )!;
                    return {
                      id: q.id,
                      prompt: q.prompt,
                      type: q.type,
                      marks: q.marks,
                      options: entry.optionIds.map((id) =>
                        q.options.find((option) => option.id === id)!,
                      ),
                    };
                  })
                : [],
          }
        : null,
    };
  }
  listAssessments() {
    this.reconcile();
    return this.db
      .prepare('SELECT * FROM assessments ORDER BY created_at DESC')
      .all()
      .map((row) => {
        const assessment: Assessment = JSON.parse(String(row.definition));
        const sitting = this.db
          .prepare('SELECT * FROM sittings WHERE assessment_id=?')
          .get(assessment.id) as unknown as SittingRow | undefined;
        const candidates = Number(
          this.db
            .prepare('SELECT COUNT(*) AS count FROM candidates WHERE assessment_id=?')
            .get(assessment.id)?.count,
        );
        const accessMode = this.db
          .prepare('SELECT mode FROM registration_settings WHERE assessment_id=?')
          .get(assessment.id)?.mode as 'accounts' | 'legacy';
        const approved =
          accessMode === 'accounts'
            ? Number(
                this.db
                  .prepare(
                    "SELECT COUNT(*) AS total FROM registrations WHERE assessment_id=? AND status='approved'",
                  )
                  .get(assessment.id)?.total,
              )
            : candidates;
        return {
          id: assessment.id,
          title: assessment.title,
          course: assessment.course,
          durationMinutes: assessment.durationMinutes,
          questionCount: assessment.questions.length,
          candidateCount: approved,
          accessMode,
          createdAt: row.created_at,
          status: !sitting ? 'draft' : sitting.deadline > this.now() ? 'active' : 'completed',
          sitting: sitting
            ? {
                id: sitting.id,
                code: sitting.code,
                deadline: sitting.deadline,
                startedAt: sitting.started_at,
              }
            : null,
        };
      });
  }
  manualScores(attemptId: string): Record<string, number> {
    return Object.fromEntries(
      this.db
        .prepare('SELECT question_id,score FROM manual_marks WHERE attempt_id=?')
        .all(attemptId)
        .map((r) => [String(r.question_id), Number(r.score)]),
    );
  }
  review(assessmentId: string, candidateId: string) {
    this.reconcile();
    const sitting = this.db
      .prepare('SELECT id FROM sittings WHERE assessment_id=?')
      .get(assessmentId);
    const candidate = this.db
      .prepare('SELECT name,identifier FROM candidates WHERE id=? AND assessment_id=?')
      .get(candidateId, assessmentId);
    if (!sitting || !candidate) throw new DomainError('Submission not found.', 404);
    const attempt = this.findAttempt(String(sitting.id), candidateId);
    if (!attempt || attempt.status === 'active')
      throw new DomainError('Only completed submissions can be reviewed.', 409);
    const assessment: Assessment = JSON.parse(this.sitting(String(sitting.id)).snapshot);
    const responses = this.responses(attempt.id);
    const marks = this.db
      .prepare('SELECT question_id,score,revision FROM manual_marks WHERE attempt_id=?')
      .all(attempt.id);
    return {
      candidate: { name: String(candidate.name), identifier: String(candidate.identifier) },
      questions: assessment.questions
        .filter((q) => q.type === 'short')
        .map((q) => {
          const mark = marks.find((m) => m.question_id === q.id);
          return {
            id: q.id,
            prompt: q.prompt,
            maximum: q.marks,
            answer: String(responses[q.id]?.value ?? ''),
            score: mark ? Number(mark.score) : null,
            revision: mark ? Number(mark.revision) : 0,
          };
        }),
      attempt,
    };
  }
  mark(assessmentId: string, candidateId: string, input: Record<string, unknown>, adminId: string) {
    const review = this.review(assessmentId, candidateId);
    return transaction(this.db, () => {
      const question = review.questions.find((q) => q.id === input.questionId);
      if (!question) throw new DomainError('Essay question not found.', 404);
      if (
        typeof input.score !== 'number' ||
        !Number.isFinite(input.score) ||
        input.score < 0 ||
        input.score > question.maximum
      )
        throw new DomainError(`Enter a score between 0 and ${question.maximum}.`);
      if (input.expectedRevision !== question.revision)
        throw new DomainError(
          'This mark changed in another window. Reopen the review before saving.',
          409,
        );
      this.db
        .prepare(
          `INSERT INTO manual_marks VALUES(?,?,?,?,?,?) ON CONFLICT(attempt_id,question_id) DO UPDATE SET score=excluded.score,revision=excluded.revision,reviewer_id=excluded.reviewer_id,reviewed_at=excluded.reviewed_at`,
        )
        .run(
          review.attempt.id,
          question.id,
          input.score,
          question.revision + 1,
          adminId,
          this.now(),
        );
      this.event(review.attempt.sittingId, adminId, 'manual_grade_saved', {
        candidateId,
        questionId: question.id,
        previous: question.score,
        score: input.score,
      });
      return { saved: true };
    });
  }
  detail(assessmentId: string) {
    this.reconcile();
    const summary = this.listAssessments().find((item) => item.id === assessmentId)!;
    if (!summary) throw new DomainError('Assessment not found.', 404);
    const assessment: Assessment = summary.sitting
      ? JSON.parse(this.sitting(summary.sitting.id).snapshot)
      : this.assessment(assessmentId);
    const candidates = this.db
      .prepare(
        'SELECT id,name,identifier FROM candidates WHERE assessment_id=? ORDER BY identifier',
      )
      .all(assessmentId)
      .filter(
        (candidate) =>
          summary.accessMode === 'legacy' ||
          Boolean(
            this.db
              .prepare("SELECT id FROM registrations WHERE candidate_id=? AND status='approved'")
              .get(candidate.id!),
          ),
      )
      .map((candidate) => {
        const attempt = summary.sitting
          ? this.findAttempt(summary.sitting.id, String(candidate.id))
          : null;
        const responses = attempt ? this.responses(attempt.id) : {};
        return {
          id: String(candidate.id),
          name: String(candidate.name),
          identifier: String(candidate.identifier),
          status: attempt?.status ?? 'waiting',
          answered: Object.values(responses).filter((r) =>
            typeof r.value === 'string' ? r.value.trim().length : r.value.length,
          ).length,
          submittedAt: attempt?.submittedAt ?? null,
          grade:
            attempt && attempt.status !== 'active'
              ? grade(assessment, responses, this.manualScores(attempt.id))
              : null,
        };
      });
    const events = summary.sitting
      ? this.db
          .prepare(
            'SELECT id,kind,created_at AS createdAt FROM events WHERE sitting_id=? ORDER BY id DESC LIMIT 12',
          )
          .all(summary.sitting.id)
      : [];
    const roster =
      this.db
        .prepare(
          'SELECT roster_id AS id,name,revision FROM assessment_rosters WHERE assessment_id=?',
        )
        .get(assessmentId) ?? null;
    const rerun = this.db
      .prepare(
        "SELECT json_extract(detail,'$.sourceId') AS id FROM events WHERE kind='assessment_rerun_prepared' AND json_extract(detail,'$.assessmentId')=? LIMIT 1",
      )
      .get(assessmentId);
    const source = rerun
      ? { id: String(rerun.id), title: this.assessment(String(rerun.id)).title }
      : null;
    return { assessment, summary, candidates, events, roster, source, serverNow: this.now() };
  }
}
