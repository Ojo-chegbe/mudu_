import { randomUUID } from 'node:crypto';
import type { ExamStore } from './store.ts';
import type { CloudAuthProvider, CloudSession } from './supabase-auth.ts';
import { decryptSession, encryptSession } from './supabase-auth.ts';
import { transaction } from './database.ts';
import { digest } from './security.ts';
import { DomainError } from '../../packages/exam-core/model.ts';

export class CloudAdministrators {
  store: ExamStore;
  provider: CloudAuthProvider;
  key: Buffer;
  private inFlight = new Map<string, Promise<void>>();
  constructor(store: ExamStore, provider: CloudAuthProvider, key: Buffer) {
    this.store = store;
    this.provider = provider;
    this.key = key;
  }
  open(identity: CloudSession, existing?: string, claimHost = false) {
    return transaction(this.store.db, () => {
      const db = this.store.db;
      let binding = db
        .prepare('SELECT administrator_id FROM admin_provider_identities WHERE provider_user_id=?')
        .get(identity.userId);
      if (existing && binding && binding.administrator_id !== existing) {
        const other = String(binding.administrator_id);
        const occupied = db
          .prepare(
            `SELECT 1 FROM assessment_owners WHERE owner_id=? UNION ALL SELECT 1 FROM rosters WHERE owner_id=? UNION ALL SELECT 1 FROM bank_projects WHERE owner_id=? UNION ALL SELECT 1 FROM authoring_drafts WHERE owner_id=? LIMIT 1`,
          )
          .get(other, other, other, other);
        if (occupied)
          throw new DomainError(
            'That cloud account already owns a workspace. Use another account to connect this local workspace; no data has been moved.',
            409,
          );
        db.prepare("DELETE FROM sessions WHERE role='admin' AND principal_id=?").run(other);
        db.prepare('DELETE FROM admin_provider_identities WHERE administrator_id=?').run(other);
        db.prepare('DELETE FROM administrators WHERE id=? AND singleton IS NULL').run(other);
        binding = undefined;
      }
      let id = existing ?? (binding ? String(binding.administrator_id) : randomUUID());
      if (!binding) {
        if (!existing)
          db.prepare('INSERT INTO administrators VALUES(?,?,?,NULL)').run(
            id,
            identity.name || identity.email,
            'supabase-managed',
          );
        if (db.prepare('SELECT 1 FROM admin_provider_identities WHERE administrator_id=?').get(id))
          throw new DomainError('This workspace is already connected to a cloud account.', 409);
        db.prepare('INSERT INTO admin_provider_identities VALUES(?,?,?)').run(
          id,
          identity.userId,
          identity.email,
        );
      }
      if (claimHost && !db.prepare('SELECT 1 FROM administrators WHERE singleton=1').get())
        db.prepare('UPDATE administrators SET singleton=1 WHERE id=?').run(id);
      db.prepare(
        'UPDATE admin_provider_identities SET email=? WHERE administrator_id=? AND provider_user_id=?',
      ).run(identity.email, id, identity.userId);
      if (identity.name)
        db.prepare('UPDATE administrators SET name=? WHERE id=?').run(identity.name, id);
      db.prepare("DELETE FROM sessions WHERE role='admin' AND principal_id=?").run(id);
      const session = this.store.createSession('admin', id, null);
      const hash = digest(session.raw);
      db.prepare('INSERT INTO provider_sessions VALUES(?,?,?,?,?)').run(
        hash,
        identity.userId,
        encryptSession(identity, this.key, hash),
        '',
        identity.expiresAt,
      );
      this.store.event(null, id, existing ? 'workspace_cloud_connected' : 'cloud_admin_signed_in');
      return session;
    });
  }
  async verify(raw: string) {
    const hash = digest(raw);
    return this.verifyHash(hash);
  }
  private async verifyHash(hash: string) {
    const row = this.store.db
      .prepare(
        `SELECT p.*,s.principal_id,CASE s.role WHEN 'admin' THEN b.provider_user_id WHEN 'candidate' THEN c.provider_user_id END AS bound_user
        FROM provider_sessions p JOIN sessions s ON s.token_hash=p.token_hash
        LEFT JOIN admin_provider_identities b ON b.administrator_id=s.principal_id AND s.role='admin'
        LEFT JOIN candidate_provider_identities c ON c.account_id=s.account_id AND s.role='candidate'
        WHERE p.token_hash=? AND s.expires_at>?`,
      )
      .get(hash, this.store.now());
    if (!row) {
      if (this.store.db.prepare('SELECT 1 FROM provider_sessions WHERE token_hash=?').get(hash)) {
        this.store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash);
        throw new DomainError('Please sign in again.', 401, 'UNAUTHENTICATED');
      }
      return;
    }
    if (this.inFlight.has(hash)) return await this.inFlight.get(hash);
    const check = async () => {
      const identity = decryptSession(String(row.access_token), this.key, hash);
      if (identity.userId !== row.provider_user_id || identity.userId !== row.bound_user)
        throw new DomainError('Please sign in again.', 401, 'UNAUTHENTICATED');
      const verified = await this.provider.verify(identity);
      if (verified.userId !== identity.userId)
        throw new DomainError('Please sign in again.', 401, 'UNAUTHENTICATED');
      this.store.db
        .prepare(
          'UPDATE provider_sessions SET access_token=?,expires_at=? WHERE token_hash=? AND access_token=?',
        )
        .run(encryptSession(verified, this.key, hash), verified.expiresAt, hash, row.access_token);
    };
    const promise = check()
      .catch((error) => {
        if (error instanceof DomainError && error.status === 401)
          this.store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash);
        throw error;
      })
      .finally(() => this.inFlight.delete(hash));
    this.inFlight.set(hash, promise);
    await promise;
  }
  async credentials(administratorId: string, providerUserId?: string) {
    return this.principalCredentials(administratorId, 'admin', providerUserId);
  }
  async currentCredentials(raw: string) {
    await this.verify(raw);
    const hash = digest(raw);
    const row = this.store.db
      .prepare('SELECT access_token FROM provider_sessions WHERE token_hash=?')
      .get(hash);
    if (!row) throw new DomainError('Sign in online to change your account.', 401);
    return decryptSession(String(row.access_token), this.key, hash);
  }
  retainCurrentCredentials(raw: string, identity: CloudSession) {
    const hash = digest(raw),
      row = this.store.db
        .prepare('SELECT provider_user_id FROM provider_sessions WHERE token_hash=?')
        .get(hash);
    if (!row || row.provider_user_id !== identity.userId || !this.store.session(raw))
      throw new DomainError('Please sign in again.', 401);
    this.store.db
      .prepare('UPDATE provider_sessions SET access_token=?,expires_at=? WHERE token_hash=?')
      .run(encryptSession(identity, this.key, hash), identity.expiresAt, hash);
  }
  async candidateCredentials(accountId: string) {
    return this.principalCredentials(accountId, 'candidate');
  }
  private async principalCredentials(
    principalId: string,
    role: 'admin' | 'candidate',
    providerUserId?: string,
  ) {
    const row = this.store.db
      .prepare(
        `SELECT p.token_hash,p.provider_user_id FROM provider_sessions p
      JOIN sessions s ON s.token_hash=p.token_hash WHERE s.principal_id=? AND s.role=? AND s.expires_at>?
      AND NOT EXISTS (SELECT 1 FROM workspace_connections w WHERE w.token_hash=s.token_hash AND (w.mode='offline' OR w.state='offline'))
      ORDER BY s.expires_at DESC LIMIT 1`,
      )
      .get(principalId, role, this.store.now());
    if (
      !row &&
      this.store.db
        .prepare(
          `SELECT 1 FROM provider_sessions p JOIN sessions s ON s.token_hash=p.token_hash JOIN workspace_connections w ON w.token_hash=s.token_hash WHERE s.principal_id=? AND s.role=? AND s.expires_at>? AND (w.mode='offline' OR w.state='offline')`,
        )
        .get(principalId, role, this.store.now())
    )
      throw new DomainError(
        'Cloud synchronization is paused while this workspace is offline.',
        503,
        'WORKSPACE_OFFLINE',
      );
    if (!row || (providerUserId && row.provider_user_id !== providerUserId))
      throw new DomainError(
        'Sign in to your cloud account to synchronize your records.',
        401,
        'UNAUTHENTICATED',
      );
    const hash = String(row.token_hash);
    await this.verifyHash(hash);
    const current = this.store.db
      .prepare('SELECT access_token FROM provider_sessions WHERE token_hash=?')
      .get(hash);
    if (!current)
      throw new DomainError('Sign in to your cloud account again.', 401, 'UNAUTHENTICATED');
    return decryptSession(String(current.access_token), this.key, hash);
  }
}
