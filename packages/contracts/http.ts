import type { Assessment, Grade } from '../exam-core/model.ts';

export interface AuthState {
  configured: boolean;
  role: 'admin' | 'candidate' | null;
  csrf: string | null;
  name: string | null;
  accountId?: string | null;
  identityMode?: 'primary' | 'replica';
}
export interface Summary {
  accessMode: 'accounts' | 'legacy';
  id: string;
  title: string;
  course: string;
  durationMinutes: number;
  questionCount: number;
  candidateCount: number;
  createdAt: number;
  status: 'draft' | 'active' | 'completed';
  sitting: { id: string; code: string; deadline: number; startedAt: number } | null;
}
export interface AssessmentDetail {
  source?: { id: string; title: string } | null;
  roster?: { id: string; name: string; revision: number } | null;
  assessment: Assessment;
  summary: Summary;
  candidates: Array<{
    id: string;
    name: string;
    identifier: string;
    status: string;
    answered: number;
    submittedAt: number | null;
    grade: Grade | null;
  }>;
  events: Array<{ id: number; kind: string; createdAt: number }>;
  serverNow: number;
}
