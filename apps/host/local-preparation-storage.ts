import { createClient } from '@supabase/supabase-js';
import { DomainError } from '../../packages/exam-core/model.ts';
import type {
  LocalExamPass,
  CandidateLocalPass,
} from '../../packages/contracts/local-preparation.ts';
export interface PreparationUpload {
  id: string;
  sourceId: string;
  sourceRevision: number;
  sourceDigest: string;
  hostId: string;
  runId: string;
  expiresAt: number;
  title: string;
  course: string;
  sealed: string;
  digest: string;
  members: Array<{
    accountId: string;
    name: string;
    email: string;
    identifier: string;
    candidateId: string;
    registrationId: string;
    pass: LocalExamPass;
  }>;
}
export interface PreparationStorage {
  prepare(token: string, input: PreparationUpload): Promise<{ id: string; digest: string }>;
  close(token: string, id: string, state: 'completed' | 'cancelled'): Promise<void>;
  status(token: string, id: string): Promise<{ downloaded: number }>;
  passes(token: string): Promise<CandidateLocalPass[]>;
  pass(token: string, id: string): Promise<LocalExamPass>;
}
export class SupabasePreparationStorage implements PreparationStorage {
  config: { url: string; key: string };
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
      if (['42P01', 'PGRST202'].includes(error.code))
        throw new DomainError(
          'Local preparation needs its database update. Your assessment is safe.',
          503,
          'CLOUD_SETUP_REQUIRED',
        );
      if (['42501', 'PGRST301'].includes(error.code))
        throw new DomainError(
          'Sign in to your connected account to prepare this examination.',
          401,
        );
      if (error.code === 'M0001')
        throw new DomainError(
          'The source assessment changed or another local run is already reserved. Refresh before preparing.',
          409,
        );
      if (error.code === '22023')
        throw new DomainError(
          'The examination package or candidate identities could not be accepted.',
          409,
        );
      if (error.code === 'P0002')
        throw new DomainError('Local examination access is not available.', 404);
      throw new DomainError(
        'Preparation could not reach the cloud. Your work is saved; retry when connected.',
        503,
      );
    }
    return data;
  }
  prepare(token: string, input: PreparationUpload): Promise<{ id: string; digest: string }> {
    return this.rpc(token, 'mudu_prepare_local', { p_document: input });
  }
  async close(token: string, id: string, state: 'completed' | 'cancelled') {
    await this.rpc(token, 'mudu_close_local', { p_id: id, p_state: state });
  }
  status(token: string, id: string): Promise<{ downloaded: number }> {
    return this.rpc(token, 'mudu_local_status', { p_id: id });
  }
  passes(token: string): Promise<CandidateLocalPass[]> {
    return this.rpc(token, 'mudu_candidate_local_passes');
  }
  pass(token: string, id: string): Promise<LocalExamPass> {
    return this.rpc(token, 'mudu_candidate_local_pass', { p_id: id });
  }
}
