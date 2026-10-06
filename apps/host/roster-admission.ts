import { randomUUID } from 'node:crypto';
import type { ExamStore } from './store.ts';
import type { Assessment } from '../../packages/exam-core/model.ts';
import { admissionWindow } from '../../packages/exam-core/timing.ts';
import { execution } from './exam-controls.ts';

// Call within the caller's transaction: admission and membership commit together.
export function syncRosterAssessment(store: ExamStore, assessmentId: string, actor: string) {
  const { db } = store;
  const row = db
    .prepare(
      `SELECT l.roster_id,r.archived,s.mode,s.capacity,a.definition
    FROM assessment_rosters l JOIN rosters r ON r.id=l.roster_id
    JOIN registration_settings s ON s.assessment_id=l.assessment_id
    JOIN assessments a ON a.id=l.assessment_id WHERE l.assessment_id=?`,
    )
    .get(assessmentId);
  if (!row || row.archived || row.mode !== 'accounts') return 0;
  const assessment: Assessment = JSON.parse(String(row.definition));
  const sitting = db
    .prepare('SELECT id,started_at,deadline,snapshot FROM sittings WHERE assessment_id=?')
    .get(assessmentId);
  if (sitting) {
    const now = store.now();
    const control = execution(db, store.sitting(String(sitting.id)), now);
    if (control.pausedAt !== null) return 0;
    const window = admissionWindow(
      control.assessment,
      Number(sitting.started_at),
      control.admissionDeadline,
      now,
    );
    if (
      now >= Number(sitting.deadline) ||
      window.startRestriction === 'closed' ||
      (now >= window.opensAt && !assessment.allowLateAdmission)
    )
      return 0;
  }
  const members = db
    .prepare(
      `SELECT a.id,a.name,m.identifier FROM roster_members rm
    JOIN accounts a ON a.id=rm.account_id JOIN memberships m ON m.account_id=a.id AND m.organization_id='default'
    WHERE rm.roster_id=? AND rm.status='approved' AND m.status='verified' AND NOT EXISTS
    (SELECT 1 FROM registrations x WHERE x.assessment_id=? AND x.account_id=a.id)
    ORDER BY rm.reviewed_at,a.id`,
    )
    .all(row.roster_id!, assessmentId);
  const admitted = Number(
    db
      .prepare("SELECT COUNT(*) n FROM registrations WHERE assessment_id=? AND status='approved'")
      .get(assessmentId)?.n,
  );
  let count = 0;
  for (const member of members) {
    if (admitted + count >= Number(row.capacity)) break;
    // Never reassign an existing candidate number to a different account.
    if (
      db
        .prepare('SELECT 1 FROM candidates WHERE assessment_id=? AND identifier=?')
        .get(assessmentId, member.identifier!)
    )
      continue;
    const candidateId = randomUUID();
    db.prepare('INSERT INTO candidates VALUES(?,?,?,?,?)').run(
      candidateId,
      assessmentId,
      member.identifier!,
      member.name!,
      'account-managed',
    );
    db.prepare("INSERT INTO registrations VALUES(?,?,?,?,'approved',?,?)").run(
      randomUUID(),
      assessmentId,
      member.id!,
      candidateId,
      store.now(),
      store.now(),
    );
    count++;
  }
  if (count)
    store.event(
      sitting
        ? String(db.prepare('SELECT id FROM sittings WHERE assessment_id=?').get(assessmentId)?.id)
        : null,
      actor,
      'roster_members_auto_admitted',
      { assessmentId, rosterId: row.roster_id, count },
    );
  return count;
}
export function syncLinkedRosters(store: ExamStore, actor: string, rosterId?: string) {
  const rows = rosterId
    ? store.db
        .prepare('SELECT assessment_id FROM assessment_rosters WHERE roster_id=?')
        .all(rosterId)
    : store.db.prepare('SELECT assessment_id FROM assessment_rosters').all();
  for (const row of rows) syncRosterAssessment(store, String(row.assessment_id), actor);
}
