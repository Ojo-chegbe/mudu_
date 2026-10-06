import type { ExamStore } from './store.ts';
import type { CloudAuthProvider } from './supabase-auth.ts';
import { encryptSession, decryptSession } from './supabase-auth.ts';
import { digest, token } from './security.ts';
import { transaction } from './database.ts';
import { DomainError } from '../../packages/exam-core/model.ts';

export class PasswordRecovery {
  private busy = new Set<string>();
  private store: ExamStore;
  private provider: CloudAuthProvider;
  private key: Buffer;
  constructor(store: ExamStore, provider: CloudAuthProvider, key: Buffer) {
    this.store = store;
    this.provider = provider;
    this.key = key;
  }
  async open(tokenHash: string, existingRaw = '') {
    if (!this.provider.verifyRecovery)
      throw new DomainError('Account recovery is unavailable.', 503);
    // A lost verification response can be retried only by the browser holding its grant.
    const existing = this.store.db
      .prepare(
        'SELECT * FROM password_recovery WHERE token_hash=? AND proof_hash=? AND expires_at>?',
      )
      .get(digest(existingRaw), digest(tokenHash), this.store.now());
    if (existing)
      return {
        raw: existingRaw,
        csrf: String(existing.csrf),
        expiresAt: Number(existing.expires_at),
      };
    const identity = await this.provider.verifyRecovery(tokenHash);
    const raw = token(),
      hash = digest(raw),
      csrf = token();
    const expiresAt = Math.min(this.store.now() + 10 * 60000, identity.expiresAt);
    transaction(this.store.db, () => {
      this.store.db
        .prepare('DELETE FROM password_recovery WHERE expires_at<=? OR provider_user_id=?')
        .run(this.store.now(), identity.userId);
      this.store.db
        .prepare('INSERT INTO password_recovery VALUES(?,?,?,?,?,?,0)')
        .run(
          hash,
          identity.userId,
          digest(tokenHash),
          encryptSession(identity, this.key, 'recovery:' + hash),
          csrf,
          expiresAt,
        );
    });
    return { raw, csrf, expiresAt };
  }
  state(raw: string) {
    const row = this.store.db
      .prepare('SELECT * FROM password_recovery WHERE token_hash=? AND expires_at>?')
      .get(digest(raw), this.store.now());
    if (!row)
      throw new DomainError(
        'This reset session has expired. Request a new link.',
        401,
        'RECOVERY_EXPIRED',
      );
    return row;
  }
  async complete(raw: string, csrf: string, password: string) {
    const hash = digest(raw),
      row = this.state(raw);
    if (!csrf || row.csrf !== csrf)
      throw new DomainError('Request verification failed. Refresh and try again.', 403);
    if (row.completed === 1) return;
    if (row.completed === 2)
      throw new DomainError(
        'A password change is in progress or was interrupted. Try signing in with your new password, or request another reset link.',
        409,
        'RECOVERY_UNCERTAIN',
      );
    if (this.busy.has(hash))
      throw new DomainError('Your password change is already in progress. Please wait.', 409);
    if (!this.provider.resetPassword)
      throw new DomainError('Account recovery is unavailable.', 503);
    this.busy.add(hash);
    try {
      const identity = decryptSession(String(row.encrypted_session), this.key, 'recovery:' + hash);
      transaction(this.store.db, () => {
        const claimed = this.store.db
          .prepare(
            'UPDATE password_recovery SET completed=2 WHERE token_hash=? AND completed=0 AND expires_at>?',
          )
          .run(hash, this.store.now());
        if (!claimed.changes)
          throw new DomainError(
            'This reset session is no longer available. Request a new link.',
            401,
            'RECOVERY_EXPIRED',
          );
        // Revoke local sessions for both roles by explicit provider bindings, never email matching.
        // Commit before the network mutation: a crash must not restore old local sessions.
        this.store.db
          .prepare(
            `DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM provider_sessions WHERE provider_user_id=?)
          OR (role='admin' AND principal_id IN (SELECT administrator_id FROM admin_provider_identities WHERE provider_user_id=?))
          OR (role='candidate' AND account_id IN (SELECT account_id FROM candidate_provider_identities WHERE provider_user_id=?))`,
          )
          .run(identity.userId, identity.userId, identity.userId);
        this.store.event(null, identity.userId, 'cloud_password_reset_started');
      });
      await this.provider.resetPassword(identity, password);
      transaction(this.store.db, () => {
        this.store.db
          .prepare(
            'UPDATE password_recovery SET completed=1, encrypted_session=? WHERE token_hash=?',
          )
          .run('', hash);
        this.store.event(null, identity.userId, 'cloud_password_reset');
      });
    } catch (error) {
      // A known rejection is retryable. An uncertain network outcome must not replay a change.
      if (error instanceof DomainError && [400, 429].includes(error.status))
        this.store.db
          .prepare('UPDATE password_recovery SET completed=0 WHERE token_hash=? AND completed=2')
          .run(hash);
      if (!(error instanceof DomainError && [400, 429, 401].includes(error.status)))
        throw new DomainError(
          'Could not confirm your password change. Try signing in with your new password, or request another reset link.',
          503,
          'RECOVERY_UNCERTAIN',
        );
      throw error;
    } finally {
      this.busy.delete(hash);
    }
  }
}
