import { createClient } from '@supabase/supabase-js';
import { DomainError } from '../../packages/exam-core/model.ts';
import type {
  CloudCandidateGroup,
  CloudRosterReceipt,
  CloudRosterRecord,
} from '../../packages/contracts/cloud-rosters.ts';
import type { RosterInvitation } from '../../packages/contracts/rosters.ts';

export interface CloudRosterStorage {
  list(token: string): Promise<CloudRosterReceipt[]>;
  read(token: string, id: string): Promise<CloudRosterRecord>;
  write(token: string, expected: number, payload: string): Promise<CloudRosterReceipt>;
  invitation(
    token: string | null,
    link: string,
    personal: boolean,
  ): Promise<RosterInvitation & { claimed?: boolean }>;
  join(
    token: string,
    link: string,
    identifier: string,
    personal: boolean,
  ): Promise<CloudCandidateGroup>;
  groups(token: string): Promise<CloudCandidateGroup[]>;
}
export class SupabaseRosterStorage implements CloudRosterStorage {
  private config: { url: string; key: string };
  constructor(config: { url: string; key: string }) {
    this.config = config;
  }
  private async rpc(token: string | null, name: string, args = {}) {
    const client = createClient(this.config.url, this.config.key, {
      ...(token ? { accessToken: async () => token } : {}),
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(12000) }),
      },
    });
    const { data, error } = await client.rpc(name, args);
    if (error) {
      if (error.code === 'M0001')
        throw new DomainError(
          'This roster changed on another computer. Your changes are saved here; refresh the cloud copy before continuing.',
          409,
          'ROSTER_CONFLICT',
        );
      if (['42P01', 'PGRST202'].includes(error.code))
        throw new DomainError(
          'Cloud rosters need their database update. Your local rosters are safe.',
          503,
          'CLOUD_SETUP_REQUIRED',
        );
      if (error.code === 'M0004') throw new DomainError('Joining link not found.', 404);
      if (error.code === 'M0005')
        throw new DomainError('Sign in with the email address your organiser invited.', 403);
      if (error.code === 'M0006')
        throw new DomainError('Joining is closed. Contact the organiser if you need access.', 409);
      if (error.code === 'M0007')
        throw new DomainError(
          'That number is not on this group’s expected list. Check it or contact the organiser.',
          403,
        );
      if (error.code === 'M0008')
        throw new DomainError('Too many joining requests. Try again in a minute.', 429);
      if (error.code === 'M0003')
        throw new DomainError(
          'Joining is closed, the candidate number is not eligible, or the invitation belongs to another email. Contact the organiser.',
          409,
        );
      if (['42501', 'PGRST301'].includes(error.code))
        throw new DomainError(
          'Sign in to your connected account to continue.',
          401,
          'UNAUTHENTICATED',
        );
      if (['M0002', '23505', '23503'].includes(error.code))
        throw new DomainError(
          'The roster exceeds its limit or contains conflicting candidate numbers or invitations. Review its settings and members.',
          409,
        );
      throw new DomainError(
        'Cloud rosters are temporarily unavailable. Your local records are safe.',
        503,
      );
    }
    return data;
  }
  list(token: string): Promise<CloudRosterReceipt[]> {
    return this.rpc(token, 'mudu_roster_list');
  }
  read(token: string, id: string): Promise<CloudRosterRecord> {
    return this.rpc(token, 'mudu_roster_read', { p_id: id });
  }
  write(token: string, expected: number, payload: string): Promise<CloudRosterReceipt> {
    return this.rpc(token, 'mudu_roster_write', {
      p_expected_revision: expected,
      p_payload: payload,
    });
  }
  invitation(
    token: string | null,
    link: string,
    personal: boolean,
  ): Promise<RosterInvitation & { claimed?: boolean }> {
    return this.rpc(token, 'mudu_roster_invitation', { p_token: link, p_personal: personal });
  }
  join(
    token: string,
    link: string,
    identifier: string,
    personal: boolean,
  ): Promise<CloudCandidateGroup> {
    return this.rpc(token, 'mudu_roster_join', {
      p_token: link,
      p_identifier: identifier,
      p_personal: personal,
    });
  }
  groups(token: string): Promise<CloudCandidateGroup[]> {
    return this.rpc(token, 'mudu_candidate_rosters');
  }
}
