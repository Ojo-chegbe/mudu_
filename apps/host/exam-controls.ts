import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ExamStore } from './store.ts';
import type { Assessment } from '../../packages/exam-core/model.ts';
import { DomainError } from '../../packages/exam-core/model.ts';
import { text } from '../../packages/exam-core/engine.ts';
import { transaction } from './database.ts';
import { digest } from './security.ts';
import { admissionWindow } from '../../packages/exam-core/timing.ts';
import { syncRosterAssessment } from './roster-admission.ts';

interface ExecutionSitting {
  id: string;
  snapshot: string;
  started_at: number;
  deadline: number;
}
export function execution(db: DatabaseSync, sitting: ExecutionSitting, now: number) {
  const row = db.prepare('SELECT * FROM exam_controls WHERE sitting_id=?').get(sitting.id);
  const pausedAt = row?.paused_at == null ? null : Number(row.paused_at);
  const shift = Number(row?.pause_total_ms ?? 0);
  const extra = Number(row?.extra_ms ?? 0);
  const assessment: Assessment = JSON.parse(sitting.snapshot);
  assessment.durationMinutes += extra / 60000;
  if (assessment.timing?.mode === 'individual')
    assessment.timing = {
      ...assessment.timing,
      opensAt: assessment.timing.opensAt! + shift,
      lastStartAt: assessment.timing.lastStartAt! + shift,
      finishBy:
        assessment.timing.finishBy === null ? null : assessment.timing.finishBy! + shift + extra,
    };
  return {
    assessment,
    pausedAt,
    revision: Number(row?.revision ?? 0),
    now: pausedAt ?? now,
    admissionDeadline:
      row?.shared_deadline == null
        ? sitting.deadline
        : Math.min(sitting.deadline, Number(row.shared_deadline)),
  };
}

export class ExamControls {
  store: ExamStore;
  constructor(store: ExamStore) {
    this.store = store;
  }
  perform(assessmentId: string, actor: string, input: Record<string, unknown>) {
    this.store.assertOwner(assessmentId, actor);
    this.store.reconcile();
    return transaction(this.store.db, () => {
      const { db } = this.store;
      const row = db.prepare('SELECT id FROM sittings WHERE assessment_id=?').get(assessmentId);
      if (!row) throw new DomainError('Open the examination first.', 409);
      const sitting = this.store.sitting(String(row.id));
      const current = execution(db, sitting, this.store.now());
      const operationId = text(input.operationId, 'Operation ID', 100, 8);
      const fingerprint = digest(JSON.stringify(input));
      const prior = db
        .prepare('SELECT * FROM exam_control_receipts WHERE sitting_id=? AND operation_id=?')
        .get(sitting.id, operationId);
      if (prior) {
        if (prior.actor_id !== actor || prior.fingerprint !== fingerprint)
          throw new DomainError(
            'This action identifier was already used for different changes.',
            409,
          );
        return JSON.parse(String(prior.receipt));
      }
      if (input.expectedRevision !== current.revision)
        throw new DomainError(
          'Examination controls changed. Refresh monitoring and review your action again.',
          409,
        );
      if (sitting.deadline <= current.now)
        throw new DomainError('This examination is closed.', 409);
      const reason = input.action === 'announce' ? '' : text(input.reason, 'Reason', 500, 3);
      db.prepare('INSERT OR IGNORE INTO exam_controls(sitting_id,shared_deadline) VALUES(?,?)').run(
        sitting.id,
        sitting.deadline,
      );
      const now = this.store.now();
      let detail: Record<string, unknown> = { reason };
      switch (input.action) {
        case 'announce': {
          const message = text(input.message, 'Message', 1000, 1);
          if (
            Number(
              db
                .prepare('SELECT COUNT(*) n FROM exam_announcements WHERE sitting_id=?')
                .get(sitting.id)?.n,
            ) >= 500
          )
            throw new DomainError('This examination has reached its announcement limit.');
          const id = randomUUID();
          db.prepare('INSERT INTO exam_announcements VALUES(?,?,?,?,?)').run(
            id,
            sitting.id,
            message,
            actor,
            now,
          );
          detail = { announcementId: id, message };
          break;
        }
        case 'pause': {
          if (current.pausedAt !== null)
            throw new DomainError('The examination is already paused.', 409);
          const window = admissionWindow(
            current.assessment,
            sitting.started_at,
            current.admissionDeadline,
            now,
          );
          if (window.startRestriction === 'not_open')
            throw new DomainError('The examination has not opened yet.', 409);
          db.prepare('UPDATE exam_controls SET paused_at=? WHERE sitting_id=?').run(
            now,
            sitting.id,
          );
          break;
        }
        case 'resume': {
          if (current.pausedAt === null)
            throw new DomainError('The examination is not paused.', 409);
          const elapsed = Math.max(0, now - current.pausedAt);
          db.prepare(
            "UPDATE attempts SET deadline=deadline+? WHERE sitting_id=? AND status='active'",
          ).run(elapsed, sitting.id);
          db.prepare('UPDATE sittings SET deadline=deadline+? WHERE id=?').run(elapsed, sitting.id);
          db.prepare(
            'UPDATE exam_controls SET paused_at=NULL,pause_total_ms=pause_total_ms+?,shared_deadline=shared_deadline+? WHERE sitting_id=?',
          ).run(elapsed, elapsed, sitting.id);
          syncRosterAssessment(this.store, assessmentId, actor);
          detail.pausedMilliseconds = elapsed;
          break;
        }
        case 'extend': {
          if (
            typeof input.minutes !== 'number' ||
            !Number.isInteger(input.minutes) ||
            input.minutes < 1 ||
            input.minutes > 240
          )
            throw new DomainError('Choose between 1 and 240 extra minutes.');
          const amount = input.minutes * 60000;
          if (input.candidateId !== undefined && input.candidateId !== null) {
            const candidateId = text(input.candidateId, 'Candidate', 100, 1);
            const attempt = this.store.findAttempt(sitting.id, candidateId);
            if (!attempt || attempt.status !== 'active')
              throw new DomainError(
                'Only a candidate with an ongoing attempt can receive extra time.',
                409,
              );
            if (
              current.assessment.timing?.finishBy &&
              attempt.deadline + amount > current.assessment.timing.finishBy
            )
              throw new DomainError(
                'This exceeds the finish-by deadline. Extend everyone to move that deadline first.',
                409,
              );
            db.prepare('UPDATE attempts SET deadline=deadline+? WHERE id=?').run(
              amount,
              attempt.id,
            );
            db.prepare('UPDATE sittings SET deadline=MAX(deadline,?) WHERE id=?').run(
              attempt.deadline + amount,
              sitting.id,
            );
            detail = {
              reason,
              minutes: input.minutes,
              candidateId,
              previousDeadline: attempt.deadline,
              newDeadline: attempt.deadline + amount,
            };
          } else {
            db.prepare(
              "UPDATE attempts SET deadline=deadline+? WHERE sitting_id=? AND status='active'",
            ).run(amount, sitting.id);
            db.prepare('UPDATE sittings SET deadline=deadline+? WHERE id=?').run(
              amount,
              sitting.id,
            );
            db.prepare(
              'UPDATE exam_controls SET extra_ms=extra_ms+?,shared_deadline=shared_deadline+? WHERE sitting_id=?',
            ).run(amount, amount, sitting.id);
            detail.minutes = input.minutes;
            detail.scope = 'everyone';
          }
          break;
        }
        case 'force_submit': {
          const candidateId = text(input.candidateId, 'Candidate', 100, 1);
          const attempt = this.store.findAttempt(sitting.id, candidateId);
          if (!attempt || attempt.status !== 'active')
            throw new DomainError('Only an ongoing attempt can be submitted.', 409);
          db.prepare("UPDATE attempts SET status='submitted',submitted_at=? WHERE id=?").run(
            now,
            attempt.id,
          );
          detail = { reason, candidateId, attemptId: attempt.id };
          break;
        }
        default:
          throw new DomainError('Choose a supported examination action.');
      }
      db.prepare('UPDATE exam_controls SET revision=revision+1 WHERE sitting_id=?').run(sitting.id);
      this.store.event(sitting.id, actor, `exam_${input.action}`, detail);
      const receipt = { ok: true, revision: current.revision + 1 };
      db.prepare('INSERT INTO exam_control_receipts VALUES(?,?,?,?,?)').run(
        sitting.id,
        operationId,
        actor,
        fingerprint,
        JSON.stringify(receipt),
      );
      return receipt;
    });
  }
  acknowledge(sittingId: string, candidateId: string, input: Record<string, unknown>) {
    const id = text(input.id, 'Announcement', 100, 1);
    if (
      !this.store.db
        .prepare('SELECT id FROM exam_announcements WHERE id=? AND sitting_id=?')
        .get(id, sittingId)
    )
      throw new DomainError('Announcement not found.', 404);
    this.store.db
      .prepare('INSERT OR IGNORE INTO announcement_reads VALUES(?,?,?)')
      .run(id, candidateId, this.store.now());
    return { ok: true };
  }
}
