import type { AssessmentInput } from './assessment-authoring.ts';
import type { CandidateInput } from '../exam-core/model.ts';

export interface AssessmentWizardDraft {
  useRoster?: boolean;
  accessChoiceConfirmed?: boolean;
  roster?: { id: string; name: string; revision: number } | null;
  step: number;
  details: Omit<AssessmentInput, 'questions'>;
  questions: AssessmentInput['questions'];
  candidates: CandidateInput[];
  accessMode: 'accounts' | 'legacy';
  registrationPolicy: 'approval' | 'roster';
  registrationCloses: string;
  registrationCapacity: number;
  keysSaved: boolean;
  requestId: string;
  createdId: string | null;
}
export type AuthoringDocument =
  | { version: 1; id: string; kind: 'draft'; draft: AssessmentWizardDraft | null }
  | {
      version: 1;
      id: string;
      kind: 'assessment';
      input: AssessmentInput;
      executionHostId: string;
      registration: {
        policy: 'approval' | 'roster';
        token: string;
        open: boolean;
        closesAt: number | null;
        capacity: number;
      };
      roster: { id: string; name: string; revision: number } | null;
    };
export interface AuthoringReceipt {
  id: string;
  revision: number;
  digest: string;
}
export interface AuthoringRecord extends AuthoringReceipt {
  payload: string;
}
export type AuthoringState =
  | 'local'
  | 'pending'
  | 'synced'
  | 'offline'
  | 'conflict'
  | 'setup'
  | 'signin'
  | 'paused'
  | 'blocked';
export interface AuthoringStatus {
  id: string;
  state: AuthoringState;
  message?: string;
  recoveryAvailable?: boolean;
  deliveryReady?: boolean;
}
export interface AuthoringOverview {
  enabled: boolean;
  state?: AuthoringState;
  message?: string;
  items: AuthoringStatus[];
}
export interface SavedWizard {
  draft: AssessmentWizardDraft;
  revision: number;
}
export interface AuthoringDraftSummary {
  id: string;
  title: string;
  course: string;
  step: number;
  updatedAt: number;
}
