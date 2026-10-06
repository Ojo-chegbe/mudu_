import type { ExamStore, Session } from './store.ts';
import type { AccountPreferences, AccountProfile } from '../../packages/contracts/http.ts';
import { IdentityService } from './identity.ts';
import { DomainError } from '../../packages/exam-core/model.ts';

export const defaultPreferences: AccountPreferences = {
  textSize: 'normal',
  reducedMotion: 'system',
  notificationBadge: true,
};
export function preferences(store: ExamStore, session?: Session): AccountPreferences {
  if (!session) return { ...defaultPreferences };
  const row = store.db
    .prepare('SELECT * FROM account_preferences WHERE principal_id=? AND role=?')
    .get(session.principal_id, session.role);
  return row
    ? {
        textSize: row.text_size as AccountPreferences['textSize'],
        reducedMotion: row.reduced_motion as AccountPreferences['reducedMotion'],
        notificationBadge: row.notification_badge === 1,
      }
    : { ...defaultPreferences };
}
export function savePreferences(
  store: ExamStore,
  session: Session,
  input: Record<string, unknown>,
) {
  if (
    !['normal', 'large'].includes(String(input.textSize)) ||
    !['system', 'reduce'].includes(String(input.reducedMotion)) ||
    typeof input.notificationBadge !== 'boolean'
  )
    throw new DomainError('Choose valid display and notification preferences.', 400);
  store.db
    .prepare(
      'INSERT INTO account_preferences(principal_id,role,text_size,reduced_motion,notification_badge) VALUES(?,?,?,?,?) ON CONFLICT(role,principal_id) DO UPDATE SET text_size=excluded.text_size,reduced_motion=excluded.reduced_motion,notification_badge=excluded.notification_badge',
    )
    .run(
      session.principal_id,
      session.role,
      input.textSize as string,
      input.reducedMotion as string,
      input.notificationBadge ? 1 : 0,
    );
  return preferences(store, session);
}
export function accountProfile(
  store: ExamStore,
  session: Session,
  canEditName: boolean,
): AccountProfile {
  const db = store.db;
  if (session.role === 'candidate') {
    if (!session.account_id)
      throw new DomainError('Sign in with your MUDU account to open Profile.', 403);
    const candidate = new IdentityService(store).profile(session.account_id);
    const connected = Boolean(
      db
        .prepare('SELECT 1 FROM candidate_provider_identities WHERE account_id=?')
        .get(session.account_id),
    );
    return {
      name: candidate.name,
      email: candidate.email,
      role: 'candidate',
      connected,
      emailVerified: connected,
      hostOperator: false,
      canEditName,
      candidate,
    };
  }
  const row = db
    .prepare(
      'SELECT a.name,a.singleton,p.email FROM administrators a LEFT JOIN admin_provider_identities p ON p.administrator_id=a.id WHERE a.id=?',
    )
    .get(session.principal_id);
  if (!row) throw new DomainError('Please sign in again.', 401);
  return {
    name: String(row.name),
    email: row.email ? String(row.email) : null,
    role: 'admin',
    connected: Boolean(row.email),
    emailVerified: Boolean(row.email),
    hostOperator: row.singleton === 1,
    canEditName,
  };
}
