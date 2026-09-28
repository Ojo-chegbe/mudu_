import { useEffect, useState } from 'react';
import type { BankContent, BankItem, BankStatus } from '../../packages/contracts/question-bank.ts';
import { questionTypes } from '../../packages/contracts/question-bank.ts';
import { api, errorMessage } from './api.ts';
import { Icon, Loading, Notice } from './ui.tsx';

interface GeneratedQuestionsReviewProps {
  questionIds: string[];
  onGenerateMore: () => void;
}

function validateItem(item: BankItem): string | null {
  const q = item.question;
  if (!q.prompt.trim()) return 'Question prompt cannot be empty.';
  if (!Number.isInteger(q.marks) || q.marks < 1 || q.marks > 100) {
    return 'Marks must be between 1 and 100.';
  }
  if (q.type === 'single' || q.type === 'multiple') {
    if (q.options.length < 2) return 'Add at least 2 answer options.';
    if (q.options.some((o) => !o.trim())) return 'All answer options must contain text.';
    if (q.type === 'single') {
      if (q.correctIndices.length !== 1) return 'Select exactly one correct answer.';
    } else {
      if (q.correctIndices.length < 1) return 'Select at least one correct answer.';
    }
    const normalized = q.options.map((o) => o.normalize('NFKC').toLowerCase().trim());
    if (new Set(normalized).size !== normalized.length) {
      return 'Each answer option must be distinct.';
    }
  }
  return null;
}

export function GeneratedQuestionsReview({
  questionIds,
  onGenerateMore,
}: GeneratedQuestionsReviewProps) {
  const [questions, setQuestions] = useState<BankItem[]>([]);
  const [savedSnapshots, setSavedSnapshots] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState('');
  const [itemBusy, setItemBusy] = useState<Record<string, boolean>>({});
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [itemSuccess, setItemSuccess] = useState<Record<string, string>>({});
  const [bulkBusy, setBulkBusy] = useState(false);
  const [globalNotice, setGlobalNotice] = useState<{
    kind: 'error' | 'success' | 'info';
    message: string;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    async function loadAll() {
      setLoading(true);
      setFetchError('');
      try {
        const fetched = await Promise.all(
          questionIds.map((id) => api<BankItem>(`/question-bank/${id}`)),
        );
        if (!alive) return;
        setQuestions(fetched);
        const snapshots: Record<string, string> = {};
        for (const q of fetched) {
          snapshots[q.id] = JSON.stringify(q);
        }
        setSavedSnapshots(snapshots);
      } catch (e) {
        if (alive) setFetchError(errorMessage(e));
      } finally {
        if (alive) setLoading(false);
      }
    }
    void loadAll();
    return () => {
      alive = false;
    };
  }, [questionIds]);

  if (loading) {
    return (
      <section className="panel padded generated-loading" role="status">
        <Loading />
        <p className="muted" style={{ marginTop: '12px', textAlign: 'center' }}>
          Loading your {questionIds.length} generated questions for review…
        </p>
      </section>
    );
  }

  if (fetchError) {
    return (
      <div className="panel padded">
        <Notice kind="error">{fetchError}</Notice>
        <div className="actions" style={{ marginTop: '16px' }}>
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              setLoading(true);
              setFetchError('');
              Promise.all(questionIds.map((id) => api<BankItem>(`/question-bank/${id}`)))
                .then((res) => {
                  setQuestions(res);
                  setLoading(false);
                })
                .catch((e) => {
                  setFetchError(errorMessage(e));
                  setLoading(false);
                });
            }}
          >
            Retry loading
          </button>
          <button type="button" className="text-button" onClick={onGenerateMore}>
            Back to generation
          </button>
        </div>
      </div>
    );
  }

  const approvedCount = questions.filter((q) => q.status === 'approved').length;
  const draftCount = questions.filter((q) => q.status === 'draft').length;
  const allApproved = questions.length > 0 && approvedCount === questions.length;

  function updateItemQuestion(id: string, patch: Partial<BankContent['question']>) {
    setQuestions((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, question: { ...item.question, ...patch } } : item,
      ),
    );
    setItemErrors((prev) => ({ ...prev, [id]: '' }));
    setItemSuccess((prev) => ({ ...prev, [id]: '' }));
  }

  function updateItemContent(id: string, patch: Partial<BankContent>) {
    setQuestions((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    setItemErrors((prev) => ({ ...prev, [id]: '' }));
    setItemSuccess((prev) => ({ ...prev, [id]: '' }));
  }

  function isItemModified(item: BankItem) {
    const saved = savedSnapshots[item.id];
    if (!saved) return false;
    return JSON.stringify(item) !== saved;
  }

  async function saveItem(item: BankItem, status: BankStatus) {
    if (status === 'approved') {
      const error = validateItem(item);
      if (error) {
        setItemErrors((prev) => ({ ...prev, [item.id]: error }));
        return;
      }
    }
    setItemBusy((prev) => ({ ...prev, [item.id]: true }));
    setItemErrors((prev) => ({ ...prev, [item.id]: '' }));
    setItemSuccess((prev) => ({ ...prev, [item.id]: '' }));
    try {
      const updated = await api<BankItem>('/question-bank', {
        method: 'POST',
        body: {
          ...item,
          status,
          expectedRevision: item.revision,
        },
      });
      setQuestions((prev) => prev.map((q) => (q.id === item.id ? updated : q)));
      setSavedSnapshots((prev) => ({ ...prev, [item.id]: JSON.stringify(updated) }));
      setItemSuccess((prev) => ({
        ...prev,
        [item.id]:
          status === 'approved'
            ? 'Approved and ready for assessments!'
            : 'Draft saved successfully.',
      }));
    } catch (e) {
      setItemErrors((prev) => ({ ...prev, [item.id]: errorMessage(e) }));
    } finally {
      setItemBusy((prev) => ({ ...prev, [item.id]: false }));
    }
  }

  async function discardItem(item: BankItem) {
    if (!confirm('Discard this question from the generated set?')) return;
    setItemBusy((prev) => ({ ...prev, [item.id]: true }));
    try {
      await api<BankItem>('/question-bank', {
        method: 'POST',
        body: {
          ...item,
          status: 'archived',
          expectedRevision: item.revision,
        },
      });
      setQuestions((prev) => prev.filter((q) => q.id !== item.id));
    } catch (e) {
      setItemErrors((prev) => ({ ...prev, [item.id]: errorMessage(e) }));
      setItemBusy((prev) => ({ ...prev, [item.id]: false }));
    }
  }

  async function handleApproveAll() {
    const pending = questions.filter((q) => q.status !== 'approved');
    if (!pending.length) return;

    const errors: Record<string, string> = {};
    for (const item of pending) {
      const err = validateItem(item);
      if (err) errors[item.id] = err;
    }
    if (Object.keys(errors).length > 0) {
      setItemErrors((prev) => ({ ...prev, ...errors }));
      setGlobalNotice({
        kind: 'error',
        message: 'Some questions could not be approved yet. Please fix the highlighted issues.',
      });
      return;
    }

    setBulkBusy(true);
    setGlobalNotice(null);
    let count = 0;
    const updatedList = [...questions];

    for (let i = 0; i < updatedList.length; i++) {
      const item = updatedList[i];
      if (item.status === 'approved') continue;
      try {
        const saved = await api<BankItem>('/question-bank', {
          method: 'POST',
          body: {
            ...item,
            status: 'approved',
            expectedRevision: item.revision,
          },
        });
        updatedList[i] = saved;
        setSavedSnapshots((prev) => ({ ...prev, [item.id]: JSON.stringify(saved) }));
        count++;
      } catch (e) {
        setItemErrors((prev) => ({ ...prev, [item.id]: errorMessage(e) }));
      }
    }

    setQuestions(updatedList);
    setBulkBusy(false);
    if (count > 0) {
      setGlobalNotice({
        kind: 'success',
        message: `Approved ${count} question${count > 1 ? 's' : ''}! All approved questions are stored in your Question Bank.`,
      });
    }
  }

  return (
    <div className="generated-review-container">
      {/* Top Header & Summary Card */}
      <section
        className="panel padded generated-review-hero"
        role="region"
        aria-label="Review Summary"
      >
        <div className="generated-hero-content">
          <div className="generated-hero-text">
            <span className="eyebrow">AI GENERATION COMPLETE</span>
            <h2>{questions.length} Generated Questions Ready for Review</h2>
            <p className="muted">
              Inspect questions below. You can edit prompts, answers, marks, or options directly
              inline, then approve each question individually or all at once.
            </p>
          </div>
          <div className="generated-hero-stats">
            <div className="stat-pill">
              <span className="stat-number">{approvedCount}</span>
              <span className="stat-label">Approved</span>
            </div>
            <div className="stat-pill">
              <span className="stat-number">{draftCount}</span>
              <span className="stat-label">Pending</span>
            </div>
          </div>
        </div>

        {globalNotice && (
          <div style={{ marginTop: '16px' }}>
            <Notice kind={globalNotice.kind}>{globalNotice.message}</Notice>
          </div>
        )}

        <div className="generated-hero-actions">
          <button
            type="button"
            className="button primary"
            disabled={draftCount === 0 || bulkBusy}
            onClick={() => void handleApproveAll()}
          >
            <Icon name="check" size={17} />
            {bulkBusy
              ? 'Approving all…'
              : draftCount === 0
                ? 'All questions approved'
                : `Approve all ${draftCount} pending questions`}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={bulkBusy}
            onClick={onGenerateMore}
          >
            Generate another set
          </button>
          <a className="button secondary" href="/question-bank">
            Question bank
          </a>
        </div>
      </section>

      {/* List of All Questions */}
      <div className="generated-questions-list">
        {questions.map((item, index) => {
          const q = item.question;
          const busy = Boolean(itemBusy[item.id]) || bulkBusy;
          const isApproved = item.status === 'approved';
          const isModified = isItemModified(item);
          const error = itemErrors[item.id];
          const success = itemSuccess[item.id];

          return (
            <article
              key={item.id}
              className={`panel padded generated-question-card ${isApproved ? 'is-approved' : ''}`}
              id={`question-${item.id}`}
            >
              {/* Card Header Bar */}
              <div className="generated-card-header">
                <div className="generated-card-title-group">
                  <span className="question-number-badge">#{index + 1}</span>
                  <span
                    className={`badge ${isApproved ? 'completed' : 'expired'}`}
                    style={{ fontSize: '11px', textTransform: 'capitalize' }}
                  >
                    <span className="status-dot" />
                    {isApproved ? 'Approved' : 'Draft'}
                  </span>
                  {item.origin === 'ai' && (
                    <span className="badge" style={{ fontSize: '10px' }}>
                      AI Generated
                    </span>
                  )}
                  {isModified && (
                    <span
                      className="badge"
                      style={{ background: '#fef3c7', color: '#92400e', fontSize: '10px' }}
                    >
                      Unsaved changes
                    </span>
                  )}
                </div>

                <div className="generated-card-actions">
                  {isApproved ? (
                    isModified ? (
                      <button
                        type="button"
                        className="button primary small"
                        disabled={busy}
                        onClick={() => void saveItem(item, 'approved')}
                      >
                        {busy ? 'Saving…' : 'Update approved'}
                      </button>
                    ) : (
                      <span className="approved-confirmed-tag">
                        <Icon name="check" size={15} /> Ready in Bank
                      </span>
                    )
                  ) : (
                    <>
                      {isModified && (
                        <button
                          type="button"
                          className="button secondary small"
                          disabled={busy}
                          onClick={() => void saveItem(item, 'draft')}
                        >
                          Save draft
                        </button>
                      )}
                      <button
                        type="button"
                        className="button primary small"
                        disabled={busy}
                        onClick={() => void saveItem(item, 'approved')}
                      >
                        <Icon name="check" size={15} />
                        {busy ? 'Approving…' : 'Approve'}
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="text-button"
                    style={{ color: 'var(--muted)', fontSize: '12px' }}
                    disabled={busy}
                    onClick={() => void discardItem(item)}
                    title="Remove question from this set"
                  >
                    Discard
                  </button>
                </div>
              </div>

              {/* Status feedback */}
              {error && <Notice kind="error">{error}</Notice>}
              {success && <Notice kind="success">{success}</Notice>}

              {/* Top Controls: Type, Marks, Difficulty */}
              <div className="bank-grid" style={{ marginBottom: '16px' }}>
                <label>
                  Question type
                  <select
                    value={q.type}
                    disabled={busy}
                    onChange={(e) => {
                      const type = e.target.value as typeof q.type;
                      updateItemQuestion(item.id, {
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
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <label>
                    Marks
                    <input
                      type="number"
                      min={1}
                      max={100}
                      disabled={busy}
                      value={q.marks}
                      onChange={(e) =>
                        updateItemQuestion(item.id, { marks: Number(e.target.value) })
                      }
                    />
                  </label>
                  <label>
                    Difficulty
                    <select
                      value={item.difficulty}
                      disabled={busy}
                      onChange={(e) =>
                        updateItemContent(item.id, {
                          difficulty: e.target.value as BankContent['difficulty'],
                        })
                      }
                    >
                      <option value="easy">Easy</option>
                      <option value="medium">Medium</option>
                      <option value="hard">Hard</option>
                    </select>
                  </label>
                </div>
              </div>

              {/* Prompt Textarea */}
              <label style={{ marginBottom: '16px' }}>
                Question prompt
                <textarea
                  rows={3}
                  maxLength={10000}
                  disabled={busy}
                  placeholder="What should the candidate answer?"
                  value={q.prompt}
                  onChange={(e) => updateItemQuestion(item.id, { prompt: e.target.value })}
                />
              </label>

              {/* Answer Options (for single / multiple) */}
              {q.type !== 'short' ? (
                <div
                  className="bank-answer-editor"
                  style={{ marginTop: '8px', marginBottom: '16px' }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'baseline',
                      marginBottom: '8px',
                    }}
                  >
                    <span style={{ fontWeight: 600, fontSize: '13px' }}>Answer options</span>
                    <span className="field-hint" style={{ margin: 0 }}>
                      {q.type === 'single'
                        ? 'Select the radio button next to the single correct answer.'
                        : 'Check all boxes that are correct answers.'}
                    </span>
                  </div>
                  {q.options.map((option, optIdx) => {
                    const isCorrect = q.correctIndices.includes(optIdx);
                    return (
                      <div className="bank-answer-row" key={optIdx}>
                        <input
                          type={q.type === 'single' ? 'radio' : 'checkbox'}
                          name={`correct-answer-${item.id}`}
                          aria-label={`Option ${optIdx + 1} is correct`}
                          disabled={busy}
                          checked={isCorrect}
                          onChange={() =>
                            updateItemQuestion(item.id, {
                              correctIndices:
                                q.type === 'single'
                                  ? [optIdx]
                                  : isCorrect
                                    ? q.correctIndices.filter((n) => n !== optIdx)
                                    : [...q.correctIndices, optIdx],
                            })
                          }
                        />
                        <span aria-hidden="true" style={{ fontWeight: 600, minWidth: '16px' }}>
                          {String.fromCharCode(65 + optIdx)}
                        </span>
                        <input
                          aria-label={`Option ${optIdx + 1}`}
                          maxLength={2000}
                          disabled={busy}
                          placeholder={`Option ${String.fromCharCode(65 + optIdx)}`}
                          value={option}
                          onChange={(e) =>
                            updateItemQuestion(item.id, {
                              options: q.options.map((o, n) => (n === optIdx ? e.target.value : o)),
                            })
                          }
                          style={
                            isCorrect
                              ? { borderColor: '#448164', background: '#f5faf7' }
                              : undefined
                          }
                        />
                        <button
                          type="button"
                          className="text-button"
                          disabled={busy || q.options.length <= 2}
                          aria-label={`Remove option ${optIdx + 1}`}
                          onClick={() =>
                            updateItemQuestion(item.id, {
                              options: q.options.filter((_, n) => n !== optIdx),
                              correctIndices: q.correctIndices
                                .filter((n) => n !== optIdx)
                                .map((n) => (n > optIdx ? n - 1 : n)),
                            })
                          }
                        >
                          <Icon name="close" size={16} />
                        </button>
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy || q.options.length >= 8}
                    onClick={() => updateItemQuestion(item.id, { options: [...q.options, ''] })}
                    style={{ fontSize: '12px' }}
                  >
                    + Add option
                  </button>
                </div>
              ) : (
                <p className="field-hint" style={{ margin: '8px 0 16px' }}>
                  Candidates will type their answer. Provide guidance or keywords below for graders.
                </p>
              )}

              {/* Explanation & Details Accordion */}
              <details style={{ marginTop: '12px' }}>
                <summary style={{ cursor: 'pointer', fontSize: '13px', color: 'var(--accent)' }}>
                  Explanation & question details
                </summary>
                <div style={{ marginTop: '12px' }}>
                  <label style={{ marginBottom: '12px' }}>
                    {q.type === 'short' ? 'Marking guidance' : 'Answer explanation'}
                    <textarea
                      rows={2}
                      maxLength={10000}
                      disabled={busy}
                      value={item.explanation}
                      onChange={(e) => updateItemContent(item.id, { explanation: e.target.value })}
                      placeholder={
                        q.type === 'short'
                          ? 'What should a good answer include?'
                          : 'Why is this the correct answer?'
                      }
                    />
                  </label>
                  <div className="bank-grid">
                    <label>
                      Course or subject
                      <input
                        maxLength={100}
                        disabled={busy}
                        value={item.course}
                        placeholder="e.g. Pharmacology"
                        onChange={(e) => updateItemContent(item.id, { course: e.target.value })}
                      />
                    </label>
                    <label>
                      Topic
                      <input
                        maxLength={100}
                        disabled={busy}
                        value={item.topic}
                        placeholder="e.g. Pharmacodynamics"
                        onChange={(e) => updateItemContent(item.id, { topic: e.target.value })}
                      />
                    </label>
                  </div>
                </div>
              </details>
            </article>
          );
        })}
      </div>

      {/* Bottom Sticky Action Bar */}
      <section className="panel padded generated-review-footer">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontWeight: 600, fontSize: '14px' }}>
            {approvedCount} of {questions.length} questions approved
          </span>
          {allApproved && (
            <span className="badge completed" style={{ fontSize: '11px' }}>
              <span className="status-dot" /> All questions ready
            </span>
          )}
        </div>
        <div className="actions">
          <button
            type="button"
            className="button primary"
            disabled={draftCount === 0 || bulkBusy}
            onClick={() => void handleApproveAll()}
          >
            <Icon name="check" size={16} />
            {draftCount === 0 ? 'All approved' : `Approve remaining (${draftCount})`}
          </button>
          <a className="button secondary" href="/question-bank">
            Go to Question Bank
          </a>
          <button type="button" className="text-button" onClick={onGenerateMore}>
            Generate another set
          </button>
        </div>
      </section>
    </div>
  );
}
