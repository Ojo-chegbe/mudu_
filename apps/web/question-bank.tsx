import { useEffect, useState } from 'react';
import type {
  BankItem,
  BankPage,
  BankQuestion,
  BankStatus,
} from '../../packages/contracts/question-bank.ts';
import { questionTypes } from '../../packages/contracts/question-bank.ts';
import { api, errorMessage } from './api.ts';
import { Dialog, Icon, Loading, Notice } from './ui.tsx';

export function QuestionPreview({ item }: { item: BankItem }) {
  return (
    <div className="bank-preview">
      <p className="bank-prompt">{item.question.prompt}</p>
      {!!item.question.options.length && (
        <ol type="A" className="bank-options">
          {item.question.options.map((option, i) => (
            <li key={i} className={item.question.correctIndices.includes(i) ? 'correct' : ''}>
              {option}
              {item.question.correctIndices.includes(i) && (
                <span className="bank-correct">
                  <Icon name="check" size={14} />
                  {item.origin === 'ai' && item.status === 'draft' ? 'Suggested answer' : 'Correct'}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {item.explanation && (
        <div className="bank-explanation">
          <strong>{item.question.type === 'short' ? 'Marking guidance' : 'Explanation'}</strong>
          <p>{item.explanation}</p>
        </div>
      )}
    </div>
  );
}

function BankBrowser({
  picker,
  onSelection,
}: {
  picker?: boolean;
  onSelection?: (items: BankItem[]) => void;
}) {
  const [status, setStatus] = useState<BankStatus>(() => {
    const value = new URLSearchParams(location.search).get('status');
    return !picker && (value === 'draft' || value === 'archived') ? value : 'approved';
  });
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [difficulty, setDifficulty] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<BankPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<BankItem[]>([]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    const params = new URLSearchParams({
      status,
      q: query,
      type,
      difficulty,
      offset: String(offset),
    });
    void api<BankPage>(`/question-bank?${params}`)
      .then((value) => {
        if (alive) setData(value);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [status, query, type, difficulty, offset, retry]);
  function toggle(item: BankItem) {
    const next = selected.some((q) => q.id === item.id)
      ? selected.filter((q) => q.id !== item.id)
      : [...selected, item];
    setSelected(next);
    onSelection?.(next);
  }
  return (
    <div className="bank-browser">
      {!picker && (
        <div className="tabs membership-filters" role="group" aria-label="Question status">
          {(['approved', 'draft', 'archived'] as const).map((value) => (
            <button
              type="button"
              key={value}
              className={`tab${status === value ? ' current' : ''}`}
              aria-pressed={status === value}
              onClick={() => {
                setStatus(value);
                setOffset(0);
              }}
            >
              {value === 'approved'
                ? 'Ready to use'
                : value === 'draft'
                  ? 'Needs review'
                  : 'Archived'}
              <span>{data?.counts[value] ?? '–'}</span>
            </button>
          ))}
        </div>
      )}
      <div className="bank-filters">
        <label className="search">
          <Icon name="search" size={17} />
          <input
            type="search"
            aria-label="Search question bank"
            placeholder="Search questions, subjects or tags"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label>
          <span className="sr-only">Question type</span>
          <select
            aria-label="Question type"
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All question types</option>
            {Object.entries(questionTypes).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Difficulty</span>
          <select
            aria-label="Difficulty"
            value={difficulty}
            onChange={(e) => {
              setDifficulty(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All difficulties</option>
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </select>
        </label>
      </div>
      {picker && selected.length > 0 && (
        <div className="bank-selection" aria-live="polite">
          <span>{selected.length} selected across pages</span>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setSelected([]);
              onSelection?.([]);
            }}
          >
            Clear selection
          </button>
        </div>
      )}
      {error ? (
        <Notice>
          {error}{' '}
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setRetry((n) => n + 1);
              setSelected([]);
              onSelection?.([]);
            }}
          >
            Reload bank
          </button>
        </Notice>
      ) : loading ? (
        <Loading />
      ) : data?.items.length ? (
        <>
          <div className="bank-list">
            {data.items.map((item) => (
              <article key={item.id} className="bank-row">
                {picker && (
                  <input
                    type="checkbox"
                    aria-label={`Select ${item.question.prompt}`}
                    checked={selected.some((q) => q.id === item.id)}
                    onChange={() => toggle(item)}
                  />
                )}
                <div className="bank-row-content">
                  <div className="bank-meta">
                    <span>{questionTypes[item.question.type]}</span>
                    <span>
                      {item.question.marks} {item.question.marks === 1 ? 'mark' : 'marks'}
                    </span>
                    <span>{item.difficulty}</span>
                    {item.origin === 'ai' && <span>AI-assisted</span>}
                  </div>
                  <h3>{item.question.prompt}</h3>
                  <p className="muted small">
                    {[item.course, item.topic, ...item.tags.map((t) => `#${t}`)]
                      .filter(Boolean)
                      .join(' · ') || 'Uncategorised'}
                  </p>
                  <details>
                    <summary>Preview answer & explanation</summary>
                    <QuestionPreview item={item} />
                  </details>
                </div>
                {!picker && (
                  <a className="text-button bank-review-link" href={`/question-bank/${item.id}`}>
                    {status === 'draft' ? 'Review' : 'Edit'}
                    <Icon name="arrow" size={16} />
                  </a>
                )}
              </article>
            ))}
          </div>
          <div className="bank-pagination">
            <span className="muted small">
              {offset + 1}–{Math.min(offset + 30, data.total)} of {data.total}
            </span>
            <div className="actions">
              <button
                type="button"
                className="text-button"
                disabled={!offset}
                onClick={() => setOffset(Math.max(0, offset - 30))}
              >
                Previous
              </button>
              <button
                type="button"
                className="text-button"
                disabled={offset + 30 >= data.total}
                onClick={() => setOffset(offset + 30)}
              >
                Next
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="bank-empty">
          <Icon name="paper" size={30} />
          <h2>
            {query || type || difficulty
              ? 'No matching questions'
              : status === 'draft'
                ? 'Nothing waiting for review'
                : status === 'archived'
                  ? 'No archived questions'
                  : 'Your next assessment starts here'}
          </h2>
          <p className="muted">
            {query || type || difficulty
              ? 'Try a different search or clear your filters.'
              : picker
                ? 'Approve questions in your question bank to make them available here.'
                : status === 'approved'
                  ? 'Write a question or turn your notes into drafts. Review once, then reuse with confidence.'
                  : 'Your questions will appear here when their status changes.'}
          </p>
          {(query || type || difficulty) && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setSearch('');
                setType('');
                setDifficulty('');
                setOffset(0);
              }}
            >
              Clear filters
            </button>
          )}
          {!picker && status === 'approved' && !query && !type && !difficulty && (
            <a className="button secondary" href="/question-bank/new">
              Write your first question
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export function QuestionBankPage() {
  const saved = new URLSearchParams(location.search).get('saved');
  return (
    <div className="bank-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR TEACHING MATERIAL</p>
          <h1>Question bank</h1>
          <p className="muted">Build once. Review carefully. Reuse in any assessment.</p>
        </div>
        <div className="actions">
          <a className="button secondary" href="/question-bank/generate">
            Generate from notes
          </a>
          <a className="button primary" href="/question-bank/new">
            <Icon name="plus" size={17} />
            New question
          </a>
        </div>
      </div>
      {saved && ['draft', 'approved', 'archived'].includes(saved) && (
        <p className="bank-save-confirmation" role="status">
          <Icon name="check" size={17} />
          {saved === 'approved'
            ? 'Question approved. It is ready to use in assessments.'
            : saved === 'archived'
              ? 'Question archived. Existing assessments are unchanged.'
              : 'Draft saved. Review and approve it when you are ready.'}
        </p>
      )}
      <section className="panel padded">
        <BankBrowser />
      </section>
    </div>
  );
}

export function QuestionBankPicker({
  remaining,
  onAdd,
  onClose,
}: {
  remaining: number;
  onAdd: (questions: BankQuestion[]) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<BankItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Dialog
      title="Add from your question bank"
      confirmLabel={`Add ${selected.length || ''} question${selected.length === 1 ? '' : 's'}`}
      confirmDisabled={!selected.length || selected.length > remaining}
      busy={busy}
      onClose={onClose}
      confirm={async () => {
        setBusy(true);
        setError('');
        try {
          const result = await api<{ questions: BankQuestion[] }>('/question-bank/select', {
            method: 'POST',
            body: { selection: selected.map((q) => ({ id: q.id, revision: q.revision })) },
          });
          onAdd(result.questions);
          onClose();
        } catch (e) {
          setError(errorMessage(e));
          setBusy(false);
        }
      }}
    >
      <div className="bank-picker">
        <p className="field-hint">
          Only approved questions are shown. Independent copies are added to your paper; bank edits
          will not change this assessment.
        </p>
        {error && <Notice>{error}</Notice>}
        {selected.length > remaining && (
          <Notice>You can add {remaining} more questions to this assessment.</Notice>
        )}
        <BankBrowser picker onSelection={setSelected} />
      </div>
    </Dialog>
  );
}
