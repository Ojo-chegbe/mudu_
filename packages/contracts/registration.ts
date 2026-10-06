export interface CandidateProfile {
  id: string;
  name: string;
  email: string;
  identifier: string;
  identityStatus: 'pending' | 'verified';
  organization: string;
}
export interface RegistrationSettings {
  assessmentId: string;
  mode: 'accounts' | 'legacy';
  policy: 'approval' | 'roster';
  token: string;
  open: boolean;
  accepting: boolean;
  closesAt: number | null;
  capacity: number;
  launched: boolean;
}
export interface RegistrationRequest {
  applicationNumber: string | null;
  id: string;
  name: string;
  email: string;
  identifier: string;
  identityStatus: 'pending' | 'verified';
  status: 'pending' | 'approved' | 'rejected';
  rosterName: string | null;
}
export interface ExamRegistration {
  delivery?: 'local' | 'online';
  timingMode?: 'shared' | 'individual';
  opensAt?: number | null;
  lastStartAt?: number | null;
  finishBy?: number | null;
  applicationNumber: string | null;
  assessmentId: string;
  title: string;
  course: string;
  durationMinutes: number;
  questionCount: number;
  registrationStatus: 'pending' | 'approved' | 'rejected';
  examStatus: 'upcoming' | 'available' | 'active' | 'submitted' | 'expired' | 'ended';
}
export interface Invitation {
  assessmentId: string;
  title: string;
  course: string;
  organization: string;
  durationMinutes: number;
  questionCount: number;
  policy: 'approval' | 'roster';
  accepting: boolean;
  closesAt: number | null;
  registration: { status: 'pending' | 'approved' | 'rejected' } | null;
}
