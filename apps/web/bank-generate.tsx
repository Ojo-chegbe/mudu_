import { useEffect, useRef, useState } from 'react';
import { questionTypes } from '../../packages/contracts/question-bank.ts';
import { api, errorMessage } from './api.ts';
import { browserId } from './browser-id.ts';
import { Icon, Notice } from './ui.tsx';
import { DocumentSource } from './document-source.tsx';
import type { SourceDocument } from './document-source.tsx';
import { maxGenerationCharacters } from '../../packages/contracts/documents.ts';
import { GeneratedQuestionsReview } from './generated-review.tsx';

const storageKey = 'mudu.bank-generation';
type Job = { id: string; status: string; questionIds: string[]; error: string };
export function BankGenerate() {
  const [draft, setDraft] = useState(() => {
    const empty = {
      source: '',
      document: null as SourceDocument | null,
      course: '',
      topic: '',
      type: 'single',
      difficulty: 'medium',
      count: 5,
      requestId: browserId(),
      started: false,
    };
    try {
      const cached = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
      if (
        cached &&
        ['source', 'course', 'topic', 'type', 'difficulty', 'requestId'].every(
          (k) => typeof cached[k] === 'string',
        ) &&
        Number.isInteger(cached.count)
      )
        return {
          ...cached,
          document:
            cached.document &&
            typeof cached.document.name === 'string' &&
            Array.isArray(cached.document.warnings) &&
            cached.document.warnings.every((w: unknown) => typeof w === 'string')
              ? cached.document
              : null,
        } as typeof empty;
    } catch {}
    return empty;
  });
  const [availability, setAvailability] = useState<{
    available: boolean;
    message: string;
    retryAt: number | null;
  } | null>(null);
  const [statusError, setStatusError] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [stored, setStored] = useState(true);
  const [job, setJob] = useState<Job | null>(null);
  const alive = useRef(true);
  async function refreshAvailability() {
    try {
      const status = await api<{ available: boolean; message: string; retryAt: number | null }>(
        '/question-bank/ai/status',
      );
      if (alive.current) {
        setAvailability(status);
        setStatusError('');
      }
    } catch {
      if (alive.current) {
        setAvailability(null);
        setStatusError('Could not check generation availability. Please try again.');
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    void refreshAvailability();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshAvailability();
    }, 30000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(draft));
      setStored(true);
    } catch {
      setStored(false);
    }
  }, [draft]);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (!stored && draft.source) e.preventDefault();
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [stored, draft.source]);
  useEffect(() => {
    if (!draft.started) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await api<Job>(`/question-bank/generations/${draft.requestId}`);
        if (stopped) return;
        setJob(result);
        setBusy(result.status === 'running');
        if (result.status === 'running') timer = setTimeout(poll, 2500);
      } catch {
        if (!stopped && busy) timer = setTimeout(poll, 4000);
      }
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [draft.requestId, draft.started, busy]);
  function change(patch: Partial<typeof draft>) {
    setDraft((current) => ({ ...current, ...patch, requestId: browserId(), started: false }));
    if (patch.source !== undefined) setConsent(false);
    setJob(null);
    setError('');
  }
  async function checkStatus(silent = false, requestId = draft.requestId) {
    try {
      const result = await api<Job>(`/question-bank/generations/${requestId}`);
      setJob(result);
      setBusy(result.status === 'running');
      setError('');
    } catch (e) {
      if (!silent) setError(errorMessage(e));
    }
  }
  return (
    <div className="bank-page bank-editor">
      <a className="back-link" href="/question-bank">
        <Icon name="back" size={16} />
        Question bank
      </a>
      <div className="page-heading">
        <div>
          <p className="eyebrow">AI-ASSISTED AUTHORING</p>
          <h1>Turn your notes into a starting point</h1>
          <p className="muted">
            Generate a small set of questions, then review every answer. You stay in control.
          </p>
        </div>
      </div>
      {error && <Notice>{error}</Notice>}
      {!busy &&
        job?.status !== 'completed' &&
        (statusError || availability?.available === false) && (
          <div className="panel padded" role="status">
            <p>{statusError || availability?.message}</p>
            {availability?.retryAt && availability.retryAt > Date.now() + 60000 && (
              <p className="field-hint">
                Available again after {new Date(availability.retryAt).toLocaleString()}.
              </p>
            )}
            <div className="actions">
              <button
                type="button"
                className="text-button"
                onClick={() => void refreshAvailability()}
              >
                Check again
              </button>
              <a className="text-button" href="/question-bank/new">
                Write a question instead
              </a>
            </div>
          </div>
        )}
      {job?.status === 'completed' ? (
        <GeneratedQuestionsReview questionIds={job.questionIds} onGenerateMore={() => change({})} />
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              uploading ||
              draft.source.trim().length < 100 ||
              draft.source.length > maxGenerationCharacters
            ) {
              setError('Add source material with 100–60,000 characters before generating.');
              return;
            }
            setBusy(true);
            setError('');
            const submission = {
              ...draft,
              requestId: job?.status === 'failed' ? browserId() : draft.requestId,
              started: true,
            };
            setDraft(submission);
            setJob(null);
            try {
              const result = await api<Job>('/question-bank/generate', {
                method: 'POST',
                body: { ...submission, consent },
                timeoutMs: 105000,
              });
              if (alive.current) {
                setJob(result);
                setBusy(result.status === 'running');
                void refreshAvailability();
              }
            } catch (e) {
              if (alive.current) {
                setError(errorMessage(e));
                setBusy(false);
                await checkStatus(true, submission.requestId);
                void refreshAvailability();
              }
            }
          }}
        >
          <fieldset disabled={busy} className="assessment-fields">
            <DocumentSource
              source={draft.source}
              document={draft.document}
              disabled={busy}
              onBusy={setUploading}
              onChange={(source, document) => change({ source, document })}
            />
            <section className="panel padded">
              <h2>Shape your questions</h2>
              <div className="bank-grid">
                <label>
                  Course or subject
                  <input
                    required
                    maxLength={100}
                    value={draft.course}
                    onChange={(e) => change({ course: e.target.value })}
                    placeholder="e.g. Pharmacology"
                  />
                </label>
                <label>
                  Topic <span className="muted small">Optional</span>
                  <input
                    maxLength={100}
                    value={draft.topic}
                    onChange={(e) => change({ topic: e.target.value })}
                  />
                </label>
                <label>
                  Question type
                  <select value={draft.type} onChange={(e) => change({ type: e.target.value })}>
                    {Object.entries(questionTypes).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Difficulty
                  <select
                    value={draft.difficulty}
                    onChange={(e) => change({ difficulty: e.target.value })}
                  >
                    <option value="easy">Easy</option>
                    <option value="medium">Medium</option>
                    <option value="hard">Hard</option>
                  </select>
                </label>
                <label>
                  Number of questions
                  <input
                    type="number"
                    min={1}
                    max={10}
                    required
                    value={draft.count}
                    onChange={(e) => change({ count: Number(e.target.value) })}
                  />
                </label>
              </div>
            </section>
            <section className="panel padded">
              <h2>Before you generate</h2>
              <p className="field-hint">
                Your source text, subject and settings are sent to Google. Free-tier input and
                output may be used to improve Google’s products. Do not include candidate details,
                confidential exam papers or material you are not permitted to share.{' '}
                <a href="https://ai.google.dev/gemini-api/terms" target="_blank" rel="noreferrer">
                  Read Google’s terms
                </a>
                .
              </p>
              <label className="check-label">
                <input
                  type="checkbox"
                  required
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                I have permission to share this material with Google and understand the free-tier
                data terms.
              </label>
              <div className="bank-save-bar">
                <span className="field-hint">
                  {stored
                    ? 'Notes kept in this tab. Signing out clears them.'
                    : 'Tab storage unavailable. Keep a copy of your notes.'}
                </span>
                <button
                  className="button primary"
                  disabled={
                    !availability?.available ||
                    !consent ||
                    uploading ||
                    draft.source.trim().length < 100 ||
                    draft.source.length > maxGenerationCharacters
                  }
                >
                  {busy
                    ? 'Generating drafts…'
                    : job?.status === 'failed'
                      ? 'Try again'
                      : `Generate ${draft.count} drafts`}
                </button>
              </div>
            </section>
          </fieldset>
          {busy && (
            <p role="status" className="field-hint">
              Generating your drafts. This can take up to 90 seconds. Refreshing will not create a
              second batch.
            </p>
          )}
          {job?.status === 'failed' && <Notice>{job.error}</Notice>}
          {(busy || error) && (
            <button type="button" className="text-button" onClick={() => void checkStatus()}>
              Check generation status
            </button>
          )}
        </form>
      )}
    </div>
  );
}
