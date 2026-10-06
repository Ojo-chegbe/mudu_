import type { DatabaseSync } from 'node:sqlite';
import type { Session } from './store.ts';
import type { NotificationFeed, NotificationItem } from '../../packages/contracts/notifications.ts';
import { DomainError } from '../../packages/exam-core/model.ts';
import { transaction } from './database.ts';

export function notificationOwner(session: Session) {
  if (session.role === 'admin') return `admin:${session.principal_id}`;
  if (session.account_id) return `account:${session.account_id}`;
  throw new DomainError('Notifications require a MUDU account.', 403);
}

export function notificationFeed(db: DatabaseSync, session: Session): NotificationFeed {
  const owner = notificationOwner(session);
  // Stable source IDs make polling and restart recovery idempotent, including existing work.
  const put = (id: string, title: string, message: string, href: string, at: number) => {
    db.prepare('INSERT OR IGNORE INTO notifications VALUES(?,?,?,?,?,?,NULL)').run(
      owner,
      id,
      title,
      message,
      href,
      at,
    );
  };
  transaction(db, () => {
    if (session.role === 'admin') {
      for (const r of db
        .prepare(
          `SELECT m.*,r.name rosterName,a.name FROM roster_members m JOIN rosters r ON r.id=m.roster_id JOIN accounts a ON a.id=m.account_id WHERE r.owner_id=? AND m.status='pending'`,
        )
        .all(session.principal_id))
        put(
          `roster-request:${r.roster_id}:${r.account_id}`,
          'Roster membership requested',
          `${r.name} requested to join ${r.rosterName}.`,
          `/rosters/${r.roster_id}`,
          Number(r.requested_at),
        );
      const requests = db
        .prepare(
          `SELECT r.*,a.definition,p.name FROM registrations r
        JOIN assessments a ON a.id=r.assessment_id JOIN accounts p ON p.id=r.account_id
        JOIN assessment_owners o ON o.assessment_id=a.id WHERE r.status='pending' AND o.owner_id=?`,
        )
        .all(session.principal_id);
      for (const r of requests)
        put(
          `registration:${r.id}`,
          'Registration requested',
          `${r.name} requested to join ${JSON.parse(String(r.definition)).title}.`,
          `/assessments/${r.assessment_id}?tab=overview#registration`,
          Number(r.requested_at),
        );
      const essays = db
        .prepare(
          `SELECT DISTINCT t.id,t.submitted_at,s.assessment_id,s.snapshot,c.name
        FROM attempts t JOIN sittings s ON s.id=t.sitting_id JOIN assessment_owners o ON o.assessment_id=s.assessment_id JOIN candidates c ON c.id=t.candidate_id
        JOIN responses r ON r.attempt_id=t.id JOIN json_each(s.snapshot,'$.questions') q ON json_extract(q.value,'$.id')=r.question_id
        LEFT JOIN manual_marks m ON m.attempt_id=t.id AND m.question_id=r.question_id
        WHERE t.status<>'active' AND json_extract(q.value,'$.type')='short'
        AND length(trim(json_extract(r.value,'$')))>0 AND m.attempt_id IS NULL AND o.owner_id=?`,
        )
        .all(session.principal_id);
      for (const r of essays)
        put(
          `grading:${r.id}`,
          'Written submission received',
          `${r.name} submitted written answers for ${JSON.parse(String(r.snapshot)).title}. Review marking in Results.`,
          `/assessments/${r.assessment_id}?tab=results`,
          Number(r.submitted_at),
        );
    } else {
      const cached = db
        .prepare(
          "SELECT detail FROM events WHERE actor_id=? AND kind='candidate_cloud_rosters_cache' ORDER BY id DESC LIMIT 1",
        )
        .get(session.account_id!);
      if (cached)
        for (const group of JSON.parse(String(cached.detail))
          .groups as import('../../packages/contracts/cloud-rosters.ts').CloudCandidateGroup[])
          if (group.member.status !== 'pending')
            put(
              `roster-decision:${group.id}:${group.member.status}:${group.member.reviewedAt}`,
              group.member.status === 'approved' ? 'Added to a group' : 'Group membership declined',
              group.name,
              `/join/roster/${group.token}`,
              group.member.reviewedAt ?? group.member.requestedAt,
            );
      for (const r of db
        .prepare(
          `SELECT m.*,r.name,r.token FROM roster_members m JOIN rosters r ON r.id=m.roster_id WHERE m.account_id=? AND m.status<>'pending'`,
        )
        .all(session.account_id!))
        put(
          `roster-decision:${r.roster_id}:${r.status}:${r.reviewed_at}`,
          r.status === 'approved' ? 'Added to a group' : 'Group membership declined',
          String(r.name),
          `/join/roster/${r.token}`,
          Number(r.reviewed_at),
        );
      const decisions = db
        .prepare(
          `SELECT r.*,a.definition FROM registrations r JOIN assessments a ON a.id=r.assessment_id
        WHERE r.account_id=? AND r.status IN ('approved','rejected')`,
        )
        .all(session.account_id!);
      for (const r of decisions)
        put(
          `decision:${r.id}:${r.status}:${r.reviewed_at}`,
          r.status === 'approved' ? 'Registration approved' : 'Registration declined',
          `${JSON.parse(String(r.definition)).title}${r.status === 'approved' ? ' is now in your examinations.' : ': contact the assessment organiser if you need clarification.'}`,
          '/exam',
          Number(r.reviewed_at ?? r.requested_at),
        );
    }
  });
  return {
    items: db
      .prepare(
        'SELECT id,title,message,href,created_at AS createdAt,read_at AS readAt FROM notifications WHERE recipient=? ORDER BY read_at IS NOT NULL,created_at DESC,id DESC LIMIT 100',
      )
      .all(owner) as unknown as NotificationItem[],
    unread: Number(
      db
        .prepare('SELECT COUNT(*) AS n FROM notifications WHERE recipient=? AND read_at IS NULL')
        .get(owner)?.n,
    ),
  };
}

export function readNotifications(db: DatabaseSync, session: Session, ids: unknown, now: number) {
  const owner = notificationOwner(session);
  if (
    !Array.isArray(ids) ||
    ids.length > 100 ||
    ids.some((id) => typeof id !== 'string' || id.length > 200)
  )
    throw new DomainError('Invalid notification selection.');
  transaction(db, () => {
    for (const id of ids)
      db.prepare(
        'UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE recipient=? AND id=?',
      ).run(now, owner, id);
  });
}
