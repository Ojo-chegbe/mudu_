import type { ExamStore } from './store.ts';
import type { CloudAdministrators } from './cloud-administrators.ts';
import type { WorkspaceConnectionState } from '../../packages/contracts/http.ts';
import { digest } from './security.ts';
import { DomainError } from '../../packages/exam-core/model.ts';

// Connection mode never creates an identity or replaces a session cookie.
export class WorkspaceConnection {
  private store: ExamStore;
  private cloud: CloudAdministrators | null;
  constructor(store: ExamStore, cloud: CloudAdministrators | null) {
    this.store = store;
    this.cloud = cloud;
  }
  hasGrant(raw: string) {
    const session = this.store.session(raw);
    return Boolean(
      session?.role === 'admin' &&
      this.store.db
        .prepare(
          'SELECT 1 FROM admin_device_access d JOIN admin_provider_identities p ON p.administrator_id=d.administrator_id WHERE d.administrator_id=?',
        )
        .get(session.principal_id),
    );
  }
  status(raw: string): WorkspaceConnectionState {
    const db = this.store.db,
      session = this.store.session(raw);
    const provider =
      session && db.prepare('SELECT 1 FROM provider_sessions WHERE token_hash=?').get(digest(raw));
    const row =
      session &&
      db
        .prepare('SELECT mode,state FROM workspace_connections WHERE token_hash=?')
        .get(digest(raw));
    return {
      mode: row?.mode === 'offline' ? 'offline' : 'auto',
      state: provider
        ? row?.state === 'offline'
          ? 'offline'
          : 'online'
        : this.hasGrant(raw)
          ? 'offline'
          : 'local',
      offlineEnabled: this.hasGrant(raw),
      needsOnlineSignIn: Boolean(session && this.hasGrant(raw) && !provider),
    };
  }
  online(raw: string) {
    return this.status(raw).state === 'online';
  }
  private save(raw: string, mode: 'auto' | 'offline', state: 'online' | 'offline') {
    if (!this.store.session(raw))
      throw new DomainError('Please sign in again.', 401, 'UNAUTHENTICATED');
    this.store.db
      .prepare(
        'INSERT INTO workspace_connections VALUES(?,?,?,?) ON CONFLICT(token_hash) DO UPDATE SET mode=excluded.mode,state=excluded.state,checked_at=excluded.checked_at',
      )
      .run(digest(raw), mode, state, this.store.now());
  }
  async verify(raw: string, allowOffline: boolean, force = false) {
    const db = this.store.db;
    const row = db
      .prepare('SELECT mode,state,checked_at FROM workspace_connections WHERE token_hash=?')
      .get(digest(raw));
    const grant = allowOffline && this.hasGrant(raw);
    if (grant && row?.mode === 'offline') return false;
    if (
      grant &&
      row?.state === 'offline' &&
      !force &&
      this.store.now() - Number(row.checked_at) < 15000
    )
      return false;
    if (!this.cloud) throw new DomainError('Online account access is unavailable.', 503);
    try {
      await this.cloud.verify(raw);
      if (
        allowOffline &&
        this.hasGrant(raw) &&
        db.prepare('SELECT mode FROM workspace_connections WHERE token_hash=?').get(digest(raw))
          ?.mode === 'offline'
      )
        return false;
      this.save(raw, 'auto', 'online');
      return true;
    } catch (error) {
      // Revocation, expiry, rate limits and identity errors never become offline authorization.
      if (!(error instanceof DomainError) || error.status !== 503) throw error;
      if (
        allowOffline &&
        this.hasGrant(raw) &&
        db.prepare('SELECT mode FROM workspace_connections WHERE token_hash=?').get(digest(raw))
          ?.mode === 'offline'
      )
        return false;
      this.save(raw, 'auto', 'offline');
      if (!allowOffline || !this.hasGrant(raw)) throw error;
      return false;
    }
  }
  async change(raw: string, mode: unknown, allowOffline: boolean) {
    if (mode !== 'auto' && mode !== 'offline')
      throw new DomainError('Choose automatic or offline mode.', 400);
    if (mode === 'offline') {
      if (!allowOffline || !this.hasGrant(raw))
        throw new DomainError('Enable offline access on this trusted Host first.', 409);
      this.save(raw, 'offline', 'offline');
    } else {
      this.save(raw, 'auto', 'online');
      if (
        this.store.db.prepare('SELECT 1 FROM provider_sessions WHERE token_hash=?').get(digest(raw))
      )
        await this.verify(raw, allowOffline, true);
    }
    return this.status(raw);
  }
}
