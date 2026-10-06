import type { Assessment, Grade, ResponseValue } from '../exam-core/model.ts';

export interface CloudExamRecord {
  version: 1;
  assessment: Assessment;
  sitting: { id: string; startedAt: number; deadline: number };
  candidates: Array<{
    id: string;
    name: string;
    identifier: string;
    status: string;
    answered: number;
    submittedAt: number | null;
    grade: Grade | null;
    responses: Record<string, ResponseValue>;
    manualScores: Record<string, number>;
  }>;
  events: Array<{
    id: number;
    actor: string;
    kind: string;
    detail: Record<string, unknown>;
    createdAt: number;
  }>;
}
export interface CloudRecordSummary {
  id: string;
  title: string;
  course: string;
  candidateCount: number;
  revision: number;
  syncedAt: string;
}
export type SyncState = 'pending' | 'uploading' | 'retry' | 'conflict' | 'synced';
export interface SyncItem {
  id: string;
  assessmentId: string;
  title: string;
  state: SyncState;
  uploaded: number;
  total: number;
  error: string | null;
  syncedAt: number | null;
  revision: number | null;
}
export interface CloudSyncStatus {
  pausedForExam?: boolean;
  available: boolean;
  connected: boolean;
  signedIn: boolean;
  items: SyncItem[];
  ready: Array<{ id: string; title: string; candidateCount: number }>;
}
