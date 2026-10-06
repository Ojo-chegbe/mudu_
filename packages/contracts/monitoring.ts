export type MonitorStatus = 'waiting' | 'active' | 'disconnected' | 'submitted' | 'expired';
export interface MonitoredCandidate {
  id: string;
  name: string;
  identifier: string;
  status: MonitorStatus;
  answered: number;
  lastSeenAt: number | null;
  lastSavedAt: number | null;
  startedAt: number | null;
  submittedAt: number | null;
  reconnects: number;
  deadline?: number | null;
}
export interface MonitoringSnapshot {
  controls?: { revision: number; pausedAt: number | null };
  announcements?: { id: string; message: string; createdAt: number }[];
  serverNow: number;
  disconnectAfterMs: number;
  questionCount: number;
  deadline: number | null;
  candidates: MonitoredCandidate[];
  timingMode?: 'shared' | 'individual';
  opensAt?: number | null;
  lastStartAt?: number | null;
}
