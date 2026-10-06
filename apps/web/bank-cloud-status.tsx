import { useEffect, useRef, useState } from 'react';
import type { CloudBankStatus } from '../../packages/contracts/cloud-question-bank.ts';
import { api, ApiError, errorMessage } from './api.ts';
import { Dialog, Icon, Notice } from './ui.tsx';

export const bankCloudUpdated = 'mudu:bank-cloud-updated';
export function BankCloudStatus() {
  const [status, setStatus] = useState<CloudBankStatus | null>(null);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [choice, setChoice] = useState<'both' | 'cloud'>('both');
  const alive = useRef(true),
    loading = useRef(false),
    revision = useRef<number | null>(null);
  async function refresh() {
    if (loading.current) return;
    loading.current = true;
    try {
      const value = await api<CloudBankStatus>('/question-bank/cloud/status', { timeoutMs: 60000 });
      if (!alive.current) return;
      setStatus(value);
      if (revision.current !== null && value.revision !== revision.current)
        window.dispatchEvent(new Event(bankCloudUpdated));
      revision.current = value.revision;
    } catch (error) {
      if (alive.current)
        setStatus({
          state: error instanceof ApiError && error.status === 401 ? 'signin' : 'offline',
          revision: revision.current ?? 0,
          lastSyncedAt: null,
          message: 'Cloud is unavailable. Your saved questions remain on this computer.',
        });
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
  async function resolve() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api('/question-bank/cloud/resolve', {
        method: 'POST',
        body: { choice },
        timeoutMs: 60000,
      });
      setOpen(false);
      // Only this explicit recovery action reloads the page. Background updates never discard an editor draft.
      location.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (!status) return null;
  const label =
    status.state === 'synced'
      ? 'Saved to cloud'
      : status.state === 'pending'
        ? 'Saved here · Sync pending'
        : status.state === 'conflict'
          ? 'Cloud changes need review'
          : status.state === 'setup'
            ? 'Saved here · Cloud setup needed'
            : status.state === 'paused'
              ? 'Saved here · Sync after exam'
              : status.state === 'signin'
                ? 'Saved here · Cloud sign-in needed'
                : 'Saved on this computer';
  return (
    <>
      <div className={`bank-cloud-status ${status.state}`} role="status">
        <Icon name={status.state === 'synced' ? 'check' : 'server'} size={15} />
        <span title={status.message ?? undefined}>{label}</span>
        {status.state === 'conflict' && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setError('');
              setOpen(true);
            }}
          >
            Review changes
          </button>
        )}
        {status.state === 'offline' && (
          <button type="button" className="text-button" onClick={() => void refresh()}>
            Retry
          </button>
        )}
        {status.state === 'signin' && <a href="/account/sign-in?return=/question-bank">Sign in</a>}
        {status.recoveryAvailable && (
          <a href="/api/question-bank/cloud/recovery">Download recovery copy</a>
        )}
      </div>
      {status.state === 'setup' && (
        <Notice kind="info">
          Cloud question-bank storage needs the new database update. Your local questions are
          unchanged.
        </Notice>
      )}
      {open && (
        <Dialog
          title="Keep your question-bank changes safe"
          confirmLabel={choice === 'both' ? 'Keep both copies' : 'Use cloud version'}
          busy={busy}
          onClose={() => setOpen(false)}
          confirm={() => void resolve()}
        >
          <p>
            This computer and the cloud have different changes. Neither copy has been overwritten.
          </p>
          <label className="check-label bank-cloud-choice">
            <input
              type="radio"
              name="bank-recovery"
              checked={choice === 'both'}
              onChange={() => setChoice('both')}
              disabled={busy}
            />
            <span>
              <strong>Keep both copies</strong>
              <span className="field-hint">
                Use the cloud bank and put this computer’s differing questions in recovered
                projects.
              </span>
            </span>
          </label>
          <label className="check-label bank-cloud-choice">
            <input
              type="radio"
              name="bank-recovery"
              checked={choice === 'cloud'}
              onChange={() => setChoice('cloud')}
              disabled={busy}
            />
            <span>
              <strong>Use cloud version</strong>
              <span className="field-hint">
                Use the cloud bank here. A recovery copy of your local bank will be retained.
              </span>
            </span>
          </label>
          <p className="field-hint">
            Your existing assessments and their question papers will not change.
          </p>
          {error && <Notice>{error}</Notice>}
        </Dialog>
      )}
    </>
  );
}
