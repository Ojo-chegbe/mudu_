import { useEffect, useRef, useState } from 'react';
import type {
  AssessmentWizardDraft,
  SavedWizard,
  AuthoringOverview,
  AuthoringState,
  AuthoringDraftSummary,
} from '../../packages/contracts/cloud-authoring.ts';
import { api, ApiError, errorMessage } from './api.ts';
import { Dialog, Icon, Notice } from './ui.tsx';

export function useWizardSave(
  draft: AssessmentWizardDraft,
  initialRevision = 0,
  initialConflict = false,
) {
  const latest = useRef(draft),
    revision = useRef(initialRevision),
    last = useRef(''),
    flight = useRef<Promise<void> | null>(null),
    blocked = useRef(initialConflict),
    alive = useRef(true),
    stopped = useRef(false);
  const [message, setMessage] = useState(
      initialConflict
        ? 'This draft changed elsewhere. Your tab changes are kept. Reopen the saved draft to continue.'
        : '',
    ),
    [saving, setSaving] = useState(false),
    [saved, setSaved] = useState(false),
    [conflict, setConflict] = useState(initialConflict);
  latest.current = draft;
  async function save(): Promise<void> {
    if (flight.current) {
      await flight.current;
      return save();
    }
    if (stopped.current || latest.current.createdId || latest.current.accessMode === 'legacy')
      return;
    if (blocked.current)
      throw new ApiError(
        'Reopen the saved draft before continuing. Your tab changes are kept.',
        409,
      );
    const captured = latest.current,
      serialized = JSON.stringify(captured);
    if (last.current === serialized) return;
    setSaving(true);
    const run = (async () => {
      try {
        const result = await api<SavedWizard>(`/authoring/${captured.requestId}`, {
          method: 'PUT',
          body: { draft: captured, expectedRevision: revision.current },
        });
        revision.current = result.revision;
        last.current = serialized;
        try {
          sessionStorage.setItem(
            `mudu.authoring-revision.${captured.requestId}`,
            String(result.revision),
          );
        } catch {
          /* Server save remains durable. */
        }
        if (alive.current) {
          setSaved(true);
          setMessage('');
        }
        if (alive.current && !new URLSearchParams(location.search).get('draft'))
          history.replaceState(null, '', `/assessments/new?draft=${captured.requestId}`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          blocked.current = true;
          if (alive.current) setConflict(true);
        }
        if (alive.current) setMessage(errorMessage(e));
        throw e;
      } finally {
        if (alive.current) setSaving(false);
      }
    })();
    flight.current = run;
    try {
      await run;
    } finally {
      flight.current = null;
    }
  }
  const serialized = JSON.stringify(draft);
  useEffect(() => {
    if (
      draft.createdId ||
      draft.accessMode === 'legacy' ||
      blocked.current ||
      (initialRevision === 0 &&
        !saved &&
        !draft.details.title.trim() &&
        !draft.questions.some((q) => q.prompt.trim()))
    )
      return;
    const timer = setTimeout(() => {
      void save().catch(() => {});
    }, 1200);
    return () => clearTimeout(timer);
  }, [serialized, saved]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function discard() {
    stopped.current = true;
    try {
      await flight.current?.catch(() => {});
      if (revision.current > 0)
        await api(`/authoring/${draft.requestId}`, {
          method: 'DELETE',
          body: { expectedRevision: revision.current },
        });
    } catch (e) {
      stopped.current = false;
      throw e;
    }
  }
  return {
    save,
    discard,
    revision,
    saving,
    saved,
    message,
    conflict,
    dirty: last.current !== serialized,
  };
}
const labels: Record<AuthoringState, string> = {
  local: 'Saved on this Host',
  pending: 'Saved here · Sync pending',
  synced: 'Saved to cloud',
  offline: 'Saved here · Cloud unavailable',
  conflict: 'Cloud changes need review',
  setup: 'Cloud authoring needs setup',
  signin: 'Sign in to sync assessments',
  paused: 'Cloud updates wait until the exam ends',
  blocked: 'Assessment needs attention',
};
export function AuthoringSaveStatus({
  id,
  dirty = false,
  onResolved,
}: {
  id?: string;
  dirty?: boolean;
  onResolved?: () => void;
}) {
  const [overview, setOverview] = useState<AuthoringOverview | null>(null),
    [error, setError] = useState(''),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const running = useRef(false);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (running.current) return;
      running.current = true;
      try {
        const value = await api<AuthoringOverview>('/authoring/status');
        if (alive) setOverview(value);
      } catch (e) {
        if (alive) setError(errorMessage(e));
      } finally {
        running.current = false;
      }
    };
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id]);
  if (!overview?.enabled) return null;
  const rows = id ? overview.items.filter((r) => r.id === id) : overview.items;
  const state =
    overview.state ??
    (
      [
        'conflict',
        'blocked',
        'setup',
        'signin',
        'offline',
        'paused',
        'pending',
        'synced',
        'local',
      ] as AuthoringState[]
    ).find((s) => rows.some((r) => r.state === s)) ??
    'pending';
  const row = rows.find((r) => r.state === state);
  async function retry() {
    setBusy(true);
    setError('');
    try {
      setOverview(await api<AuthoringOverview>('/authoring/retry', { method: 'POST', body: {} }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className={`bank-cloud-status ${state === 'synced' ? 'is-synced' : ''}`} role="status">
        <span>
          <Icon name={state === 'synced' ? 'check' : 'clock'} size={16} />
          {dirty && state === 'synced' ? 'Unsaved changes' : labels[state]}
        </span>
        <div className="actions">
          {['offline', 'setup', 'pending', 'blocked'].includes(state) && (
            <button className="text-button" disabled={busy} onClick={() => void retry()}>
              {busy ? 'Checking…' : 'Retry sync'}
            </button>
          )}
          {state === 'conflict' &&
            (id ? (
              <button
                className="text-button"
                disabled={dirty || busy}
                onClick={() => setOpen(true)}
              >
                Review changes
              </button>
            ) : (
              <a href={`/assessments/new?draft=${row?.id}`}>Open affected draft</a>
            ))}
          {state === 'signin' && <a href="/account/sign-in">Sign in</a>}
          {id && rows.some((r) => r.recoveryAvailable) && (
            <a href={`/api/authoring/${id}/recovery`}>Download previous copy</a>
          )}
        </div>
      </div>
      {['conflict', 'blocked', 'setup'].includes(state) && (
        <p className="field-hint">
          {overview.message ?? row?.message}
          {dirty && state === 'conflict'
            ? ' Keep or download your tab changes before loading another copy.'
            : ''}
        </p>
      )}
      {id && rows.some((r) => r.deliveryReady === false) && (
        <Notice>
          This paper is available for editing here. Run it on its original Host until local delivery
          preparation is available.
        </Notice>
      )}
      {error && <Notice>{error}</Notice>}
      {open && (
        <Dialog
          title="Load the latest cloud copy?"
          confirmLabel="Use latest cloud copy"
          busy={busy}
          onClose={() => setOpen(false)}
          confirm={() => {
            setBusy(true);
            setError('');
            void api<AuthoringOverview>(`/authoring/${id}/resolve`, { method: 'POST', body: {} })
              .then((value) => {
                setOverview(value);
                setOpen(false);
                onResolved?.();
              })
              .catch((e) => setError(errorMessage(e)))
              .finally(() => setBusy(false));
          }}
        >
          <p>
            Your saved local copy will be retained as a private downloadable recovery file.
            Examination attempts and results will not be changed.
          </p>
          {error && <Notice>{error}</Notice>}
        </Dialog>
      )}
    </>
  );
}
export function ContinueDrafting() {
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<AuthoringDraftSummary[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const load = () =>
      void api<{ drafts: AuthoringDraftSummary[] }>('/authoring/drafts')
        .then((r) => {
          if (alive) {
            setItems(r.drafts);
            setError('');
          }
        })
        .catch((e) => {
          if (alive) setError(errorMessage(e));
        });
    load();
    const timer = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return (
    <>
      {error && <Notice>{error}</Notice>}
      {items.length > 0 && (
        <section className="authoring-drafts">
          <div className="section-heading">
            <h2>Continue drafting</h2>
            <span className="muted small">{items.length} unfinished</span>
            {items.length > 3 && (
              <button
                className="text-button"
                aria-expanded={expanded}
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? 'Show recent drafts' : `View all ${items.length} drafts`}
              </button>
            )}
          </div>
          <div className="authoring-draft-list">
            {(expanded ? items : items.slice(0, 3)).map((d) => (
              <a
                className="authoring-draft-item"
                href={`/assessments/new?draft=${d.id}`}
                key={d.id}
              >
                <div>
                  <strong>{d.title}</strong>
                  <span className="muted small">
                    {d.course || 'Assessment draft'} · Step {d.step + 1} of 4
                  </span>
                </div>
                <Icon name="arrow" size={17} />
              </a>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
