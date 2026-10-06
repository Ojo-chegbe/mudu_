export interface ExamControlState {
  revision: number;
  pausedAt: number | null;
}
export interface ExamAnnouncement {
  id: string;
  message: string;
  createdAt: number;
  read?: boolean;
}
export type ExamControlAction = 'announce' | 'extend' | 'pause' | 'resume' | 'force_submit';
