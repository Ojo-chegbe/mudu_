import { useEffect, useRef, useState } from 'react';
import { Icon, Notice } from './ui.tsx';

export function SubmissionReview({
  questions,
  pending,
  ready,
  expired,
  busy,
  error,
  saveError,
  onBack,
  onQuestion,
  onSubmit,
}: {
  questions: Array<{ id: string; prompt: string; answered: boolean }>;
  pending: number;
  ready: boolean;
  expired: boolean;
  busy: boolean;
  error: string;
  saveError: string;
  onBack: () => void;
  onQuestion: (index: number) => void;
  onSubmit: () => void;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  const [unansweredOnly, setUnansweredOnly] = useState(false);
  useEffect(() => {
    title.current?.focus();
  }, []);
  const answered = questions.filter((q) => q.answered).length;
  const unanswered = questions.length - answered;
  return (
    <section className="panel padded submission-review" aria-labelledby="submission-review-title">
      <div className="section-heading">
        <div>
          <h2 id="submission-review-title" ref={title} tabIndex={-1}>
            Review before submitting
          </h2>
          <p className="muted small">
            Check your progress. The examination timer is still running.
          </p>
        </div>
        <button type="button" className="button secondary" disabled={busy} onClick={onBack}>
          <Icon name="back" size={16} />
          Back to questions
        </button>
      </div>
      <dl className="submission-summary">
        <div>
          <dt>Total questions</dt>
          <dd>{questions.length}</dd>
        </div>
        <div>
          <dt>Answered</dt>
          <dd>{answered}</dd>
        </div>
        <div>
          <dt>Unanswered</dt>
          <dd>{unanswered}</dd>
        </div>
      </dl>
      <p className="submission-save-status" role="status">
        {!ready
          ? 'Preparing answer recovery…'
          : pending
            ? `${pending} answer change${pending === 1 ? '' : 's'} waiting to save. Submission is unavailable until saving completes.`
            : 'All answer changes saved.'}
      </p>
      {saveError && <Notice>{saveError}</Notice>}
      {error && <Notice>{error}</Notice>}
      {expired && (
        <Notice kind="info">
          Time is up. Waiting for the server to confirm your final status.
        </Notice>
      )}
      <div className="submission-list-heading">
        <h3>Question checklist</h3>
        <label className="check-label">
          <input
            type="checkbox"
            checked={unansweredOnly}
            onChange={(e) => setUnansweredOnly(e.target.checked)}
          />
          Unanswered only
        </label>
      </div>
      <ol className="submission-question-list">
        {questions.map((q, i) =>
          unansweredOnly && q.answered ? null : (
            <li key={q.id}>
              <button
                type="button"
                disabled={busy || expired}
                onClick={() => onQuestion(i)}
                aria-label={`Review question ${i + 1}, ${q.answered ? 'answered' : 'unanswered'}`}
              >
                <span className="submission-question-number">{i + 1}</span>
                <span className="submission-question-prompt">{q.prompt}</span>
                <span className={`submission-answer-state ${q.answered ? 'answered' : ''}`}>
                  {q.answered && <Icon name="check" size={14} />}
                  {q.answered ? 'Answered' : 'Unanswered'}
                </span>
                <Icon name="arrow" size={15} />
              </button>
            </li>
          ),
        )}
      </ol>
      {unansweredOnly && !unanswered && (
        <p className="muted small">Every question has an answer.</p>
      )}
      <div className="submission-final">
        <p>
          {unanswered
            ? `${unanswered} question${unanswered === 1 ? ' is' : 's are'} unanswered. You can go back or submit as it is. `
            : ''}
          After submission, you cannot change your answers.
        </p>
        <button
          type="button"
          className="button primary"
          disabled={busy || !ready || pending > 0 || expired}
          onClick={onSubmit}
        >
          {busy ? 'Submitting…' : 'Confirm submission'}
          <Icon name="check" size={16} />
        </button>
      </div>
    </section>
  );
}
