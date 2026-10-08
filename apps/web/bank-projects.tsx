import { useEffect, useRef, useState } from 'react';
import type { BankProject, BankProjectsPage } from '../../packages/contracts/question-bank.ts';
import { api, errorMessage } from './api.ts';
import { browserId } from './browser-id.ts';
import { Dialog, Icon, Loading, Notice } from './ui.tsx';
import { bankCloudUpdated } from './bank-cloud-status.tsx';

export const projectHref = (id: string) => `/question-bank/projects/${id}`;
export const authorHref = (action: 'new' | 'generate', id: string) =>
  `/question-bank/${action}?project=${encodeURIComponent(id)}`;

export function ProjectDialog({
  project,
  onClose,
  onSaved,
}: {
  project?: BankProject;
  onClose: () => void;
  onSaved: (value: BankProject) => void;
}) {
  const storageKey = `mudu.bank-project.${project?.id ?? 'new'}`;
  const [draft, setDraft] = useState(() => {
    const empty = {
      id: project?.id ?? browserId(),
      name: project?.name ?? '',
      course: project?.course ?? '',
      description: project?.description ?? '',
      archived: project?.archived ?? false,
      expectedRevision: project?.revision ?? 0,
    };
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
      if (
        saved &&
        /^[a-f0-9-]{36}$/.test(saved.id) &&
        (!project || saved.id === project.id) &&
        ['name', 'course', 'description'].every((k) => typeof saved[k] === 'string') &&
        typeof saved.archived === 'boolean' &&
        Number.isInteger(saved.expectedRevision)
      )
        return saved as typeof empty;
    } catch {}
    return empty;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    try {
      if (
        project &&
        draft.name === project.name &&
        draft.course === project.course &&
        draft.description === project.description &&
        draft.archived === project.archived
      )
        sessionStorage.removeItem(storageKey);
      else sessionStorage.setItem(storageKey, JSON.stringify(draft));
    } catch {}
  }, [draft, storageKey, project]);
  async function save() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const saved = await api<BankProject>('/question-bank/projects', {
        method: 'POST',
        body: draft,
      });
      try {
        sessionStorage.removeItem(storageKey);
      } catch {}
      onSaved(saved);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={project ? 'Project settings' : 'New project'}
      confirmLabel={project ? 'Save changes' : 'Create project'}
      busy={busy}
      onClose={onClose}
      confirm={() => form.current?.requestSubmit()}
    >
      <form
        ref={form}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {error && <Notice>{error}</Notice>}
        <fieldset
          disabled={busy}
          data-disabled-reason={busy ? 'Please wait while the project is being saved.' : undefined}
          className="assessment-fields"
        >
          <label>
            Project name
            <input
              autoFocus
              required
              maxLength={120}
              value={draft.name}
              placeholder="e.g. Pharmacology · Midterm questions"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label>
            Course or subject <span className="muted small">Optional</span>
            <input
              maxLength={100}
              value={draft.course}
              placeholder="e.g. PCH 401"
              onChange={(e) => setDraft({ ...draft, course: e.target.value })}
            />
          </label>
          <label>
            Description <span className="muted small">Optional</span>
            <textarea
              rows={3}
              maxLength={1000}
              value={draft.description}
              placeholder="What will you keep in this project?"
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </label>
          {project && (
            <label className="check-label project-archive-setting">
              <input
                type="checkbox"
                checked={draft.archived}
                onChange={(e) => setDraft({ ...draft, archived: e.target.checked })}
              />
              <span>
                Archive project
                <span className="field-hint">
                  Keeps your questions and hides them from assessment selection.
                </span>
              </span>
            </label>
          )}
        </fieldset>
      </form>
    </Dialog>
  );
}

export function ProjectDirectory({
  picker = false,
  activeOnly = false,
  excludedId,
  onOpen,
  onCreate,
}: {
  picker?: boolean;
  activeOnly?: boolean;
  excludedId?: string;
  onOpen?: (project: BankProject) => void;
  onCreate?: () => void;
}) {
  const [status, setStatus] = useState('active');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<BankProjectsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const reload = () => setRetry((value) => value + 1);
    window.addEventListener(bankCloudUpdated, reload);
    return () => window.removeEventListener(bankCloudUpdated, reload);
  }, []);
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
    const params = new URLSearchParams({ status, q: query, offset: String(offset) });
    void api<BankProjectsPage>(`/question-bank/projects?${params}`)
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
  }, [status, query, offset, retry]);
  function card(project: BankProject) {
    const total = Object.values(project.counts).reduce((n, count) => n + count, 0);
    return (
      <>
        <div className="project-card-top">
          <span className="project-folder">
            <Icon name="folder" size={21} />
          </span>
          <span className="muted small">
            {total} {total === 1 ? 'question' : 'questions'}
          </span>
        </div>
        <h2>{project.name}</h2>
        {project.course && <p className="project-course">{project.course}</p>}
        {project.description && <p className="project-description">{project.description}</p>}
        <div className="project-card-footer">
          <span>{project.counts.approved} ready to use</span>
          {!picker && <span>{project.counts.draft} to review</span>}
          <Icon name="arrow" size={16} />
        </div>
        {picker && !project.counts.approved && (
          <span className="field-hint">No approved questions yet</span>
        )}
        {!picker && (
          <span className="project-updated">
            Updated{' '}
            {new Date(project.updatedAt).toLocaleDateString(undefined, {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}
          </span>
        )}
      </>
    );
  }
  return (
    <div className="project-directory">
      <div className="project-toolbar">
        {!picker && !activeOnly && (
          <div className="tabs" role="group" aria-label="Project status">
            {(['active', 'archived'] as const).map((value) => (
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
                {value === 'active' ? 'My projects' : 'Archived'}
                <span>{data?.counts[value] ?? '–'}</span>
              </button>
            ))}
          </div>
        )}
        <label className="search">
          <Icon name="search" size={17} />
          <input
            type="search"
            value={search}
            aria-label="Search projects"
            placeholder="Search projects or subjects"
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>
      {error ? (
        <Notice>
          {error}{' '}
          <button type="button" className="text-button" onClick={() => setRetry((n) => n + 1)}>
            Try again
          </button>
        </Notice>
      ) : loading ? (
        <Loading />
      ) : data?.items.length ? (
        <>
          <div className="project-grid">
            {data.items.map((project) =>
              onOpen ? (
                <button
                  type="button"
                  className="project-card"
                  key={project.id}
                  disabled={(picker && !project.counts.approved) || project.id === excludedId}
                  data-disabled-reason={
                    picker && !project.counts.approved
                      ? 'This project has no approved questions to add.'
                      : project.id === excludedId
                        ? 'This is the project you already selected.'
                        : undefined
                  }
                  onClick={() => onOpen(project)}
                >
                  {card(project)}
                </button>
              ) : (
                <a className="project-card" key={project.id} href={projectHref(project.id)}>
                  {card(project)}
                </a>
              ),
            )}
          </div>
          {data.total > 30 && (
            <div className="bank-pagination">
              <span className="muted small">
                {offset + 1}–{Math.min(offset + 30, data.total)} of {data.total} projects
              </span>
              <div className="actions">
                <button
                  type="button"
                  className="text-button"
                  disabled={!offset}
                  data-disabled-reason={!offset ? 'You are already on the first page.' : undefined}
                  onClick={() => setOffset(Math.max(0, offset - 30))}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={offset + 30 >= data.total}
                  data-disabled-reason={
                    offset + 30 >= data.total ? 'There are no more projects to show.' : undefined
                  }
                  onClick={() => setOffset(offset + 30)}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="bank-empty project-empty">
          <Icon name="folder" size={34} />
          <h2>
            {query
              ? 'No matching projects'
              : status === 'archived'
                ? 'No archived projects'
                : picker
                  ? 'Your projects will appear here'
                  : 'A place for your next question set'}
          </h2>
          <p className="muted">
            {query
              ? 'Try another name or subject.'
              : status === 'archived'
                ? 'Archived projects stay here until you restore them.'
                : picker
                  ? 'Create a project in your question bank, then approve the questions you want to use.'
                  : 'Create a project for a course, topic or examination. Keep its questions together and reuse them whenever you need.'}
          </p>
          {query ? (
            <button type="button" className="text-button" onClick={() => setSearch('')}>
              Clear search
            </button>
          ) : onCreate && status === 'active' ? (
            <button type="button" className="button primary" onClick={onCreate}>
              <Icon name="plus" size={17} />
              Create your first project
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function QuestionBankHome() {
  const [creating, setCreating] = useState(false);
  return (
    <div className="bank-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR QUESTION COLLECTIONS</p>
          <h1>Question bank</h1>
          <p className="muted">Organize questions by course, topic or examination.</p>
        </div>
        <button type="button" className="button primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={17} />
          New project
        </button>
      </div>
      <ProjectDirectory onCreate={() => setCreating(true)} />
      {creating && (
        <ProjectDialog
          onClose={() => setCreating(false)}
          onSaved={(project) => {
            location.href = projectHref(project.id);
          }}
        />
      )}
    </div>
  );
}
