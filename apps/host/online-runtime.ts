import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import type { Assessment } from '../../packages/exam-core/model.ts';
import { openDatabase } from './database.ts';
import { ExamStore } from './store.ts';
import { ExamControls } from './exam-controls.ts';
import { LiveMonitoring } from './monitoring.ts';

export const executionTables = {
  registration_settings: ['assessment_id'],
  sittings: ['id'],
  attempts: ['id'],
  responses: ['attempt_id', 'question_id'],
  operations: ['attempt_id', 'operation_id'],
  manual_marks: ['attempt_id', 'question_id'],
  candidate_presence: ['sitting_id', 'candidate_id'],
  exam_controls: ['sitting_id'],
  exam_announcements: ['id'],
  announcement_reads: ['announcement_id', 'candidate_id'],
  exam_control_receipts: ['sitting_id', 'operation_id'],
} as const;
export type ExecutionTable = keyof typeof executionTables;
export interface OnlineMember {
  exam_id: string;
  owner_id: string;
  account_id: string;
  candidate_id: string;
  registration_id: string;
  identifier: string;
  name: string;
  email: string;
  status: 'pending' | 'approved' | 'rejected';
  requested_at: number;
  reviewed_at: number | null;
}
export interface ExecutionRow {
  table_name: ExecutionTable;
  row_key: string;
  candidate_id: string | null;
  payload: Record<string, SQLInputValue>;
}
export function executionKey(table: ExecutionTable, row: Record<string, SQLInputValue>) {
  return executionTables[table].map((key) => String(row[key])).join(':');
}

/** Disposable projection only. PostgreSQL commits remain the sole online authority. */
export function onlineRuntime(
  definition: Assessment,
  owner: string,
  members: OnlineMember[],
  rows: ExecutionRow[],
  now: number,
  createdAt = now,
) {
  const db = openDatabase(':memory:');
  try {
    const store = new ExamStore(db, () => now);
    db.prepare(
      'INSERT INTO administrators(id,name,password_hash,singleton) VALUES(?,?,?,NULL)',
    ).run(owner, 'Administrator', 'unusable');
    for (const member of members) {
      db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?)').run(
        member.account_id,
        member.email,
        member.name,
        'unusable',
        now,
      );
      db.prepare('INSERT INTO memberships VALUES(?,?,?,?,?,NULL)').run(
        randomUUID(),
        member.account_id,
        'default',
        member.identifier,
        'pending',
      );
    }
    store.createAssessment(
      definition,
      members.map((m) => ({
        id: m.candidate_id,
        identifier: m.identifier,
        name: m.name,
        hash: 'unusable',
      })),
      owner,
      { mode: 'accounts', policy: 'approval', capacity: 500, closesAt: null },
    );
    db.prepare('UPDATE assessments SET created_at=? WHERE id=?').run(createdAt, definition.id);
    for (const m of members)
      db.prepare('INSERT INTO registrations VALUES(?,?,?,?,?,?,?)').run(
        m.registration_id,
        definition.id,
        m.account_id,
        m.candidate_id,
        m.status,
        m.requested_at,
        m.reviewed_at,
      );
    db.exec('DELETE FROM events');
    if (rows.some((r) => r.table_name === 'registration_settings'))
      db.exec('DELETE FROM registration_settings');
    for (const table of Object.keys(executionTables) as ExecutionTable[]) {
      const columns = new Set(
        db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((c) => String(c.name)),
      );
      for (const row of rows.filter((r) => r.table_name === table)) {
        const keys = Object.keys(row.payload);
        if (
          !keys.length ||
          keys.some((k) => !columns.has(k)) ||
          executionKey(table, row.payload) !== row.row_key
        )
          throw new Error('Invalid persisted online execution row.');
        db.prepare(
          `INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
        ).run(...keys.map((k) => row.payload[k]));
      }
    }
    function snapshot(): ExecutionRow[] {
      const attempts = new Map(
        db
          .prepare('SELECT id,candidate_id FROM attempts')
          .all()
          .map((r) => [String(r.id), String(r.candidate_id)]),
      );
      return (Object.keys(executionTables) as ExecutionTable[]).flatMap((table) =>
        db
          .prepare(`SELECT * FROM ${table}`)
          .all()
          .map((payload) => ({
            table_name: table,
            row_key: executionKey(table, payload),
            candidate_id:
              payload.candidate_id == null
                ? payload.attempt_id == null
                  ? null
                  : (attempts.get(String(payload.attempt_id)) ?? null)
                : String(payload.candidate_id),
            payload,
          })),
      );
    }
    return {
      db,
      store,
      controls: new ExamControls(store),
      monitor: new LiveMonitoring(store),
      snapshot,
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
