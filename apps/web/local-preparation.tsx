import { useEffect, useState } from 'react';
import type {
  CandidateLocalPass,
  LocalExamPass,
  LocalPreparationStatus,
} from '../../packages/contracts/local-preparation.ts';
import { api, errorMessage, setCsrf } from './api.ts';
import { Icon, FormDialog as Modal, Notice } from './ui.tsx';
import { ScheduleField } from './timing-fields.tsx';

function savePass(pass: LocalExamPass) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(pass)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  const title =
    pass.title
      .replace(/[^a-z0-9_-]+/gi, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 100) || 'examination';
  link.download = `${title}.mudu-access`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function LocalPassSignIn({ onLogin }: { onLogin: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <section className="portal-auth panel padded">
      <span className="eyebrow">LOCAL EXAMINATION</span>
      <h1>Open your examination.</h1>
      <p className="muted small">
        Choose the access file you saved from your account before joining the examination Wi-Fi.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!file || busy) return;
          setBusy(true);
          setError('');
          try {
            if (file.size > 16384)
              throw new Error('Choose your examination access file, not a document.');
            let input: unknown;
            try {
              input = JSON.parse(await file.text());
            } catch {
              throw new Error(
                'This file could not be read. Choose the original examination access file.',
              );
            }
            const result = await api<{ csrf: string; runId: string }>('/local-admission/login', {
              method: 'POST',
              body: input,
            });
            setCsrf(result.csrf);
            history.replaceState(null, '', `/exam/assessments/${result.runId}`);
            await onLogin();
          } catch (error) {
            setError(errorMessage(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Examination access file
          <input
            type="file"
            accept=".mudu-access,.json,application/json"
            required
            disabled={busy}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setError('');
            }}
          />
        </label>
        {error && <Notice>{error}</Notice>}
        <button className="button primary" disabled={!file || busy}>
          {busy ? 'Opening…' : 'Open examination'}
          <Icon name="arrow" size={17} />
        </button>
      </form>
      <p className="field-hint">
        Can’t find your file? Ask the invigilator for a replacement. Your saved answers and
        remaining time stay unchanged.
      </p>
    </section>
  );
}

export function CandidateLocalPasses() {
  const [passes, setPasses] = useState<CandidateLocalPass[]>([]),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [saved, setSaved] = useState('');
  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ passes: CandidateLocalPass[] }>('/candidate/local-passes')
        .then((r) => {
          if (alive) {
            setPasses(r.passes);
            setError('');
          }
        })
        .catch((e) => {
          if (alive) setError(errorMessage(e));
        });
    void load();
    const timer = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  if (!passes.length && !error) return null;
  return (
    <section className="panel padded local-preparation-panel">
      <div>
        <span className="eyebrow">BEFORE EXAMINATION DAY</span>
        <h2>Save access for your local exams</h2>
        <p className="muted small">
          Keep the file on the device you’ll use. It’s private to you—don’t share it.
        </p>
      </div>
      {error && <Notice>{error}</Notice>}
      {passes.map((pass) => (
        <div className="local-pass-row" key={pass.preparationId}>
          <div>
            <strong>{pass.title}</strong>
            <p className="field-hint">
              {pass.course} · Access until {new Date(pass.expiresAt).toLocaleString()}
            </p>
          </div>
          <button
            className="button secondary"
            disabled={Boolean(busy)}
            onClick={async () => {
              setBusy(pass.preparationId);
              setError('');
              try {
                savePass(await api<LocalExamPass>(`/candidate/local-passes/${pass.preparationId}`));
                setSaved(pass.preparationId);
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy('');
              }
            }}
          >
            <Icon name="download" size={17} />
            {busy === pass.preparationId
              ? 'Saving…'
              : saved === pass.preparationId
                ? 'Save again'
                : 'Save access file'}
          </button>
        </div>
      ))}
      {saved && (
        <p className="field-hint" role="status">
          Download requested. Check your downloads, then open this file at the examination address
          on the day.
        </p>
      )}
    </section>
  );
}

export function PrepareLocalAssessment({ id }: { id: string }) {
  const [cancel, setCancel] = useState(false);
  const [status, setStatus] = useState<LocalPreparationStatus | null>(null),
    [open, setOpen] = useState(false),
    [expires, setExpires] = useState<number | null>(() => Date.now() + 7 * 86400000),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [recovery, setRecovery] = useState(false),
    [members, setMembers] = useState<
      Array<{ accountId: string; name: string; identifier: string }>
    >([]),
    [account, setAccount] = useState(''),
    [reason, setReason] = useState(''),
    [operationId, setOperationId] = useState(() => crypto.randomUUID()),
    [replacement, setReplacement] = useState<LocalExamPass | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api<LocalPreparationStatus>(`/assessments/${id}/local-preparation`)
        .then((s) => {
          if (alive) setStatus(s);
        })
        .catch((e) => {
          if (alive) setError(errorMessage(e));
        });
    void load();
    const timer = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id]);
  async function refresh() {
    setStatus(await api<LocalPreparationStatus>(`/assessments/${id}/local-preparation`));
  }
  async function action(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (!status) return error ? <Notice>{error}</Notice> : null;
  const p = status.preparation;
  if (!status.enabled && !status.isPreparedRun) return null;
  return (
    <section className="assessment-delivery-row local-preparation-panel">
      <div className="assessment-delivery-heading">
        <div>
          <h3>
            {status.isPreparedRun
              ? 'Prepared on this Host'
              : p?.state === 'ready'
                ? p.expiresAt <= Date.now() && !p.started
                  ? 'Local access has expired'
                  : 'Your local run is ready'
                : 'Local examination'}
          </h3>
          <p className="muted small">
            {status.isPreparedRun
              ? 'Saved on this Host · No internet required during the examination'
              : 'Prepare on this Host to run over Wi-Fi without internet.'}
          </p>
        </div>
        {(!p || ['completed', 'cancelled'].includes(p.state)) && status.enabled && (
          <button className="button secondary" onClick={() => setOpen(true)}>
            Prepare local run
            <Icon name="arrow" size={17} />
          </button>
        )}
      </div>
      {error && <Notice>{error}</Notice>}
      {p && (
        <>
          <p className="field-hint">
            {p.candidates} candidates ·{' '}
            {p.downloaded === null
              ? 'Download status not yet available'
              : `${p.downloaded} access files requested`}{' '}
            · Access until {new Date(p.expiresAt).toLocaleString()}
          </p>
          {p.error && <Notice>{p.error}</Notice>}
          <div className="actions">
            {p.state === 'pending' && (
              <>
                <span className="muted small" role="status">
                  Preparation pending. Keep this Host connected until it’s ready.
                </span>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void action(() =>
                      api(`/local-preparations/${p.id}/retry`, { method: 'POST', body: {} }),
                    )
                  }
                >
                  {busy ? 'Retrying…' : 'Retry preparation'}
                </button>
              </>
            )}
            {p.state === 'ready' && !status.isPreparedRun && (
              <a className="button primary" href={`/assessments/${p.runId}`}>
                Open local run
                <Icon name="arrow" size={17} />
              </a>
            )}
            {p.state === 'ready' && (
              <a className="button secondary" href="/local-delivery">
                Connect students
              </a>
            )}
            {status.isPreparedRun && ['ready', 'completed'].includes(p.state) && (
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const result = await api<{ members: typeof members }>(
                      `/local-preparations/${p.id}/members`,
                    );
                    setMembers(result.members);
                    setAccount('');
                    setReason('');
                    setReplacement(null);
                    setOperationId(crypto.randomUUID());
                    setRecovery(true);
                  })
                }
              >
                Replace candidate access
              </button>
            )}
            {!p.started && ['ready', 'pending'].includes(p.state) && (
              <button
                className="text-button danger-text"
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  setRecovery(false);
                  setReason('');
                  setReplacement(null);
                  setCancel(true);
                }}
              >
                Cancel preparation
              </button>
            )}
          </div>
          {['completed', 'cancelled'].includes(p.state) && (
            <p className="field-hint">
              This preparation is {p.state}. Previous answers and results are kept.
            </p>
          )}
        </>
      )}
      {open && (
        <Modal
          busy={busy}
          title="Prepare a local run"
          onClose={() => {
            if (!busy) setOpen(false);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                const next = await api<LocalPreparationStatus>(
                  `/assessments/${id}/local-preparation`,
                  {
                    method: 'POST',
                    body: { expectedVersion: status.sourceVersion, expiresAt: expires },
                  },
                );
                setStatus(next);
                setOpen(false);
              });
            }}
          >
            <p className="muted small">
              This creates a separate run with the current paper and approved candidates. Later
              changes won’t alter it. Candidates save their access file from their account before
              joining the offline Wi-Fi.
            </p>
            <ScheduleField
              title="Access valid until"
              hint="Choose a time after the last planned candidate start. Your local time."
              value={expires}
              minimum={Date.now() + 3600000}
              onChange={setExpires}
            />
            {error && <Notice>{error}</Notice>}
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Not now
              </button>
              <button className="button primary" disabled={busy || !expires}>
                {busy ? 'Preparing…' : 'Prepare local run'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {recovery && p && (
        <Modal
          busy={busy}
          title="Replace candidate access"
          onClose={() => {
            if (!busy) setRecovery(false);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                const pass = await api<LocalExamPass>(`/local-preparations/${p.id}/replacement`, {
                  method: 'POST',
                  body: { accountId: account, reason, operationId },
                });
                setReplacement(pass);
                savePass(pass);
              });
            }}
          >
            <p className="muted small">
              The previous file and active sign-in will stop working. Saved answers and the official
              timer stay unchanged. Give the replacement file only to this candidate.
            </p>
            <label>
              Candidate
              <select
                required
                value={account}
                disabled={busy || Boolean(replacement)}
                onChange={(e) => {
                  setAccount(e.target.value);
                  setOperationId(crypto.randomUUID());
                }}
              >
                <option value="">Choose a candidate</option>
                {members.map((m) => (
                  <option key={m.accountId} value={m.accountId}>
                    {m.name} · {m.identifier}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Reason
              <input
                required
                maxLength={500}
                value={reason}
                disabled={busy || Boolean(replacement)}
                onChange={(e) => {
                  setReason(e.target.value);
                  setOperationId(crypto.randomUUID());
                }}
              />
            </label>
            {error && <Notice>{error}</Notice>}
            {replacement && (
              <Notice kind="info">
                Replacement created. Check your downloads and give the file to the candidate. Their
                previous file is no longer valid.
              </Notice>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setRecovery(false)}
              >
                Close
              </button>
              {replacement ? (
                <button
                  type="button"
                  className="button primary"
                  onClick={() => savePass(replacement)}
                >
                  Save replacement again
                </button>
              ) : (
                <button className="button primary" disabled={busy || !account || !reason.trim()}>
                  {busy ? 'Replacing…' : 'Replace & save access'}
                </button>
              )}
            </div>
          </form>
        </Modal>
      )}
      {cancel && p && (
        <Modal
          busy={busy}
          title="Cancel local preparation?"
          onClose={() => {
            if (!busy) setCancel(false);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                await api(`/local-preparations/${p.id}/cancel`, {
                  method: 'POST',
                  body: { reason },
                });
                setCancel(false);
              });
            }}
          >
            <p className="muted small">
              Candidates will no longer be able to use these access files. Your original assessment
              is unchanged.
            </p>
            <label>
              Reason
              <input
                required
                maxLength={500}
                value={reason}
                disabled={busy}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            {error && <Notice>{error}</Notice>}
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setCancel(false)}
              >
                Keep preparation
              </button>
              <button className="button danger" disabled={busy || !reason.trim()}>
                {busy ? 'Cancelling…' : 'Cancel preparation'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
