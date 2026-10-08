import { useEffect, useState } from 'react';
import { useCandidateOrigin } from './local-delivery.tsx';
import { RerunAssessment } from './assessment-editor.tsx';
import type { AssessmentDetail, Summary } from '../../packages/contracts/http.ts';
import { api, errorMessage } from './api.ts';
import { Badge, Dialog, Icon, Loading, Notice, formatTime } from './ui.tsx';
import { RegistrationAdmin } from './registration-admin.tsx';
import { ManualReview } from './manual-review.tsx';
import { AssessmentRoster } from './rosters.tsx';
import { ExamMonitor } from './monitoring.tsx';
import { AdmissionControl } from './admission-control.tsx';
import { TimingSummary } from './timing-fields.tsx';
import { AuthoringSaveStatus, ContinueDrafting } from './authoring.tsx';
import { PrepareLocalAssessment } from './local-preparation.tsx';
import { OnlineDelivery } from './online-delivery.tsx';

export function Dashboard({ name, online = false }: { name: string; online?: boolean }) {
  const [items, setItems] = useState<Summary[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const data = await api<{ assessments: Summary[] }>('/assessments');
        if (alive) setItems(data.assessments);
        if (online) {
          const cloud = await api<{ examinations: Summary[] }>('/online/assessments');
          const ids = new Set(cloud.examinations.map((exam) => exam.id));
          data.assessments = [
            ...data.assessments.filter((exam) => !ids.has(exam.id)),
            ...cloud.examinations,
          ];
        }
        if (alive) {
          setItems(data.assessments);
          setError('');
        }
      } catch (error) {
        if (alive) setError(errorMessage(error));
      }
    }
    void load();
    const timer = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [online]);
  const visible =
    items?.filter(
      (item) =>
        (filter === 'all' || item.status === filter) &&
        `${item.title} ${item.course}`.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR ASSESSMENT WORKSPACE</span>
          <h1>Good to see you, {name.split(' ')[0]}.</h1>
          <p className="muted">From the first question to the final answer. All in one place.</p>
        </div>
        <a className="button primary" href="/assessments/new">
          <Icon name="plus" size={17} />
          Create assessment
        </a>
      </div>
      {error && <Notice>{error}</Notice>}
      <AuthoringSaveStatus />
      <ContinueDrafting />
      {!items ? (
        <Loading />
      ) : (
        <>
          <section className="stats" aria-label="Assessment statistics">
            {[
              ['Total assessments', items.length, 'paper'],
              ['In progress', items.filter((i) => i.status === 'active').length, 'clock'],
              ['Drafts', items.filter((i) => i.status === 'draft').length, 'grid'],
              ['Completed', items.filter((i) => i.status === 'completed').length, 'check'],
            ].map(([label, value, icon]) => (
              <div className="stat" key={label}>
                <div>
                  <span>{label}</span>
                  <Icon name={String(icon)} size={17} />
                </div>
                <strong>{value}</strong>
              </div>
            ))}
          </section>
          <section className="assessment-section">
            <div className="section-heading">
              <div>
                <h2>Assessments</h2>
                <p className="muted small">Prepare, run, and review your examinations.</p>
              </div>
              <label className="search">
                <Icon name="search" size={17} />
                <input
                  aria-label="Search assessments"
                  type="search"
                  placeholder="Search assessments…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
            </div>
            <div className="tabs" aria-label="Filter assessments">
              {[
                ['all', 'All assessments'],
                ['draft', 'Drafts'],
                ['active', 'In progress'],
                ['completed', 'Completed'],
              ].map(([value, label]) => (
                <button
                  key={value}
                  className={filter === value ? 'tab current' : 'tab'}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {label}
                  <span>
                    {value === 'all'
                      ? items.length
                      : items.filter((i) => i.status === value).length}
                  </span>
                </button>
              ))}
            </div>
            {visible.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Assessment</th>
                      <th>Status</th>
                      <th>Candidates</th>
                      <th>Duration</th>
                      <th>
                        <span className="sr-only">Open</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <a
                            className="assessment-name"
                            href={`/${item.delivery === 'online' ? 'online/' : ''}assessments/${item.id}${item.status === 'completed' ? '?tab=results' : ''}`}
                          >
                            <span className="paper-icon">
                              <Icon name="paper" />
                            </span>
                            <span>
                              <strong>{item.title}</strong>
                              <small>
                                {item.course} <span>·</span> {item.questionCount} questions
                              </small>
                            </span>
                          </a>
                        </td>
                        <td>
                          <Badge status={item.status} />
                        </td>
                        <td>{item.candidateCount}</td>
                        <td>{item.durationMinutes} min</td>
                        <td>
                          <a
                            className={
                              item.status === 'completed' ? 'button secondary' : 'icon-button'
                            }
                            aria-label={`${item.status === 'completed' ? 'View results for' : 'Open'} ${item.title}`}
                            href={`/${item.delivery === 'online' ? 'online/' : ''}assessments/${item.id}${item.status === 'completed' ? '?tab=results' : ''}`}
                          >
                            {item.status === 'completed' && 'View results'}
                            <Icon name="arrow" size={18} />
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-icon">
                  <Icon name="paper" size={30} />
                </div>
                <span className="eyebrow">
                  {items.length ? 'NOTHING HERE YET' : 'A FRESH START'}
                </span>
                <h2>
                  {items.length ? 'No matching assessments' : 'Your first assessment starts here.'}
                </h2>
                <p>
                  {items.length
                    ? 'Try another filter or search term.'
                    : 'Bring your questions and candidates together, then get ready to deliver.'}
                </p>
                {!items.length && (
                  <a href="/assessments/new" className="button primary">
                    <Icon name="plus" size={16} />
                    Create an assessment
                  </a>
                )}
              </div>
            )}
          </section>
          <footer className="workspace-footer">
            <span>
              <Icon name="shield" size={15} />
              Your workspace. Your assessment records.
            </span>
            <span>MUDU</span>
          </footer>
        </>
      )}
    </>
  );
}

export function Detail({ id }: { id: string }) {
  const [rerun, setRerun] = useState(false);
  const candidateOrigin = useCandidateOrigin();
  const [reviewCandidate, setReviewCandidate] = useState<string | null>(null);
  const [data, setData] = useState<AssessmentDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'launch' | 'end' | null>(null);
  const [tab, setTab] = useState<string | null>(() => {
    const requested = new URLSearchParams(location.search).get('tab');
    return ['overview', 'monitor', 'results', 'questions', 'activity'].includes(requested ?? '')
      ? requested
      : null;
  });
  const [remaining, setRemaining] = useState(0);
  const [copied, setCopied] = useState(false);
  async function load() {
    try {
      const result = await api<AssessmentDetail>(`/assessments/${id}`);
      setData(result);
      setTab(
        (previous) => previous ?? (result.summary.status === 'active' ? 'monitor' : 'overview'),
      );
      setError('');
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  useEffect(() => {
    void load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, [id]);
  useEffect(() => {
    if (!data?.summary.sitting) return;
    const initial =
      data.summary.sitting.deadline - (data.summary.sitting.pausedAt ?? data.serverNow);
    const at = performance.now();
    setRemaining(initial);
    if (data.summary.sitting.pausedAt != null) return;
    const timer = setInterval(
      () => setRemaining(Math.max(0, initial - (performance.now() - at))),
      1000,
    );
    return () => clearInterval(timer);
  }, [data]);
  async function execute() {
    if (!confirm) return;
    setBusy(true);
    setError('');
    try {
      await api(`/assessments/${id}/${confirm}`, { method: 'POST', body: {} });
      if (confirm === 'launch') {
        setTab('monitor');
        const url = new URL(location.href);
        url.searchParams.set('tab', 'monitor');
        history.replaceState(null, '', url.pathname + url.search);
      }
      setConfirm(null);
      await load();
    } catch (error) {
      setError(errorMessage(error));
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  }
  if (!data) return error ? <Notice>{error}</Notice> : <Loading />;
  const { assessment, summary, candidates } = data;
  const online = data.delivery === 'online';
  const detailPath = `/${online ? 'online/' : ''}assessments/${id}`;
  const completed = candidates.filter((c) => c.grade).length;
  return (
    <>
      <a className="back-link" href="/">
        <Icon name="back" size={16} />
        All assessments
      </a>
      <div className="page-heading detail-heading">
        <div>
          <div className="inline">
            <span className="eyebrow">{assessment.course}</span>
            <Badge status={summary.status} />
          </div>
          <h1>{assessment.title}</h1>
          <p className="muted">
            {summary.questionCount} questions <span className="dot-separator">·</span>{' '}
            {summary.candidateCount} candidates <span className="dot-separator">·</span>{' '}
            {online ? 'Online delivery' : 'Local delivery'}
          </p>
        </div>
        <div className="actions">
          {summary.status === 'completed' && (
            <button className="button secondary" onClick={() => setRerun(true)}>
              Run again
            </button>
          )}
          {summary.status === 'draft' ? (
            <>
              {!data.preparedLocalRun && (
                <a className="button secondary" href={`/assessments/${id}/edit`}>
                  Edit assessment
                </a>
              )}
              <button
                className="button primary"
                disabled={data.deliveryReady === false}
                data-disabled-reason={
                  data.deliveryReady === false
                    ? 'Complete the assessment setup and delivery checks before publishing.'
                    : undefined
                }
                onClick={() => setConfirm('launch')}
              >
                {assessment.timing?.mode === 'individual'
                  ? 'Publish assessment'
                  : 'Start examination'}
                <Icon name="arrow" size={17} />
              </button>
            </>
          ) : (
            <>
              {summary.status === 'active' && (
                <button className="button secondary" onClick={() => setConfirm('end')}>
                  End examination
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {error && <Notice>{error}</Notice>}
      {summary.status === 'draft' && !data.preparedLocalRun && (
        <AuthoringSaveStatus id={id} onResolved={() => location.reload()} />
      )}
      {!online && tab === 'overview' && (
        <div className="assessment-delivery" aria-label="Examination delivery">
          <OnlineDelivery id={id} />
          <PrepareLocalAssessment key={id} id={id} />
        </div>
      )}
      {online && (
        <p className="field-hint">
          <a href={`/assessments/${id}`}>Open source assessment</a> to edit or prepare another
          delivery. This examination keeps its published question paper.
        </p>
      )}
      {data.source && (
        <p className="field-hint">
          {data.preparedLocalRun ? 'Prepared local run of' : 'New run of'}{' '}
          <a href={`/assessments/${data.source.id}`}>{data.source.title}</a>. Results are kept
          separately.
        </p>
      )}
      {new URLSearchParams(location.search).get('updated') === '1' && (
        <p className="field-hint" role="status">
          Assessment changes saved.
        </p>
      )}
      {rerun && (
        <RerunAssessment
          id={id}
          title={assessment.title}
          legacy={summary.accessMode === 'legacy'}
          onClose={() => setRerun(false)}
        />
      )}
      <nav className="tabs" aria-label="Assessment sections">
        {(['overview', 'monitor', 'results', 'questions', 'activity'] as const).map((value) => (
          <a
            className={`tab ${tab === value ? 'current' : ''}`}
            key={value}
            href={`${detailPath}?tab=${value}`}
            aria-current={tab === value ? 'page' : undefined}
          >
            {value.charAt(0).toUpperCase() + value.slice(1)}
          </a>
        ))}
      </nav>
      {(data.roster || data.lateRosterAvailable) &&
        (tab === 'overview' || tab === 'monitor') &&
        summary.status !== 'draft' && (
          <AdmissionControl
            id={id}
            enabled={summary.allowLateAdmission ?? false}
            completed={summary.status === 'completed'}
            onChange={load}
          />
        )}
      {tab === 'monitor' && <ExamMonitor key={id} id={id} />}
      {tab === 'overview' && (
        <>
          {data.roster && <AssessmentRoster id={id} onChange={load} />}
          {!online &&
            summary.accessMode === 'accounts' &&
            !data.roster &&
            !data.preparedLocalRun && <RegistrationAdmin assessmentId={id} onChange={load} />}
          {summary.sitting && summary.accessMode === 'legacy' && (
            <section className="join-strip">
              <div>
                <span className="eyebrow">CANDIDATE ACCESS</span>
                <div className="join-code">{summary.sitting.code}</div>
                <p className="muted small">
                  Candidates need this code, their ID, and their access key.
                </p>
              </div>
              <div>
                <a
                  className="button secondary"
                  href={`${candidateOrigin}/exam?code=${summary.sitting.code}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open candidate access
                  <Icon name="arrow" size={16} />
                </a>
                <button
                  className="text-button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        `${candidateOrigin}/exam?code=${summary.sitting!.code}`,
                      );
                      setCopied(true);
                    } catch {
                      setError(
                        'Could not copy the link. Open candidate access and copy its address.',
                      );
                    }
                  }}
                >
                  {copied ? 'Link copied' : 'Copy candidate link'}
                </button>
              </div>
            </section>
          )}
          <section className="stats">
            <div className="stat">
              <div>
                <span>
                  {summary.status === 'active'
                    ? summary.sitting?.pausedAt != null
                      ? 'Paused · time remaining'
                      : assessment.timing?.mode === 'individual'
                        ? 'Window remaining'
                        : 'Time remaining'
                    : 'Duration'}
                </span>
                <Icon name="clock" size={17} />
              </div>
              <strong className="tabular">
                {summary.status === 'active'
                  ? formatTime(remaining)
                  : `${assessment.durationMinutes} min`}
              </strong>
            </div>
            <div className="stat">
              <div>
                <span>Submitted / expired</span>
                <Icon name="check" size={17} />
              </div>
              <strong>
                {completed}
                <small> / {candidates.length}</small>
              </strong>
            </div>
            <div className="stat">
              <div>
                <span>Maximum marks</span>
                <Icon name="paper" size={17} />
              </div>
              <strong>{assessment.questions.reduce((sum, q) => sum + q.marks, 0)}</strong>
            </div>
            <div className="stat">
              <div>
                <span>Pass mark</span>
                <Icon name="grid" size={17} />
              </div>
              <strong>
                {assessment.passPercent}
                <small>%</small>
              </strong>
            </div>
          </section>
          <dl className="summary-list panel padded">
            <TimingSummary timing={assessment.timing} duration={assessment.durationMinutes} />
          </dl>
          <div className="section-heading">
            <h2>Candidates</h2>
            <a className="button secondary" href={`${detailPath}?tab=monitor`}>
              {summary.status === 'active' ? 'Open live monitoring' : 'View candidate status'}{' '}
              <Icon name="arrow" size={16} />
            </a>
          </div>
        </>
      )}
      {tab === 'results' && (
        <>
          <div className="section-heading">
            <div>
              <h2>Results</h2>
              <p className="muted small">
                Review scores, mark written answers, and export results.
              </p>
            </div>
            {completed > 0 && (
              <a className="button primary" href={`/api${detailPath}/results.csv`}>
                <Icon name="download" size={17} />
                Export results
              </a>
            )}
          </div>
          <section className="panel padded results-summary" aria-label="Results summary">
            <div>
              <span className="muted small">Completed submissions</span>
              <strong>
                {completed} / {candidates.length}
              </strong>
            </div>
            <div>
              <span className="muted small">Awaiting marking</span>
              <strong>{candidates.filter((c) => c.grade?.pendingManual).length}</strong>
            </div>
            <div>
              <span className="muted small">Final results</span>
              <strong>{candidates.filter((c) => c.grade && !c.grade.pendingManual).length}</strong>
            </div>
          </section>
          {completed === 0 && (
            <p className="panel padded muted">
              No results yet. Scores will appear here when candidates submit or their time expires.
            </p>
          )}
        </>
      )}
      {tab === 'results' && reviewCandidate && (
        <ManualReview
          key={reviewCandidate}
          assessmentId={id}
          candidateId={reviewCandidate}
          onChange={load}
          onClose={() => setReviewCandidate(null)}
        />
      )}
      {tab === 'results' && completed > 0 && !reviewCandidate && (
        <div className="table-wrap panel">
          <table>
            <thead>
              <tr>
                <th>Candidate</th>
                <th>Status</th>
                <th>Score</th>
                <th>Result</th>
                <th>Review</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((candidate) => (
                <tr key={candidate.id}>
                  <td>
                    <strong>{candidate.name}</strong>
                    <small className="block muted">{candidate.identifier}</small>
                  </td>
                  <td>
                    <Badge status={candidate.status} />
                  </td>
                  <>
                    <td>
                      {candidate.grade
                        ? `${candidate.grade.totalScore} / ${candidate.grade.maximumScore}${candidate.grade.pendingManual ? ' (provisional)' : ''}`
                        : '—'}
                    </td>
                    <td>
                      {!candidate.grade ? (
                        '—'
                      ) : candidate.grade.pendingManual ? (
                        <span className="muted">Needs manual review</span>
                      ) : (
                        <Badge status={candidate.grade.passed ? 'passed' : 'failed'} />
                      )}
                    </td>
                    <td>
                      {candidate.grade && assessment.questions.some((q) => q.type === 'short') && (
                        <button
                          className="button secondary"
                          onClick={() => setReviewCandidate(candidate.id)}
                        >
                          {candidate.grade.pendingManual ? 'Review answers' : 'View marks'}
                        </button>
                      )}
                    </td>
                  </>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tab === 'questions' && (
        <div className="question-list">
          {assessment.instructions && (
            <div className="panel padded">
              <h3>Instructions</h3>
              <p className="pre-wrap muted">{assessment.instructions}</p>
            </div>
          )}
          {assessment.questions.map((q, i) => (
            <article key={q.id} className="panel padded">
              <div className="inline between">
                <span className="eyebrow">
                  QUESTION {i + 1} ·{' '}
                  {q.type === 'single'
                    ? 'SINGLE CHOICE'
                    : q.type === 'multiple'
                      ? 'MULTIPLE SELECT'
                      : 'SHORT ANSWER'}
                </span>
                <span className="muted small">{q.marks} marks</span>
              </div>
              <h3 className="pre-wrap">{q.prompt}</h3>
              {q.options.map((option) => (
                <div
                  className={`preview-option ${q.correctOptionIds.includes(option.id) ? 'correct' : ''}`}
                  key={option.id}
                >
                  {option.text}
                  {q.correctOptionIds.includes(option.id) && <Icon name="check" size={16} />}
                </div>
              ))}
            </article>
          ))}
        </div>
      )}
      {tab === 'activity' && (
        <div className="panel padded">
          <h3>Recent examination events</h3>
          {data.events.length ? (
            data.events.map((event) => (
              <div className="event-row" key={event.id}>
                <div>
                  <span>
                    {event.kind.replaceAll('_', ' ')}
                    {event.candidateName ? ` · ${event.candidateName}` : ''}
                    {event.minutes ? ` · +${event.minutes} minutes` : ''}
                  </span>
                  {event.reason && <p className="field-hint">{event.reason}</p>}
                </div>
                <time>{new Date(event.createdAt).toLocaleTimeString()}</time>
              </div>
            ))
          ) : (
            <p className="muted">Events will appear when the examination starts.</p>
          )}
        </div>
      )}
      {confirm && (
        <Dialog
          title={confirm === 'launch' ? 'Ready to begin?' : 'End this examination?'}
          confirmLabel={
            confirm === 'launch'
              ? assessment.timing?.mode === 'individual'
                ? 'Publish assessment'
                : 'Start examination'
              : 'End and submit saved answers'
          }
          onClose={() => setConfirm(null)}
          confirm={execute}
          busy={busy}
          danger={confirm === 'end'}
        >
          {confirm === 'launch' ? (
            <>
              <p>
                {assessment.timing?.mode === 'individual'
                  ? `Candidates may begin during the configured availability window. Each gets ${assessment.durationMinutes} minutes from clicking Begin examination, subject to any finish-by deadline.`
                  : `The ${assessment.durationMinutes}-minute clock starts for everyone immediately. Late arrivals receive the remaining time.`}
              </p>
              <p>
                Make sure candidates have their sign-in details. Questions and timing settings are
                fixed after publication; late admission can still be controlled separately.
              </p>
            </>
          ) : (
            <p>
              All active attempts will be submitted using answers already saved on the Host. Pending
              changes on disconnected devices cannot be included. This action cannot be undone.
            </p>
          )}
        </Dialog>
      )}
    </>
  );
}
