import { createClient } from '@supabase/supabase-js';
import { DomainError } from '../../packages/exam-core/model.ts';
import type {
  AuthoringReceipt,
  AuthoringRecord,
} from '../../packages/contracts/cloud-authoring.ts';

export interface AuthoringStorage {
  list(token: string): Promise<AuthoringReceipt[]>;
  read(token: string, id: string): Promise<AuthoringRecord>;
  write(token: string, expected: number, payload: string): Promise<AuthoringReceipt>;
}
export class SupabaseAuthoringStorage implements AuthoringStorage {
  private config: { url: string; key: string };
  constructor(config: { url: string; key: string }) {
    this.config = config;
  }
  private async rpc(token: string, name: string, args = {}) {
    const client = createClient(this.config.url, this.config.key, {
      accessToken: async () => token,
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(12000) }),
      },
    });
    const { data, error } = await client.rpc(name, args);
    if (error) {
      if (error.code === 'M0001')
        throw new DomainError(
          'This assessment changed on another computer. Both copies are safe.',
          409,
          'AUTHORING_CONFLICT',
        );
      if (['42P01', 'PGRST202'].includes(error.code))
        throw new DomainError(
          'Cloud assessment authoring needs its database update. Your work is saved here.',
          503,
          'CLOUD_SETUP_REQUIRED',
        );
      if (['42501', 'PGRST301'].includes(error.code))
        throw new DomainError(
          'Sign in to your connected account to sync assessments.',
          401,
          'UNAUTHENTICATED',
        );
      if (['22023', '23505'].includes(error.code))
        throw new DomainError(
          'This assessment exceeds a storage limit or conflicts with another record.',
          409,
        );
      throw new DomainError(
        'Cloud assessment saving is temporarily unavailable. Your work is saved here.',
        503,
      );
    }
    return data;
  }
  list(token: string): Promise<AuthoringReceipt[]> {
    return this.rpc(token, 'mudu_authoring_list');
  }
  read(token: string, id: string): Promise<AuthoringRecord> {
    return this.rpc(token, 'mudu_authoring_read', { p_id: id });
  }
  write(token: string, expected: number, payload: string): Promise<AuthoringReceipt> {
    return this.rpc(token, 'mudu_authoring_write', {
      p_expected_revision: expected,
      p_payload: payload,
    });
  }
}
