import { useEffect, useState } from 'react';
import { api, errorMessage } from './api.ts';
import { Loading, Notice } from './ui.tsx';

interface ReviewQuestion {
  id: string;
  prompt: string;
  answer: string;
  maximum: number;
  score: number | null;
  revision: number;
}
interface Review {
  candidate: { name: string; identifier: string };
  questions: ReviewQuestion[];
}

export function ManualReview({
  assessmentId,
  candidateId,
  onChange,
  onClose,
}: {
  assessmentId: string;
  candidateId: string;
  onChange: () => Promise<void>;
  onClose: () => void;
}) {
  const [data, setData] = useState<Review | null>(null);
  const [error, setError] = useState('');
  const endpoint = `/assessments/${assessmentId}/review/${candidateId}`;
  useEffect(() => {
    let active = true;
    void api<Review>(endpoint)
      .then((value) => {
        if (active) setData(value);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [endpoint]);
  return (
    <section className="panel padded" aria-label="Manual marking">
      <div className="section-heading">
        <div>
          <h2>Review written answers</h2>
          {data && (
            <p className="muted">
              {data.candidate.name} · {data.candidate.identifier}
            </p>
          )}
        </div>
        <button className="button secondary" onClick={onClose}>
          Back to results
        </button>
      </div>
      <p className="field-hint">
        Save a mark for each answer. Unanswered questions receive zero automatically. Results remain
        provisional until all written answers are marked.
      </p>
      {error && <Notice>{error}</Notice>}
      {!data && !error && <Loading />}
      {data?.questions.map((q, i) => (
        <MarkQuestion
          key={q.id}
          question={q}
          number={i + 1}
          endpoint={endpoint}
          onSaved={onChange}
        />
      ))}
    </section>
  );
}

function MarkQuestion({
  question: q,
  number,
  endpoint,
  onSaved,
}: {
  question: ReviewQuestion;
  number: number;
  endpoint: string;
  onSaved: () => Promise<void>;
}) {
  const [score, setScore] = useState(q.score === null ? '' : String(q.score));
  const [revision, setRevision] = useState(q.revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(q.score !== null);
  return (
    <article className="manual-answer">
      <span className="eyebrow">
        WRITTEN QUESTION {number} · {q.maximum} MARKS
      </span>
      <h3 className="pre-wrap">{q.prompt}</h3>
      <div className="manual-response pre-wrap">
        {q.answer.trim() ? q.answer : 'No answer submitted.'}
      </div>
      <form
        className="manual-mark-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          try {
            await api(endpoint, {
              method: 'POST',
              body: { questionId: q.id, score: Number(score), expectedRevision: revision },
            });
            setRevision(revision + 1);
            setSaved(true);
            await onSaved();
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Marks out of {q.maximum}
          <input
            aria-label={`Marks for written question ${number}`}
            type="number"
            required
            min="0"
            max={q.maximum}
            step="any"
            value={score}
            disabled={busy}
            onChange={(e) => {
              setScore(e.target.value);
              setSaved(false);
            }}
          />
        </label>
        <button className="button primary" disabled={busy || saved}>
          {busy ? 'Saving…' : saved ? 'Saved' : 'Save mark'}
        </button>
        <span role="status" className="muted small">
          {saved ? 'Mark saved' : score !== '' ? 'Unsaved mark' : ''}
        </span>
      </form>
      {error && <Notice>{error}</Notice>}
    </article>
  );
}
