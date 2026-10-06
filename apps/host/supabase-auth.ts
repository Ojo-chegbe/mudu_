import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DomainError } from '../../packages/exam-core/model.ts';

export interface CloudSession {
  userId: string;
  email: string;
  name: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}
export interface CloudAuthProvider {
  signIn(email: string, password: string): Promise<CloudSession>;
  signUp(
    email: string,
    password: string,
    name: string,
  ): Promise<{ pending: boolean; session?: CloudSession }>;
  verify(session: CloudSession): Promise<CloudSession>;
  requestRecovery?(email: string, redirectTo: string): Promise<void>;
  verifyRecovery?(tokenHash: string): Promise<CloudSession>;
  resetPassword?(session: CloudSession, password: string): Promise<void>;
  updateName?(session: CloudSession, name: string): Promise<CloudSession | void>;
}

function providerUnavailable(error: { status?: number; name?: string } | null) {
  if (
    error &&
    (error.status === 0 || (error.status ?? 0) >= 500 || error.name === 'AuthRetryableFetchError')
  )
    throw new DomainError('Account service is temporarily unavailable. Try again shortly.', 503);
  if (error?.status === 429)
    throw new DomainError('Too many account requests. Please try again shortly.', 429);
}

export function supabaseConfig(env: Record<string, string | undefined>) {
  const url = env.MUDU_SUPABASE_URL,
    key = env.MUDU_SUPABASE_PUBLISHABLE_KEY;
  if (!url && !key) return null;
  if (!url || !key)
    throw new Error('Set both MUDU_SUPABASE_URL and MUDU_SUPABASE_PUBLISHABLE_KEY.');
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' ||
    !/^[a-z0-9-]+\.supabase\.co$/.test(parsed.hostname) ||
    parsed.origin !== url
  )
    throw new Error('MUDU_SUPABASE_URL must be the HTTPS project origin.');
  if (key.startsWith('sb_secret_'))
    throw new Error('Use a Supabase publishable key, never a secret key.');
  if (!key.startsWith('sb_publishable_')) {
    try {
      if (JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role !== 'anon')
        throw new Error();
    } catch {
      throw new Error('Use a Supabase publishable key or legacy anon key.');
    }
  }
  return { url, key };
}

export class SupabaseAuth implements CloudAuthProvider {
  url: string;
  key: string;
  constructor(config: { url: string; key: string }) {
    this.url = config.url;
    this.key = config.key;
  }
  private client() {
    // Never share a mutable authenticated client between administrator requests.
    return createClient(this.url, this.key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(10000) }),
      },
    });
  }
  async signIn(email: string, password: string): Promise<CloudSession> {
    try {
      const client = this.client();
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      providerUnavailable(error);
      if (error || !data.session)
        throw new DomainError(
          'Check your email and password. Confirm your email before signing in.',
          401,
        );
      return await this.checked(
        client,
        data.session.access_token,
        data.session.refresh_token,
        data.session.expires_at!,
      );
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('Account sign-in is temporarily unavailable. Try again shortly.', 503);
    }
  }
  async signUp(email: string, password: string, name: string) {
    try {
      const client = this.client();
      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: { data: { name } },
      });
      providerUnavailable(error);
      if (error)
        throw new DomainError(
          'Your account could not be created. Check the details or try again shortly.',
          error.status === 429 ? 429 : 400,
        );
      if (!data.session) return { pending: true };
      return {
        pending: false,
        session: await this.checked(
          client,
          data.session.access_token,
          data.session.refresh_token,
          data.session.expires_at!,
        ),
      };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'Account registration is temporarily unavailable. Try again shortly.',
        503,
      );
    }
  }
  async requestRecovery(email: string, redirectTo: string) {
    try {
      const { error } = await this.client().auth.resetPasswordForEmail(email, { redirectTo });
      providerUnavailable(error);
      // Do not reveal whether an address belongs to an account.
      if (error && ![400, 404, 422].includes(error.status ?? 0))
        throw new DomainError('The reset email could not be sent. Try again shortly.', 503);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('Account recovery is temporarily unavailable. Try again shortly.', 503);
    }
  }
  async verifyRecovery(tokenHash: string) {
    try {
      const client = this.client();
      const { data, error } = await client.auth.verifyOtp({
        token_hash: tokenHash,
        type: 'recovery',
      });
      providerUnavailable(error);
      if (error || !data.session)
        throw new DomainError(
          'This reset link has expired or already been used. Request a new one.',
          401,
          'RECOVERY_EXPIRED',
        );
      return await this.checked(
        client,
        data.session.access_token,
        data.session.refresh_token,
        data.session.expires_at!,
      );
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('Could not verify the reset link. Try again shortly.', 503);
    }
  }
  async resetPassword(session: CloudSession, password: string) {
    try {
      const client = this.client();
      const { data, error } = await client.auth.setSession({
        access_token: session.accessToken,
        refresh_token: session.refreshToken,
      });
      providerUnavailable(error);
      if (error || data.user?.id !== session.userId)
        throw new DomainError(
          'This reset session has expired. Request a new link.',
          401,
          'RECOVERY_EXPIRED',
        );
      const updated = await client.auth.updateUser({ password });
      providerUnavailable(updated.error);
      if (updated.error) {
        if (updated.error.code === 'same_password')
          throw new DomainError('Choose a password different from your current password.');
        if (updated.error.code === 'weak_password')
          throw new DomainError('Choose a stronger password. Try a longer passphrase.');
        throw new DomainError('Your password could not be changed. Request a new reset link.', 400);
      }
      // Password changes revoke other provider refresh sessions. End the recovery session too.
      await client.auth.signOut({ scope: 'global' });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'Could not confirm the password change. Try signing in with your new password, or request another link.',
        503,
      );
    }
  }
  async updateName(session: CloudSession, name: string) {
    try {
      const client = this.client();
      const signed = await client.auth.setSession({
        access_token: session.accessToken,
        refresh_token: session.refreshToken,
      });
      providerUnavailable(signed.error);
      if (signed.error || signed.data.user?.id !== session.userId)
        throw new DomainError('Please sign in again.', 401);
      const { data, error } = await client.auth.updateUser({ data: { name } });
      providerUnavailable(error);
      if (error || data.user?.id !== session.userId)
        throw new DomainError('Your profile could not be updated. Try again.', 400);
      const active = await client.auth.getSession();
      providerUnavailable(active.error);
      if (active.error || !active.data.session) throw new DomainError('Please sign in again.', 401);
      const updated = await this.checked(
        client,
        active.data.session.access_token,
        active.data.session.refresh_token,
        active.data.session.expires_at!,
      );
      if (updated.userId !== session.userId) throw new DomainError('Please sign in again.', 401);
      return updated;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'The account service is unavailable. Your profile has not been changed here.',
        503,
      );
    }
  }
  private async checked(
    client: SupabaseClient,
    accessToken: string,
    refreshToken: string,
    expiresAt: number,
  ): Promise<CloudSession> {
    const { data, error } = await client.auth.getUser(accessToken);
    providerUnavailable(error);
    if (
      error ||
      !data.user ||
      !data.user.email_confirmed_at ||
      !data.user.email ||
      !/^[a-f0-9-]{36}$/.test(data.user.id)
    )
      throw new DomainError('Confirm your email and sign in again.', 401, 'UNAUTHENTICATED');
    return {
      userId: data.user.id,
      email: data.user.email.toLowerCase(),
      name:
        typeof data.user.user_metadata?.name === 'string'
          ? data.user.user_metadata.name.slice(0, 100)
          : '',
      accessToken,
      refreshToken,
      expiresAt: expiresAt * 1000,
    };
  }
  async verify(session: CloudSession) {
    try {
      const client = this.client();
      let { accessToken, refreshToken, expiresAt } = session;
      if (expiresAt <= Date.now() + 60000) {
        const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken });
        providerUnavailable(error);
        if (error || !data.session)
          throw new DomainError('Please sign in again.', 401, 'UNAUTHENTICATED');
        accessToken = data.session.access_token;
        refreshToken = data.session.refresh_token;
        expiresAt = data.session.expires_at! * 1000;
      }
      const verified = await this.checked(client, accessToken, refreshToken, expiresAt / 1000);
      if (verified.userId !== session.userId)
        throw new DomainError('Please sign in again.', 401, 'UNAUTHENTICATED');
      return verified;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'Account verification is temporarily unavailable. Try again shortly.',
        503,
      );
    }
  }
}

export function authSessionKey(directory: string) {
  const path = join(directory, 'cloud-session.key');
  if (!existsSync(path)) {
    try {
      writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (!existsSync(path)) throw error;
    }
  }
  const key = readFileSync(path);
  if (key.length !== 32)
    throw new Error('The cloud session key is invalid. Restore it before starting.');
  return key;
}
export function encryptSession(session: CloudSession, key: Buffer, context: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}
export function decryptSession(value: string, key: Buffer, context: string): CloudSession {
  try {
    const bytes = Buffer.from(value, 'base64url'),
      cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(context));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(),
    );
  } catch {
    throw new DomainError('Please sign in again.', 401, 'UNAUTHENTICATED');
  }
}
