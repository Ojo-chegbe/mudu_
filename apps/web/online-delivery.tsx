import { useEffect, useState } from 'react';
import { api, errorMessage } from './api.ts';
import { Dialog, Notice } from './ui.tsx';

export function OnlineDelivery({ id }: { id: string }) {
  const [status, setStatus] = useState<{ enabled: boolean; published: boolean } | null>(null);
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [copied, setCopied] = useState(false);
  const link = `${location.origin}/exam/online/${id}`;
  useEffect(() => {
    let alive = true;
    api<{ enabled: boolean; published: boolean }>(`/assessments/${id}/online`)
      .then((value) => {
        if (alive) setStatus(value);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id]);
  if (!status?.enabled) return null;
  return (
    <section className="assessment-delivery-row">
      <div className="assessment-delivery-heading">
        <div>
          <h3>Online examination</h3>
          <p className="muted small">
            {status.published
              ? 'Published · Internet required'
              : 'Candidates take this examination over the internet.'}
          </p>
        </div>
        {status.published ? (
          <a className="button primary" href={`/online/assessments/${id}`}>
            Open online examination
          </a>
        ) : (
          <button className="button secondary" onClick={() => setConfirm(true)}>
            Publish online
          </button>
        )}
      </div>
      {status.published && (
        <>
          <label>
            Candidate address
            <input readOnly value={link} onFocus={(e) => e.target.select()} />
          </label>
          <button
            className="text-button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link);
                setCopied(true);
              } catch {
                setError('Select the address above and copy it.');
              }
            }}
          >
            {copied ? 'Link copied' : 'Copy link'}
          </button>
          {['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && (
            <p className="field-hint">
              This is a test address on this computer. Use your public application address before
              sharing.
            </p>
          )}
        </>
      )}
      {error && <Notice>{error}</Notice>}
      {confirm && (
        <Dialog
          title="Publish this examination online?"
          confirmLabel="Publish online"
          busy={busy}
          onClose={() => {
            if (!busy) setConfirm(false);
          }}
          confirm={async () => {
            setBusy(true);
            setError('');
            try {
              await api(`/assessments/${id}/online`, { method: 'POST', body: {} });
              location.href = `/online/assessments/${id}`;
            } catch (error) {
              setError(errorMessage(error));
              setConfirm(false);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p>This publishes the approved candidate list and freezes the question paper.</p>
          <p>
            Shared examination timers start immediately; individual timers begin when each candidate
            starts.
          </p>
        </Dialog>
      )}
    </section>
  );
}
