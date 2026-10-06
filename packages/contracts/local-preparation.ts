export interface LocalExamPass {
  version: 1;
  preparationId: string;
  runId: string;
  hostId: string;
  accountId: string;
  candidateId: string;
  credential: string;
  expiresAt: number;
  title: string;
}
export interface LocalPreparationStatus {
  isPreparedRun: boolean;
  enabled: boolean;
  sourceId: string;
  sourceVersion: string;
  preparation: null | {
    id: string;
    runId: string;
    state: 'pending' | 'ready' | 'completed' | 'cancelled';
    candidates: number;
    downloaded: number | null;
    expiresAt: number;
    error: string | null;
    started: boolean;
  };
}
export interface CandidateLocalPass {
  preparationId: string;
  runId: string;
  title: string;
  course: string;
  expiresAt: number;
  downloadedAt: number | null;
}
