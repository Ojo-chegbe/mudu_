import { useEffect, useRef, useState } from 'react';
import { emptyBankContent, questionTypes } from '../../packages/contracts/question-bank.ts';
import type { BankContent, BankItem, BankStatus } from '../../packages/contracts/question-bank.ts';
import { api, errorMessage } from './api.ts';
import { browserId } from './browser-id.ts';
import { Dialog, Icon, Loading, Notice } from './ui.tsx';
import { QuestionPreview } from './question-bank.tsx';

export function BankEditor({ id }: { id?: string }) {
  const key = `mudu.bank-draft.${id ?? 'new'}`;
  const [item, setItem] = useState<BankItem | null>(null);
  const [draft, setDraft] = useState<BankItem | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [stored, setStored] = useState(true);
  const [reviewed, setReviewed] = useState(false);
  const [archive, setArchive] = useState(false);
  const leaving = useRef(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(item);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const saved: BankItem = id
          ? await api(`/question-bank/${id}`)
          : {
              ...emptyBankContent(),
              id: browserId(),
              revision: 0,
              status: 'draft',
              updatedAt: 0,
              origin: 'manual',
              evidence: '',
              model: null,
            };
        if (!alive) return;
        setItem(saved);
        setDraft(saved);
        try {
          const cached = JSON.parse(sessionStorage.getItem(key) ?? 'null');
          if (cached) {
            if (
              typeof cached.id !== 'string' ||
              (id && cached.id !== id) ||
              !Number.isInteger(cached.revision) ||
              !cached.question ||
              typeof cached.question.prompt !== 'string' ||
              !Array.isArray(cached.question.options) ||
              !cached.question.options.every((o: unknown) => typeof o === 'string') ||
              !Array.isArray(cached.question.correctIndices) ||
              !Array.isArray(cached.tags) ||
              !cached.tags.every((t: unknown) => typeof t === 'string') ||
              typeof cached.course !== 'string' ||
              typeof cached.topic !== 'string' ||
              typeof cached.explanation !== 'string'
            )
              throw new Error('Invalid draft');
            setDraft(cached);
          }
        } catch {
          setStored(false);
          setError('The previous tab draft could not be restored. The saved question is shown.');
        }
      } catch (e) {
        if (alive) setError(errorMessage(e));
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [id, key]);
  useEffect(() => {
    if (!draft || !item || leaving.current) return;
    try {
      if (dirty) sessionStorage.setItem(key, JSON.stringify(draft));
      else sessionStorage.removeItem(key);
      setStored(true);
    } catch {
      setStored(false);
    }
  }, [draft, item, dirty, key]);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (dirty && !leaving.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);
  if (!draft || !item) return error ? <Notice>{error}</Notice> : <Loading />;
  const q = draft.question;
  const patch = (value: Partial<BankContent>) => {
    setDraft({ ...draft, ...value });
    setReviewed(false);
  };
  const changeQuestion = (value: Partial<BankContent['question']>) =>
    patch({ question: { ...q, ...value } });
  async function save(status: BankStatus) {
    if (!draft) return;
    setBusy(true);
    setError('');
    try {
      await api<BankItem>('/question-bank', {
        method: 'POST',
        body: { ...draft, status, expectedRevision: draft.revision },
      });
      leaving.current = true;
      try {
        sessionStorage.removeItem(key);
      } catch {}
      location.href = `/question-bank?status=${status}&saved=${status}`;
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
      setArchive(false);
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
          <p className="eyebrow">
            {draft.origin === 'ai' ? 'REVIEW AI DRAFT' : id ? 'EDIT QUESTION' : 'NEW QUESTION'}
          </p>
          <h1>
            {draft.origin === 'ai' && item.status === 'draft'
              ? 'Make it yours before you approve'
              : id
                ? 'Refine your question'
                : 'Write a question worth reusing'}
          </h1>
          <p className="muted">
            Changes here never alter questions already copied into assessments.
          </p>
        </div>
      </div>
      {error && <Notice>{error}</Notice>}
      {draft.revision !== item.revision && (
        <Notice>
          Your tab draft is based on an older revision. Copy any edits you want to keep, then reopen
          the saved version.
        </Notice>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save('draft');
        }}
      >
        <fieldset disabled={busy} className="assessment-fields">
          <section className="panel padded">
            <div className="bank-grid">
              <label>
                Question type
                <select
                  value={q.type}
                  onChange={(e) => {
                    const type = e.target.value as typeof q.type;
                    changeQuestion({
                      type,
                      options:
                        type === 'short' ? [] : q.options.length ? q.options : ['', '', '', ''],
                      correctIndices: [],
                    });
                  }}
                >
                  {Object.entries(questionTypes).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Marks
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={q.marks}
                  onChange={(e) => changeQuestion({ marks: Number(e.target.value) })}
                />
              </label>
            </div>
            <label>
              Question
              <textarea
                autoFocus
                rows={5}
                maxLength={10000}
                placeholder="What should the candidate answer?"
                value={q.prompt}
                onChange={(e) => changeQuestion({ prompt: e.target.value })}
              />
            </label>
            {q.type !== 'short' && (
              <div className="bank-answer-editor">
                <h3>Answer options</h3>
                <p className="field-hint">
                  {q.type === 'single'
                    ? 'Select the one correct answer.'
                    : 'Select every correct answer. Candidates must match the full set to earn the marks.'}
                </p>
                {q.options.map((option, index) => (
                  <div className="bank-answer-row" key={index}>
                    <input
                      type={q.type === 'single' ? 'radio' : 'checkbox'}
                      name="correct-answer"
                      aria-label={`Option ${index + 1} is correct`}
                      checked={q.correctIndices.includes(index)}
                      onChange={() =>
                        changeQuestion({
                          correctIndices:
                            q.type === 'single'
                              ? [index]
                              : q.correctIndices.includes(index)
                                ? q.correctIndices.filter((n) => n !== index)
                                : [...q.correctIndices, index],
                        })
                      }
                    />
                    <span aria-hidden="true">{String.fromCharCode(65 + index)}</span>
                    <input
                      aria-label={`Option ${index + 1}`}
                      maxLength={2000}
                      placeholder={`Option ${String.fromCharCode(65 + index)}`}
                      value={option}
                      onChange={(e) =>
                        changeQuestion({
                          options: q.options.map((o, n) => (n === index ? e.target.value : o)),
                        })
                      }
                    />
                    <button
                      type="button"
                      className="text-button"
                      disabled={q.options.length <= 2}
                      aria-label={`Remove option ${index + 1}`}
                      onClick={() =>
                        changeQuestion({
                          options: q.options.filter((_, n) => n !== index),
                          correctIndices: q.correctIndices
                            .filter((n) => n !== index)
                            .map((n) => (n > index ? n - 1 : n)),
                        })
                      }
                    >
                      <Icon name="close" size={16} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="text-button"
                  disabled={q.options.length >= 8}
                  onClick={() => changeQuestion({ options: [...q.options, ''] })}
                >
                  Add an option
                </button>
              </div>
            )}
            <label>
              {q.type === 'short' ? 'Marking guidance' : 'Answer explanation'}{' '}
              <span className="muted small">Optional · administrators only</span>
              <textarea
                rows={3}
                maxLength={10000}
                value={draft.explanation}
                onChange={(e) => patch({ explanation: e.target.value })}
                placeholder={
                  q.type === 'short'
                    ? 'What should a good answer cover?'
                    : 'Why is this answer correct?'
                }
              />
            </label>
          </section>
          <section className="panel padded">
            <h2>Keep it easy to find</h2>
            <div className="bank-grid">
              <label>
                Course or subject
                <input
                  maxLength={100}
                  placeholder="e.g. Pharmacology"
                  value={draft.course}
                  onChange={(e) => patch({ course: e.target.value })}
                />
              </label>
              <label>
                Topic
                <input
                  maxLength={100}
                  placeholder="e.g. Drug absorption"
                  value={draft.topic}
                  onChange={(e) => patch({ topic: e.target.value })}
                />
              </label>
              <label>
                Difficulty
                <select
                  value={draft.difficulty}
                  onChange={(e) =>
                    patch({ difficulty: e.target.value as BankContent['difficulty'] })
                  }
                >
                  <option value="easy">Easy</option>
                  <option value="medium">Medium</option>
                  <option value="hard">Hard</option>
                </select>
              </label>
              <label>
                Tags <span className="muted small">Optional · comma separated</span>
                <input
                  maxLength={409}
                  defaultValue={draft.tags.join(', ')}
                  onBlur={(e) =>
                    patch({
                      tags: e.target.value
                        .split(',')
                        .map((t) => t.trim())
                        .filter(Boolean),
                    })
                  }
                  placeholder="revision, year 2"
                />
              </label>
            </div>
          </section>
          <details className="panel padded">
            <summary>Preview question and answer</summary>
            <QuestionPreview item={draft} />
          </details>
          <section className="panel padded">
            <label className="check-label">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
              />
              I have checked the question, answer and marks. It is ready to use.
            </label>
            <div className="bank-save-bar">
              <span className="field-hint" role="status">
                {dirty
                  ? stored
                    ? 'Draft kept in this tab. Save it to return from another tab.'
                    : 'Draft storage unavailable. Save before leaving.'
                  : 'No unsaved changes'}
              </span>
              <div className="actions">
                <button className="button secondary" type="submit">
                  Save draft
                </button>
                <button
                  className="button primary"
                  type="button"
                  disabled={!reviewed || !q.prompt.trim()}
                  onClick={() => void save('approved')}
                >
                  {busy ? 'Saving…' : 'Approve & save'}
                </button>
              </div>
            </div>
          </section>
          {id && (
            <div className="actions">
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  if (confirm('Discard your tab draft and reopen the saved question?')) {
                    sessionStorage.removeItem(key);
                    leaving.current = true;
                    location.reload();
                  }
                }}
              >
                Reopen saved version
              </button>
              {item.status !== 'archived' && (
                <button
                  type="button"
                  className="text-button membership-action decline"
                  onClick={() => setArchive(true)}
                >
                  Archive question
                </button>
              )}
            </div>
          )}
        </fieldset>
      </form>
      {archive && (
        <Dialog
          title="Archive this question?"
          confirmLabel="Archive question"
          busy={busy}
          onClose={() => setArchive(false)}
          confirm={() => void save('archived')}
        >
          <p>
            It will be hidden from the assessment picker. Existing assessments stay unchanged. You
            can restore it by reviewing and approving it again.
          </p>
        </Dialog>
      )}
    </div>
  );
}
