import { useEffect, useRef, useState } from 'react';
import type {
  RosterCloudOverview,
  RosterCloudState,
} from '../../packages/contracts/cloud-rosters.ts';
import { api, errorMessage } from './api.ts';
import { Dialog, Icon, Notice } from './ui.tsx';

export const rosterCloudUpdated = 'mudu:rosters-cloud-updated';
const labels: Record<RosterCloudState, string> = {
  local: 'Saved on this Host',
  pending: 'Saved here · Sync pending',
  synced: 'Saved to cloud',
  offline: 'Saved here · Cloud unavailable',
  conflict: 'Cloud changes need review',
  setup: 'Cloud rosters need setup',
  paused: 'Cloud updates wait until the exam ends',
  signin: 'Sign in to sync rosters',
  connection: 'Candidate accounts need connecting',
  blocked: 'Roster needs attention',
};
export function RosterCloudStatus({ id, dirty = false }: { id?: string; dirty?: boolean }) {
  const [overview, setOverview] = useState<RosterCloudOverview | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [open, setOpen] = useState(false),
    [recovered, setRecovered] = useState(false);
  const loading = useRef(false),
    alive = useRef(true),
    versions = useRef<string | null>(null);
  async function refresh() {
    if (loading.current) return;
    loading.current = true;
    try {
      const value = await api<RosterCloudOverview>('/rosters/cloud/status');
      if (!alive.current) return;
      setOverview(value);
      const next = JSON.stringify(value.rosters.map((r) => [r.id, r.revision]));
      if (versions.current !== null && next !== versions.current)
        window.dispatchEvent(new Event(rosterCloudUpdated));
      versions.current = next;
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
    } finally {
      loading.current = false;
    }
  }
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 5000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, []);
  if (!overview?.enabled) return null;
  const rows = id ? overview.rosters.filter((r) => r.id === id) : overview.rosters;
  const priority: RosterCloudState[] = [
    'conflict',
    'connection',
    'blocked',
    'setup',
    'signin',
    'offline',
    'paused',
    'pending',
    'synced',
    'local',
  ];
  const state = overview.state ?? priority.find((s) => rows.some((r) => r.state === s)) ?? 'synced';
  const problem = rows.find((r) => r.state === state);
  async function retry() {
    setBusy(true);
    setError('');
    try {
      await api('/rosters/cloud/retry', { method: 'POST', body: {} });
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function resolve() {
    if (!id) return;
    setBusy(true);
    setError('');
    try {
      await api(`/rosters/${id}/cloud/resolve`, { method: 'POST', body: {} });
      setOpen(false);
      setRecovered(true);
      await refresh();
      window.dispatchEvent(new Event(rosterCloudUpdated));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div
        className={`bank-cloud-status roster-cloud-status ${state === 'synced' ? 'is-synced' : ''}`}
        role="status"
      >
        <span>
          <Icon name={state === 'synced' ? 'check' : 'clock'} size={16} />
          {labels[state]}
        </span>
        <div className="actions">
          {state === 'conflict' &&
            (id ? (
              <button
                className="text-button"
                disabled={busy || dirty}
                onClick={() => setOpen(true)}
              >
                Review changes
              </button>
            ) : (
              <a href={`/rosters/${problem?.id}`}>Open roster</a>
            ))}
          {['offline', 'pending', 'setup', 'connection', 'blocked'].includes(state) && (
            <button className="text-button" disabled={busy} onClick={() => void retry()}>
              {busy ? 'Checking…' : 'Retry sync'}
            </button>
          )}
          {state === 'signin' && <a href="/account/sign-in?return=/rosters">Sign in</a>}
          {(recovered || rows.some((r) => r.recoveryAvailable)) && id && (
            <a href={`/api/rosters/${id}/cloud/recovery`}>Download previous copy</a>
          )}
        </div>
      </div>
      {['connection', 'setup', 'conflict', 'blocked'].includes(state) && (
        <p className="field-hint roster-cloud-explanation">
          {overview.message ?? problem?.message ?? 'Your changes remain saved on this Host.'}
          {dirty && state === 'conflict'
            ? ' Discard unsaved form changes before reviewing the cloud copy.'
            : ''}
        </p>
      )}
      {error && <Notice>{error}</Notice>}
      {open && (
        <Dialog
          title="Use the latest roster?"
          confirmLabel="Use latest cloud copy"
          busy={busy}
          onClose={() => setOpen(false)}
          confirm={() => void resolve()}
        >
          <p>
            The cloud has newer membership or settings changes. This will load that copy without
            combining conflicting approvals.
          </p>
          <p className="muted small">
            Your current saved roster will be retained as a downloadable recovery copy. Existing
            examination attempts and results will not be removed.
          </p>
          {error && <Notice>{error}</Notice>}
        </Dialog>
      )}
    </>
  );
}
