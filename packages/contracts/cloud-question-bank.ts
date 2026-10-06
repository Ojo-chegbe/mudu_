import type { BankItem, BankProject } from './question-bank.ts';

export interface CloudBankSnapshot {
  version: 1;
  projects: Array<Omit<BankProject, 'counts'>>;
  questions: Array<BankItem & { deletedAt: number | null; creationFingerprint: string }>;
}
export interface CloudBankReceipt {
  revision: number;
  digest: string;
}
export interface CloudBankStatus {
  recoveryAvailable?: boolean;
  state: 'local' | 'pending' | 'synced' | 'offline' | 'conflict' | 'setup' | 'paused' | 'signin';
  revision: number;
  lastSyncedAt: number | null;
  message: string | null;
}
