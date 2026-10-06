import { useEffect, useState } from 'react';
import { bankCloudUpdated } from './bank-cloud-status.tsx';
import type {
  BankItem,
  BankPage,
  BankQuestion,
  BankStatus,
  BankProject,
} from '../../packages/contracts/question-bank.ts';
import { questionTypes } from '../../packages/contracts/question-bank.ts';
import { api, errorMessage } from './api.ts';
import { Dialog, Icon, Loading, Notice } from './ui.tsx';
import { authorHref, ProjectDialog, ProjectDirectory } from './bank-projects.tsx';

export function QuestionPreview({
  item,
  showPrompt = true,
}: {
  item: BankItem;
  showPrompt?: boolean;
}) {
  return (
    <div className="bank-preview">
      {showPrompt && <p className="bank-prompt">{item.question.prompt}</p>}
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
      {!showPrompt && item.question.type === 'short' && !item.explanation && (
        <p className="field-hint">No marking guidance added.</p>
      )}
    </div>
  );
}

function BankBrowser({
  project,
  picker = false,
  selected = [],
  onSelection,
  onMove,
  onReview,
}: {
  project: BankProject;
  picker?: boolean;
  selected?: BankItem[];
  onSelection?: (items: BankItem[]) => void;
  onMove?: () => void;
  onReview?: (action: 'approve' | 'delete') => void;
}) {
  const initial = picker ? new URLSearchParams() : new URLSearchParams(location.search);
  const initialStatus = initial.get('status');
  const [status, setStatus] = useState<BankStatus | 'all'>(
    !picker && ['all', 'approved', 'draft', 'archived'].includes(initialStatus ?? '')
      ? (initialStatus as BankStatus | 'all')
      : picker
        ? 'approved'
        : 'all',
  );
  const [search, setSearch] = useState(initial.get('q') ?? '');
  const [query, setQuery] = useState(initial.get('q') ?? '');
  const [type, setType] = useState(initial.get('type') ?? '');
  const [difficulty, setDifficulty] = useState(initial.get('difficulty') ?? '');
  const [filtersOpen, setFiltersOpen] = useState(
    Boolean(initial.get('type') || initial.get('difficulty')),
  );
  const [offset, setOffset] = useState(Math.max(0, Math.floor(Number(initial.get('offset')) || 0)));
  const [data, setData] = useState<BankPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const reload = () => setRetry((value) => value + 1);
    window.addEventListener(bankCloudUpdated, reload);
    return () => window.removeEventListener(bankCloudUpdated, reload);
  }, []);
  const limit = 200;
  useEffect(() => {
    const timer = setTimeout(() => {
      if (search.trim() !== query) {
        setQuery(search.trim());
        setOffset(0);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [search, query]);
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
      projectId: project.id,
    });
    if (status === 'all') params.set('activeOnly', '1');
    if (!picker) {
      const view = new URLSearchParams(location.search);
      for (const [key, value] of Object.entries({
        status,
        q: query,
        type,
        difficulty,
        offset: String(offset),
      })) {
        if (value && !(key === 'offset' && value === '0')) view.set(key, value);
        else view.delete(key);
      }
      history.replaceState(null, '', location.pathname + (view.size ? '?' + view : ''));
    }
    void api<BankPage>('/question-bank?' + params)
      .then((value) => {
        if (alive) {
          if (value.total && offset >= value.total) {
            setOffset(Math.floor((value.total - 1) / 30) * 30);
            return;
          }
          setData(value);
        }
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
  }, [status, query, type, difficulty, offset, retry, project.id, picker]);
  const counts = data?.counts ?? project.counts;
  const total = counts.approved + counts.draft + counts.archived;
  const filterCount = Number(Boolean(type)) + Number(Boolean(difficulty));
  const filtered = Boolean(query || type || difficulty);
  const selectable = Boolean(onSelection && (picker || !project.archived));
  const allOnPage = Boolean(
    data?.items.length && data.items.every((item) => selected.some((q) => q.id === item.id)),
  );
  const pageAddition = data?.items.filter((item) => !selected.some((q) => q.id === item.id)) ?? [];
  function clearFilters() {
    setSearch('');
    setQuery('');
    setType('');
    setDifficulty('');
    setOffset(0);
  }
  function toggle(item: BankItem) {
    onSelection?.(
      selected.some((q) => q.id === item.id)
        ? selected.filter((q) => q.id !== item.id)
        : [...selected, item],
    );
  }
  const titles = {
    all: 'Questions',
    draft: 'Needs review',
    approved: 'Ready to use',
    archived: 'Archived questions',
  };
  return (
    <div
      className={'bank-browser question-workspace' + (picker ? ' question-workspace-picker' : '')}
    >
      {!picker && (
        <div className="question-workspace-heading">
          <div>
            <h2>
              Questions <span>{counts.approved + counts.draft}</span>
            </h2>
            <p>
              {project.archived
                ? 'Browse the questions kept in this project.'
                : counts.draft
                  ? counts.draft +
                    ' question' +
                    (counts.draft === 1 ? ' needs' : 's need') +
                    ' your review before use.'
                  : counts.approved
                    ? 'Approved questions are ready to add to an assessment.'
                    : 'Build a collection you can use again.'}
            </p>
          </div>
          {counts.draft > 0 && status !== 'draft' && (
            <button
              type="button"
              className="question-review-shortcut"
              onClick={() => {
                setStatus('draft');
                clearFilters();
              }}
            >
              Review drafts <Icon name="arrow" size={15} />
            </button>
          )}
        </div>
      )}
      <div className="question-workspace-controls">
        {(total > 0 || filtered || picker) && (
          <>
            {!picker && (
              <div
                className="question-status-tabs"
                role="group"
                aria-label="Filter questions by status"
              >
                {(['all', 'draft', 'approved', 'archived'] as const).map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={status === value ? 'current' : ''}
                    aria-pressed={status === value}
                    onClick={() => {
                      setStatus(value);
                      setOffset(0);
                    }}
                  >
                    {value === 'all'
                      ? 'All questions'
                      : value === 'draft'
                        ? 'Needs review'
                        : value === 'approved'
                          ? 'Ready to use'
                          : 'Archived'}
                    <span>{value === 'all' ? counts.approved + counts.draft : counts[value]}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="question-search-tools">
              <label className="search">
                <Icon name="search" size={17} />
                <input
                  type="search"
                  aria-label="Search questions in this project"
                  placeholder="Search questions or topics"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <button
                type="button"
                className={'question-filter-toggle' + (filtersOpen ? ' current' : '')}
                aria-expanded={filtersOpen}
                onClick={() => setFiltersOpen((value) => !value)}
              >
                <Icon name="settings" size={16} /> Filters{' '}
                {filterCount > 0 && <span>{filterCount}</span>}
              </button>
            </div>
            {filtersOpen && (
              <div className="question-filter-panel">
                <label>
                  Question type
                  <select
                    value={type}
                    onChange={(e) => {
                      setType(e.target.value);
                      setOffset(0);
                    }}
                  >
                    <option value="">All types</option>
                    {Object.entries(questionTypes).map(([value, label]) => (
                      <option value={value} key={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Difficulty
                  <select
                    value={difficulty}
                    onChange={(e) => {
                      setDifficulty(e.target.value);
                      setOffset(0);
                    }}
                  >
                    <option value="">All levels</option>
                    <option value="easy">Easy</option>
                    <option value="medium">Medium</option>
                    <option value="hard">Hard</option>
                  </select>
                </label>
                {filterCount > 0 && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setType('');
                      setDifficulty('');
                      setOffset(0);
                    }}
                  >
                    Reset filters
                  </button>
                )}
              </div>
            )}
          </>
        )}
        {!picker && selectable && selected.length > 0 && (
          <div
            className="question-selection-toolbar"
            role="region"
            aria-label="Selected question actions"
          >
            <span>
              <strong>{selected.length}</strong> selected
            </span>
            <div className="actions">
              <button
                type="button"
                className="button primary"
                disabled={selected.every((item) => item.status === 'approved')}
                onClick={() => onReview?.('approve')}
              >
                <Icon name="check" size={16} />
                Approve
              </button>
              <button type="button" className="button secondary" onClick={onMove}>
                <Icon name="folder" size={16} />
                Move to project
              </button>
              <button
                type="button"
                className="text-button question-delete-action"
                onClick={() => onReview?.('delete')}
              >
                <Icon name="trash" size={16} />
                Delete
              </button>
            </div>
            {selected.length >= limit && (
              <span className="field-hint">Move up to 200 questions at a time.</span>
            )}
          </div>
        )}
      </div>
      {error ? (
        <div className="question-workspace-feedback">
          <Notice>
            {error}{' '}
            <button type="button" className="text-button" onClick={() => setRetry((n) => n + 1)}>
              Try again
            </button>
          </Notice>
        </div>
      ) : !data ? (
        <div className="question-workspace-loading" role="status">
          <span className="spinner" />
          Loading questions…
        </div>
      ) : data.items.length ? (
        <div className="question-workspace-results" aria-busy={loading}>
          <div className="question-list-heading">
            {selectable ? (
              <label className="check-label">
                <input
                  type="checkbox"
                  aria-label="Select all questions on this page"
                  checked={allOnPage}
                  disabled={
                    loading || (!allOnPage && selected.length + pageAddition.length > limit)
                  }
                  ref={(node) => {
                    if (node)
                      node.indeterminate =
                        !allOnPage &&
                        data.items.some((item) => selected.some((q) => q.id === item.id));
                  }}
                  onChange={(e) =>
                    onSelection?.(
                      e.target.checked
                        ? [...selected, ...pageAddition]
                        : selected.filter((q) => !data.items.some((item) => item.id === q.id)),
                    )
                  }
                />
                <span>{filtered ? data.total + ' matching' : titles[status]}</span>
              </label>
            ) : (
              <span>{filtered ? data.total + ' matching questions' : 'Questions'}</span>
            )}
            <span role="status">
              {loading ? 'Updating…' : data.total + ' question' + (data.total === 1 ? '' : 's')}
            </span>
          </div>
          <div className="question-collection-list">
            {data.items.map((item, index) => {
              const checked = selected.some((q) => q.id === item.id);
              const context = '/question-bank/projects/' + project.id + location.search;
              const href = '/question-bank/' + item.id + '?return=' + encodeURIComponent(context);
              return (
                <article
                  key={item.id}
                  className={'collection-question-row' + (checked ? ' is-selected' : '')}
                >
                  <div className="collection-question-leading">
                    {selectable && (
                      <input
                        type="checkbox"
                        aria-label={'Select question: ' + item.question.prompt}
                        checked={checked}
                        disabled={loading || (selected.length >= limit && !checked)}
                        onChange={() => toggle(item)}
                      />
                    )}
                    <span>{String(offset + index + 1).padStart(2, '0')}</span>
                  </div>
                  <div className="collection-question-body">
                    <div className="collection-question-meta">
                      <span className={'question-state ' + item.status}>
                        {item.status === 'draft'
                          ? 'Needs review'
                          : item.status === 'approved'
                            ? 'Ready to use'
                            : 'Archived'}
                      </span>
                      <span>{questionTypes[item.question.type]}</span>
                      <span>
                        {item.question.marks} {item.question.marks === 1 ? 'mark' : 'marks'}
                      </span>
                      <span>{item.difficulty}</span>
                    </div>
                    <h3>
                      {picker ? item.question.prompt : <a href={href}>{item.question.prompt}</a>}
                    </h3>
                    {(item.topic || item.tags.length > 0) && (
                      <p className="collection-question-topic">
                        {[item.topic, ...item.tags.map((t) => '#' + t)].filter(Boolean).join(' · ')}
                      </p>
                    )}
                    <details className="collection-answer-preview">
                      <summary>
                        View answer{item.explanation ? ' & explanation' : ''}
                        <Icon name="chevron" size={14} />
                      </summary>
                      <QuestionPreview item={item} showPrompt={false} />
                    </details>
                  </div>
                  {!picker && (
                    <a className="collection-question-action" href={href}>
                      {project.archived ? 'View' : item.status === 'draft' ? 'Review' : 'Edit'}
                      <Icon name="arrow" size={15} />
                    </a>
                  )}
                </article>
              );
            })}
          </div>
          {(data.total > 30 || offset > 0) && (
            <div className="question-list-pagination">
              <span>
                {offset + 1}–{Math.min(offset + 30, data.total)} of {data.total}
              </span>
              <div className="actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={loading || !offset}
                  onClick={() => setOffset(Math.max(0, offset - 30))}
                >
                  <Icon name="back" size={15} />
                  Previous
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={loading || offset + 30 >= data.total}
                  onClick={() => setOffset(offset + 30)}
                >
                  Next
                  <Icon name="arrow" size={15} />
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="question-workspace-empty">
          <span className="question-empty-icon">
            <Icon name={total ? 'search' : 'paper'} size={27} />
          </span>
          <h3>
            {filtered
              ? 'No questions match your search'
              : !total
                ? 'Start with your first question'
                : status === 'draft'
                  ? 'You’re up to date'
                  : status === 'archived'
                    ? 'No archived questions'
                    : 'No ready-to-use questions yet'}
          </h3>
          <p>
            {filtered
              ? 'Try another keyword, question type or difficulty.'
              : project.archived
                ? 'This archived project has no questions to display.'
                : !total
                  ? 'Upload your course material to generate drafts, or write a question yourself.'
                  : status === 'draft'
                    ? 'There are no drafts waiting for review in this project.'
                    : status === 'archived'
                      ? 'Questions you archive will appear here.'
                      : 'Review and approve your drafts to make them available for assessments.'}
          </p>
          {filtered ? (
            <button type="button" className="button secondary" onClick={clearFilters}>
              Clear search & filters
            </button>
          ) : !picker && !project.archived && !total ? (
            <div className="question-empty-actions">
              <a className="button primary" href={authorHref('generate', project.id)}>
                <Icon name="sparkles" size={17} />
                Generate from notes
              </a>
              <a className="button secondary" href={authorHref('new', project.id)}>
                <Icon name="plus" size={17} />
                Write a question
              </a>
            </div>
          ) : !picker && counts.draft > 0 && status === 'approved' ? (
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setStatus('draft');
                setOffset(0);
              }}
            >
              Review drafts
              <Icon name="arrow" size={15} />
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function QuestionBankPage({ id }: { id: string }) {
  const saved = new URLSearchParams(location.search).get('saved');
  const [project, setProject] = useState<BankProject | null>(null);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState(false);
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<BankItem[]>([]);
  const [moving, setMoving] = useState(false);
  const [target, setTarget] = useState<BankProject | null>(null);
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveError, setMoveError] = useState('');
  const [listVersion, setListVersion] = useState(0);
  const [movedNotice, setMovedNotice] = useState('');
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [projectActionError, setProjectActionError] = useState('');
  const [reviewAction, setReviewAction] = useState<'approve' | 'delete' | null>(null);
  const [bulkReviewed, setBulkReviewed] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState('');
  useEffect(() => {
    const reload = () => setRetry((value) => value + 1);
    window.addEventListener(bankCloudUpdated, reload);
    return () => window.removeEventListener(bankCloudUpdated, reload);
  }, []);
  useEffect(() => {
    let alive = true;
    setError('');
    void api<BankProject>(`/question-bank/projects/${id}`)
      .then((value) => {
        if (alive) setProject(value);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [id, retry]);
  if (error)
    return (
      <div className="bank-page">
        <a className="back-link" href="/question-bank">
          Question bank
        </a>
        <Notice>
          {error}{' '}
          <button type="button" className="text-button" onClick={() => setRetry((n) => n + 1)}>
            Try again
          </button>
        </Notice>
      </div>
    );
  if (!project) return <Loading />;
  return (
    <div className="bank-page project-detail-page">
      <div className="project-navigation-row">
        <nav aria-label="Breadcrumb" className="project-breadcrumb">
          <a href="/question-bank">
            <Icon name="back" size={15} />
            Question bank
          </a>
          <span aria-hidden="true">/</span>
          <span aria-current="page">Project</span>
        </nav>
        <button
          type="button"
          className="project-manage-control"
          aria-label="Project settings"
          aria-haspopup="dialog"
          aria-expanded={settings}
          onClick={() => setSettings(true)}
        >
          <Icon name="settings" size={16} />
          Manage project
        </button>
      </div>
      <header className="project-overview">
        <div className="project-overview-copy">
          <h1>{project.name}</h1>
          <div className="project-overview-meta">
            {project.course && (
              <span className="project-subject">
                <Icon name="folder" size={14} />
                {project.course}
              </span>
            )}
            <span>
              Updated{' '}
              {new Date(project.updatedAt).toLocaleDateString(undefined, {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            </span>
            {project.archived && <span className="question-state archived">Archived</span>}
          </div>
          {project.description &&
            (project.description.length > 160 ? (
              <details className="project-about">
                <summary>
                  About this project
                  <Icon name="chevron" size={14} />
                </summary>
                <p>{project.description}</p>
              </details>
            ) : (
              <p className="project-overview-description">{project.description}</p>
            ))}
        </div>
        {!project.archived && Object.values(project.counts).some((count) => count > 0) && (
          <div className="project-authoring-actions">
            <a className="button secondary" href={authorHref('new', project.id)}>
              <Icon name="plus" size={17} />
              Write question
            </a>
            <a className="button primary" href={authorHref('generate', project.id)}>
              <Icon name="sparkles" size={17} />
              Generate from notes
            </a>
          </div>
        )}
      </header>
      {project.archived && (
        <div className="project-archive-banner">
          <div>
            <strong>This project is archived</strong>
            <p>Restore it to edit questions and use them in assessments.</p>
          </div>
          <button
            type="button"
            className="button secondary"
            disabled={restoreBusy}
            onClick={async () => {
              setRestoreBusy(true);
              setProjectActionError('');
              try {
                setProject(
                  await api<BankProject>('/question-bank/projects', {
                    method: 'POST',
                    body: { ...project, archived: false, expectedRevision: project.revision },
                  }),
                );
              } catch (e) {
                setProjectActionError(errorMessage(e));
              } finally {
                setRestoreBusy(false);
              }
            }}
          >
            {restoreBusy ? 'Restoring…' : 'Restore project'}
          </button>
        </div>
      )}
      {projectActionError && <Notice>{projectActionError}</Notice>}
      {movedNotice && <Notice kind="success">{movedNotice}</Notice>}
      {new URLSearchParams(location.search).has('deleted') && (
        <Notice kind="success">Question deleted.</Notice>
      )}
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
      <section className="project-question-surface" aria-label="Project questions">
        <BankBrowser
          key={`${project.id}.${project.archived}.${listVersion}`}
          project={project}
          selected={selected}
          onSelection={setSelected}
          onReview={(action) => {
            setReviewAction(action);
            setBulkReviewed(false);
            setReviewError('');
          }}
          onMove={() => {
            setMoving(true);
            setTarget(null);
            setMoveError('');
          }}
        />
      </section>
      {reviewAction && (
        <Dialog
          title={`${reviewAction === 'approve' ? 'Approve' : 'Delete'} ${selected.length} selected question${selected.length === 1 ? '' : 's'}?`}
          confirmLabel={reviewAction === 'approve' ? 'Approve selected' : 'Delete selected'}
          danger={reviewAction === 'delete'}
          busy={reviewBusy}
          confirmDisabled={reviewAction === 'approve' && !bulkReviewed}
          onClose={() => setReviewAction(null)}
          confirm={async () => {
            setReviewBusy(true);
            setReviewError('');
            try {
              await api('/question-bank/review', {
                method: 'POST',
                body: {
                  action: reviewAction,
                  reviewed: bulkReviewed,
                  selection: selected.map((item) => ({ id: item.id, revision: item.revision })),
                },
              });
              setMovedNotice(
                `${selected.length} question${selected.length === 1 ? '' : 's'} ${reviewAction === 'approve' ? 'approved' : 'deleted'}.`,
              );
              setSelected([]);
              setReviewAction(null);
              setListVersion((n) => n + 1);
              setRetry((n) => n + 1);
            } catch (e) {
              setReviewError(errorMessage(e));
            } finally {
              setReviewBusy(false);
            }
          }}
        >
          {reviewError && <Notice>{reviewError}</Notice>}
          {reviewAction === 'approve' ? (
            <label className="check-label">
              <input
                type="checkbox"
                checked={bulkReviewed}
                disabled={reviewBusy}
                onChange={(e) => setBulkReviewed(e.target.checked)}
              />
              I have reviewed the selected questions, answers and marks.
            </label>
          ) : (
            <p>
              The selected questions will be removed from this project. Copies already used in
              assessments will stay unchanged.
            </p>
          )}
        </Dialog>
      )}
      {settings && (
        <ProjectDialog
          project={project}
          onClose={() => setSettings(false)}
          onSaved={(value) => {
            setProject(value);
            setSelected([]);
            setSettings(false);
          }}
        />
      )}
      {moving && (
        <Dialog
          title={`Move ${selected.length} question${selected.length === 1 ? '' : 's'}`}
          confirmLabel={target ? `Move to ${target.name}` : 'Choose a destination'}
          confirmDisabled={!target}
          busy={moveBusy}
          onClose={() => setMoving(false)}
          confirm={async () => {
            if (!target) return;
            setMoveBusy(true);
            setMoveError('');
            try {
              const result = await api<{ moved: number }>('/question-bank/move', {
                method: 'POST',
                body: {
                  projectId: target.id,
                  selection: selected.map((item) => ({ id: item.id, revision: item.revision })),
                },
              });
              setMovedNotice(
                `${result.moved} question${result.moved === 1 ? '' : 's'} moved to ${target.name}.`,
              );
              setSelected([]);
              setMoving(false);
              setListVersion((n) => n + 1);
              setRetry((n) => n + 1);
            } catch (e) {
              setMoveError(errorMessage(e));
            } finally {
              setMoveBusy(false);
            }
          }}
        >
          <p className="field-hint">
            Approval status is kept. Questions already used in assessments stay unchanged.
          </p>
          {moveError && <Notice>{moveError}</Notice>}
          <fieldset disabled={moveBusy} className="assessment-fields">
            {target ? (
              <div className="project-move-target">
                <Icon name="folder" size={24} />
                <strong>{target.name}</strong>
                <button type="button" className="text-button" onClick={() => setTarget(null)}>
                  Choose another project
                </button>
              </div>
            ) : (
              <ProjectDirectory onOpen={setTarget} activeOnly excludedId={project.id} />
            )}
          </fieldset>
        </Dialog>
      )}
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
  const [project, setProject] = useState<BankProject | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Dialog
      title="Add from your question bank"
      confirmLabel={
        selected.length
          ? `Add ${selected.length} question${selected.length === 1 ? '' : 's'}`
          : 'Select questions to add'
      }
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
        <p className="field-hint">Choose approved questions from your projects.</p>
        {selected.length > 0 && (
          <div className="bank-selection" aria-live="polite">
            <span>
              {selected.length} selected ·{' '}
              {remaining - selected.length >= 0
                ? `${remaining - selected.length} more can be added`
                : 'Selection exceeds the question limit'}
            </span>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => setSelected([])}
            >
              Clear selection
            </button>
          </div>
        )}
        {error && <Notice>{error}</Notice>}
        {selected.length > remaining && (
          <Notice>You can add {remaining} more questions to this assessment.</Notice>
        )}
        <fieldset disabled={busy} className="assessment-fields">
          {project ? (
            <>
              <div className="project-picker-heading">
                <button type="button" className="text-button" onClick={() => setProject(null)}>
                  <Icon name="back" size={16} />
                  All projects
                </button>
                <h3>{project.name}</h3>
              </div>
              <BankBrowser
                key={project.id}
                project={project}
                picker
                selected={selected}
                onSelection={setSelected}
              />
            </>
          ) : (
            <ProjectDirectory picker onOpen={setProject} />
          )}
        </fieldset>
      </div>
    </Dialog>
  );
}
