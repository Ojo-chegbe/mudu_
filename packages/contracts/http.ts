import type { Assessment, Grade } from '../exam-core/model.ts';

export interface AuthState {
  connection?: WorkspaceConnectionState;
  preferences?: AccountPreferences;
  deviceAccessAvailable?: boolean;
  deviceAccessEnabled?: boolean;
  deviceAccessConfigured?: boolean;
  deviceSignedIn?: boolean;
  onlineAvailable?: boolean;
  offlineAdmissionAvailable?: boolean;
  offlineAdmission?: boolean;
  candidateCloudAvailable?: boolean;
  candidateCloudConnected?: boolean;
  candidateCloudSignedIn?: boolean;
  cloudAvailable?: boolean;
  cloudConnected?: boolean;
  cloudSignedIn?: boolean;
  adminId?: string | null;
  hostOperator?: boolean;
  configured: boolean;
  localConfigured?: boolean;
  role: 'admin' | 'candidate' | null;
  csrf: string | null;
  name: string | null;
  accountId?: string | null;
  identityMode?: 'primary' | 'replica';
}
export interface WorkspaceConnectionState {
  mode: 'auto' | 'offline';
  state: 'online' | 'offline' | 'local';
  offlineEnabled: boolean;
  needsOnlineSignIn: boolean;
}
export interface AccountPreferences {
  textSize: 'normal' | 'large';
  reducedMotion: 'system' | 'reduce';
  notificationBadge: boolean;
}
export interface AccountProfile {
  name: string;
  email: string | null;
  role: 'admin' | 'candidate';
  connected: boolean;
  emailVerified: boolean;
  hostOperator: boolean;
  canEditName: boolean;
  candidate?: import('./registration.ts').CandidateProfile;
}
export interface Summary {
  delivery?: 'local' | 'online';
  accessMode: 'accounts' | 'legacy';
  id: string;
  title: string;
  course: string;
  durationMinutes: number;
  questionCount: number;
  candidateCount: number;
  timingMode?: 'shared' | 'individual';
  allowLateAdmission?: boolean;
  createdAt: number;
  status: 'draft' | 'active' | 'completed';
  sitting: {
    id: string;
    code: string;
    deadline: number;
    startedAt: number;
    pausedAt?: number | null;
  } | null;
}
export interface AssessmentDetail {
  lateRosterAvailable?: boolean;
  delivery?: 'local' | 'online';
  preparedLocalRun?: boolean;
  deliveryReady?: boolean;
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
  events: Array<{
    id: number;
    kind: string;
    createdAt: number;
    reason?: string | null;
    minutes?: number | null;
    candidateName?: string | null;
  }>;
  serverNow: number;
}
