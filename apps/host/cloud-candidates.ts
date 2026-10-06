import { randomUUID } from 'node:crypto';
import { DomainError } from '../../packages/exam-core/model.ts';
import { transaction } from './database.ts';
import { digest } from './security.ts';
import type { ExamStore } from './store.ts';
import { encryptSession } from './supabase-auth.ts';
import type { CloudSession } from './supabase-auth.ts';

// Provider UUID is the portable identity. Local UUIDs and every existing exam
// reference remain unchanged when an established account is explicitly linked.
export class CloudCandidates {
  store: ExamStore;
  key: Buffer;
  constructor(store: ExamStore, key: Buffer) {
    this.store = store;
    this.key = key;
  }
  open(identity: CloudSession, existing?: string) {
    return transaction(this.store.db, () => {
      const db = this.store.db;
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(identity.userId))
        throw new DomainError('Please sign in again.', 401);
      const binding = db
        .prepare('SELECT account_id FROM candidate_provider_identities WHERE provider_user_id=?')
        .get(identity.userId);
      if (existing) {
        const local = db.prepare('SELECT email FROM accounts WHERE id=?').get(existing);
        if (!local || local.email !== identity.email)
          throw new DomainError(
            'Use the same email address as your existing candidate account.',
            409,
          );
        if (binding && binding.account_id !== existing)
          throw new DomainError(
            'That cloud identity is already connected to another candidate account. No accounts were merged.',
            409,
          );
        const linked = db
          .prepare('SELECT provider_user_id FROM candidate_provider_identities WHERE account_id=?')
          .get(existing);
        if (linked && linked.provider_user_id !== identity.userId)
          throw new DomainError(
            'This candidate account is already connected to a different cloud identity.',
            409,
          );
      }
      const id = existing ?? (binding ? String(binding.account_id) : identity.userId);
      if (!binding && !existing) {
        if (db.prepare('SELECT 1 FROM accounts WHERE email=? OR id=?').get(identity.email, id))
          throw new DomainError(
            'An account already exists on this Host. Sign in using your local password, then connect that account. Your enrolments will be kept.',
            409,
            'CANDIDATE_LINK_REQUIRED',
          );
        db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?)').run(
          id,
          identity.email,
          identity.name || identity.email,
          'supabase-managed',
          this.store.now(),
        );
        db.prepare('INSERT INTO memberships VALUES(?,?,?,?,?,NULL)').run(
          randomUUID(),
          id,
          'default',
          `ACCOUNT-${id.toUpperCase()}`,
          'pending',
        );
      }
      if (!binding)
        db.prepare('INSERT INTO candidate_provider_identities VALUES(?,?)').run(
          id,
          identity.userId,
        );
      // Provider email updates must never take over another local account.
      if (db.prepare('SELECT 1 FROM accounts WHERE email=? AND id<>?').get(identity.email, id))
        throw new DomainError(
          'This email is already attached to another candidate account. Contact the organiser.',
          409,
        );
      db.prepare('UPDATE accounts SET email=? WHERE id=?').run(identity.email, id);
      const session = this.store.createSession('candidate', id, null, id);
      const hash = digest(session.raw);
      db.prepare('INSERT INTO provider_sessions VALUES(?,?,?,?,?)').run(
        hash,
        identity.userId,
        encryptSession(identity, this.key, hash),
        '',
        identity.expiresAt,
      );
      this.store.event(
        null,
        id,
        existing ? 'candidate_cloud_connected' : 'cloud_candidate_signed_in',
      );
      return session;
    });
  }
}
