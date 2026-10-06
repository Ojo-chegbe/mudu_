import { createClient } from '@supabase/supabase-js';
import type {
  CloudBankReceipt,
  CloudBankSnapshot,
} from '../../packages/contracts/cloud-question-bank.ts';
import { DomainError } from '../../packages/exam-core/model.ts';

export interface CloudBankStorage {
  metadata(accessToken: string): Promise<CloudBankReceipt>;
  read(accessToken: string): Promise<CloudBankReceipt & { snapshot: CloudBankSnapshot }>;
  write(accessToken: string, revision: number, payload: string): Promise<CloudBankReceipt>;
}
export class SupabaseBankStorage implements CloudBankStorage {
  private config: { url: string; key: string };
  constructor(config: { url: string; key: string }) {
    this.config = config;
  }
  private client(accessToken: string) {
    return createClient(this.config.url, this.config.key, {
      accessToken: async () => accessToken,
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(12000) }),
      },
    });
  }
  private async rpc(accessToken: string, name: string, args = {}) {
    const { data, error } = await this.client(accessToken).rpc(name, args);
    if (error) {
      if (error.code === 'M0001')
        throw new DomainError(
          'Your question bank changed on another computer. Both copies are safe.',
          409,
          'BANK_CONFLICT',
        );
      if (['PGRST202', '42P01'].includes(error.code))
        throw new DomainError(
          'Cloud question bank needs its database update. Your local questions are safe.',
          503,
          'CLOUD_SETUP_REQUIRED',
        );
      if (['42501', 'PGRST301'].includes(error.code))
        throw new DomainError(
          'Sign in to your cloud account to sync your question bank.',
          401,
          'UNAUTHENTICATED',
        );
      throw new DomainError(
        'Cloud question bank is temporarily unavailable. Your work is saved on this computer.',
        503,
      );
    }
    return data;
  }
  async metadata(token: string): Promise<CloudBankReceipt> {
    return this.rpc(token, 'mudu_bank_metadata');
  }
  async read(token: string): Promise<CloudBankReceipt & { snapshot: CloudBankSnapshot }> {
    return this.rpc(token, 'mudu_read_bank');
  }
  async write(token: string, revision: number, payload: string): Promise<CloudBankReceipt> {
    return this.rpc(token, 'mudu_write_bank', {
      p_expected_revision: revision,
      p_payload: payload,
    });
  }
}
