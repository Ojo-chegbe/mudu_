import type { ExamStore } from './store.ts';
import { transaction } from './database.ts';
import { DomainError } from '../../packages/exam-core/model.ts';
import type { Assessment } from '../../packages/exam-core/model.ts';
import type { MonitoringSnapshot, MonitorStatus } from '../../packages/contracts/monitoring.ts';
import { admissionWindow } from '../../packages/exam-core/timing.ts';
import { execution } from './exam-controls.ts';

export const disconnectAfterMs = 45000;

export class LiveMonitoring {
  private store: ExamStore;
  constructor(store: ExamStore) {
    this.store = store;
  }

  heartbeat(sittingId: string, candidateId: string) {
    const { db } = this.store;
    const sitting = this.store.sitting(sittingId);
    const eligible = db
      .prepare(
        `SELECT c.id FROM candidates c
      JOIN registration_settings s ON s.assessment_id=c.assessment_id
      WHERE c.id=? AND c.assessment_id=? AND (s.mode='legacy' OR EXISTS
      (SELECT 1 FROM registrations r WHERE r.candidate_id=c.id AND r.status='approved'))`,
      )
      .get(candidateId, sitting.assessment_id);
    if (!eligible) throw new DomainError('Candidate not eligible.', 403);
    const now = this.store.now();
    const control = execution(db, sitting, now);
    const attempt = this.store.findAttempt(sittingId, candidateId);
    const window = admissionWindow(
      control.assessment,
      sitting.started_at,
      control.admissionDeadline,
      control.now,
    );
    if (
      (attempt && (attempt.status !== 'active' || control.now >= attempt.deadline)) ||
      (!attempt && window.startRestriction === 'closed')
    )
      return { serverNow: now, ended: true };
    transaction(db, () => {
      const previous = db
        .prepare(
          'SELECT last_seen_at,reconnects FROM candidate_presence WHERE sitting_id=? AND candidate_id=?',
        )
        .get(sittingId, candidateId);
      // Bound writes even when several tabs send heartbeats at once.
      if (previous && now - Number(previous.last_seen_at) < 5000) return;
      const saved = attempt
        ? db.prepare('SELECT MAX(saved_at) AS at FROM responses WHERE attempt_id=?').get(attempt.id)
            ?.at
        : null;
      const lastContact = Math.max(
        Number(previous?.last_seen_at ?? 0),
        Number(saved ?? 0),
        attempt?.startedAt ?? 0,
      );
      const reconnected = Boolean(previous && now - lastContact >= disconnectAfterMs);
      db.prepare(
        `INSERT INTO candidate_presence(sitting_id,candidate_id,last_seen_at,reconnects)
        VALUES(?,?,?,?) ON CONFLICT(sitting_id,candidate_id) DO UPDATE SET
        last_seen_at=excluded.last_seen_at,reconnects=excluded.reconnects`,
      ).run(sittingId, candidateId, now, Number(previous?.reconnects ?? 0) + Number(reconnected));
      if (reconnected)
        this.store.event(sittingId, candidateId, 'candidate_connection_restored', {
          lastContactAt: lastContact,
          observedGapMs: now - lastContact,
        });
    });
    return { serverNow: now, ended: false };
  }

  snapshot(assessmentId: string): MonitoringSnapshot {
    this.store.reconcile();
    const { db } = this.store;
    const assessment = this.store.assessment(assessmentId);
    const sitting = db
      .prepare('SELECT id,snapshot,deadline,started_at FROM sittings WHERE assessment_id=?')
      .get(assessmentId);
    const control = sitting
      ? execution(db, this.store.sitting(String(sitting.id)), this.store.now())
      : null;
    const definition: Assessment = control?.assessment ?? assessment;
    const now = this.store.now();
    const window = sitting
      ? admissionWindow(
          definition,
          Number(sitting.started_at),
          control!.admissionDeadline,
          control!.now,
        )
      : null;
    const progress = new Map<string, { answered: number; savedAt: number }>();
    if (sitting) {
      // Match JavaScript trim(), including Unicode whitespace, without loading
      // every candidate's full written answers into memory on every update.
      const whitespace =
        ' \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
      for (const row of db
        .prepare(
          `SELECT r.attempt_id,MAX(r.saved_at) AS saved_at,
          SUM(CASE WHEN json_type(r.value)='array' THEN json_array_length(r.value)>0
            ELSE length(trim(json_extract(r.value,'$'),?))>0 END) AS answered
          FROM responses r JOIN attempts a ON a.id=r.attempt_id
          WHERE a.sitting_id=? AND r.question_id IN
          (SELECT json_extract(value,'$.id') FROM json_each(?,'$.questions'))
          GROUP BY r.attempt_id`,
        )
        .all(whitespace, sitting.id!, String(sitting.snapshot))) {
        progress.set(String(row.attempt_id), {
          answered: Number(row.answered),
          savedAt: Number(row.saved_at),
        });
      }
    }
    const candidates = db
      .prepare(
        `SELECT c.id,c.name,c.identifier,a.id AS attempt_id,a.status,
      a.started_at,a.submitted_at,a.deadline,p.last_seen_at,p.reconnects
      FROM candidates c JOIN registration_settings s ON s.assessment_id=c.assessment_id
      LEFT JOIN attempts a ON a.candidate_id=c.id AND a.sitting_id=?
      LEFT JOIN candidate_presence p ON p.candidate_id=c.id AND p.sitting_id=?
      WHERE c.assessment_id=? AND (s.mode='legacy' OR EXISTS
      (SELECT 1 FROM registrations r WHERE r.candidate_id=c.id AND r.status='approved'))
      ORDER BY c.identifier,c.id`,
      )
      .all(sitting?.id ?? null, sitting?.id ?? null, assessmentId)
      .map((row) => {
        const saved = progress.get(String(row.attempt_id));
        const lastSeenAt =
          Math.max(
            Number(row.last_seen_at ?? 0),
            Number(row.started_at ?? 0),
            saved?.savedAt ?? 0,
          ) || null;
        let status: MonitorStatus = (row.status as MonitorStatus | null) ?? 'waiting';
        if (status === 'active' && (!lastSeenAt || now - lastSeenAt >= disconnectAfterMs))
          status = 'disconnected';
        if (!row.attempt_id && window?.startRestriction === 'closed') status = 'expired';
        return {
          id: String(row.id),
          name: String(row.name),
          identifier: String(row.identifier),
          status,
          answered: saved?.answered ?? 0,
          lastSeenAt,
          lastSavedAt: saved?.savedAt ?? null,
          startedAt: row.started_at === null ? null : Number(row.started_at),
          submittedAt: row.submitted_at === null ? null : Number(row.submitted_at),
          reconnects: Number(row.reconnects ?? 0),
          deadline: row.deadline === null ? null : Number(row.deadline),
        };
      });
    return {
      serverNow: now,
      controls: { revision: control?.revision ?? 0, pausedAt: control?.pausedAt ?? null },
      announcements: sitting
        ? db
            .prepare(
              'SELECT id,message,created_at FROM exam_announcements WHERE sitting_id=? ORDER BY created_at DESC,rowid DESC LIMIT 500',
            )
            .all(sitting.id!)
            .map((a) => ({
              id: String(a.id),
              message: String(a.message),
              createdAt: Number(a.created_at),
            }))
        : [],
      disconnectAfterMs,
      questionCount: definition.questions.length,
      deadline: sitting ? Number(sitting.deadline) : null,
      candidates,
      timingMode: definition.timing?.mode ?? 'shared',
      opensAt: window?.opensAt ?? null,
      lastStartAt: window?.lastStartAt ?? null,
    };
  }
}
