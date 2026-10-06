import { useEffect, useRef, useState } from 'react';
import type { MonitoringSnapshot, MonitorStatus } from '../../packages/contracts/monitoring.ts';
import { api, errorMessage } from './api.ts';
import { Icon, Loading, Notice, formatTime } from './ui.tsx';
import { contactAge, monitorCandidates, monitorLabels } from './monitor-view.ts';
import { ExamControlPanel, CandidateControlActions } from './exam-controls.tsx';

export function ExamMonitor({ id }: { id: string }) {
  const [data, setData] = useState<MonitoringSnapshot | null>(null);
  const [error, setError] = useState('');
  const [fetching, setFetching] = useState(false);
  const [filter, setFilter] = useState<MonitorStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const receivedAt = useRef(0);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      if (!alive || inFlight) return;
      clearTimeout(timer);
      inFlight = true;
      setFetching(true);
      try {
        const result = await api<MonitoringSnapshot>(`/assessments/${id}/monitor`, {
          timeoutMs: 10000,
        });
        if (alive) {
          receivedAt.current = performance.now();
          setElapsed(0);
          setData(result);
          setError('');
        }
      } catch (error) {
        if (alive) setError(errorMessage(error));
      } finally {
        inFlight = false;
        if (alive) {
          setFetching(false);
          timer = setTimeout(() => (document.hidden ? schedule() : void load()), 5000);
        }
      }
    };
    const schedule = () => {
      if (alive) timer = setTimeout(() => (document.hidden ? schedule() : void load()), 5000);
    };
    const wake = () => {
      if (!document.hidden) void load();
    };
    refresh.current = () => void load();
    void load();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
    };
  }, [id]);
  useEffect(() => {
    const timer = setInterval(
      () => setElapsed(receivedAt.current ? performance.now() - receivedAt.current : 0),
      1000,
    );
    return () => clearInterval(timer);
  }, []);
  const stale = Boolean(error || (data && elapsed >= 15000));
  const now = data ? (data.controls?.pausedAt ?? data.serverNow + elapsed) : 0;
  const ended = Boolean(data?.deadline && now >= data.deadline);
  const visible = data ? monitorCandidates(data.candidates, filter, search) : [];
  const counts = Object.fromEntries(
    Object.keys(monitorLabels).map((status) => [
      status,
      data?.candidates.filter((c) => c.status === status).length ?? 0,
    ]),
  );
  const time = (at: number | null) =>
    at === null
      ? '—'
      : new Date(at).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
  return (
    <section className="exam-monitor" aria-label="Examination monitoring">
      <div className="monitor-heading">
        <div>
          <h2>
            {ended
              ? 'Examination summary'
              : data && !data.deadline
                ? 'Candidate readiness'
                : 'Live monitoring'}
          </h2>
          <span className={'monitor-freshness' + (stale ? ' stale' : '')} role="status">
            <span className="status-dot" />
            {stale
              ? 'Updates interrupted · showing last received status'
              : data
                ? 'Updates automatically'
                : 'Connecting…'}
          </span>
        </div>
        <div className="monitor-heading-actions">
          {data?.deadline && (
            <div className="monitor-time">
              <span>
                {data.controls?.pausedAt != null
                  ? 'Paused · time remaining'
                  : ended
                    ? 'Time completed'
                    : data.timingMode === 'individual'
                      ? 'Window remaining'
                      : 'Time remaining'}
              </span>
              <strong className="tabular">{formatTime(Math.max(0, data.deadline - now))}</strong>
            </div>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={fetching}
            onClick={() => refresh.current()}
          >
            {fetching ? 'Updating…' : 'Refresh'}
          </button>
        </div>
      </div>
      {data?.timingMode === 'individual' && data.lastStartAt && (
        <p className="field-hint">
          Individual timers ·{' '}
          {data.opensAt && now < data.opensAt
            ? `Opens ${new Date(data.opensAt).toLocaleString()}.`
            : now < data.lastStartAt
              ? `New attempts may begin before ${new Date(data.lastStartAt).toLocaleString()}.`
              : 'The start window is closed. Existing attempts continue until their own deadlines.'}
        </p>
      )}
      {error && (
        <Notice>
          Monitoring could not update.{' '}
          {data ? 'Statuses below are from the last successful update. ' : ''}
          {error}
        </Notice>
      )}
      {data && (
        <ExamControlPanel id={id} data={data} stale={stale} onChange={() => refresh.current()} />
      )}
      {!data ? (
        error ? null : (
          <Loading />
        )
      ) : (
        <>
          <div
            className="monitor-status-filters"
            role="group"
            aria-label="Filter candidates by status"
          >
            {(['all', 'disconnected', 'active', 'waiting', 'submitted', 'expired'] as const).map(
              (status) => (
                <button
                  type="button"
                  key={status}
                  className={'monitor-stat ' + status + (filter === status ? ' selected' : '')}
                  aria-pressed={filter === status}
                  onClick={() => setFilter(status)}
                >
                  <span>{status === 'all' ? 'All candidates' : monitorLabels[status]}</span>
                  <strong>{status === 'all' ? data.candidates.length : counts[status]}</strong>
                </button>
              ),
            )}
          </div>
          <div className="monitor-candidate-panel">
            <div className="monitor-tools">
              <div>
                <h3>Candidates</h3>
                <span className="muted small">
                  {visible.length} of {data.candidates.length} · Needs attention first
                </span>
              </div>
              <label className="search">
                <Icon name="search" size={17} />
                <input
                  type="search"
                  aria-label="Search candidates by name or number"
                  placeholder="Search name or candidate number"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
            </div>
            {visible.length ? (
              <div className="table-wrap">
                <table className="monitor-table">
                  <thead>
                    <tr>
                      <th>Candidate</th>
                      <th>Status</th>
                      <th>Saved answers</th>
                      <th>Last contact</th>
                      <th>
                        <span className="sr-only">Candidate details</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((candidate) => (
                      <CandidateRows
                        key={candidate.id}
                        candidate={candidate}
                        count={data.questionCount}
                        now={data.serverNow + elapsed}
                        snapshot={data}
                        expanded={expanded === candidate.id}
                        onToggle={() =>
                          setExpanded(expanded === candidate.id ? null : candidate.id)
                        }
                        time={time}
                        assessmentId={id}
                        stale={stale}
                        onChange={() => refresh.current()}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="monitor-empty">
                <h3>
                  {data.candidates.length ? 'No matching candidates' : 'No candidates admitted yet'}
                </h3>
                <p className="muted small">
                  {data.candidates.length
                    ? 'Try a different name, candidate number, or status.'
                    : 'Admitted candidates will appear here automatically.'}
                </p>
                {data.candidates.length > 0 && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setFilter('all');
                      setSearch('');
                    }}
                  >
                    Clear search & filter
                  </button>
                )}
              </div>
            )}
            <p className="monitor-footnote">
              Disconnected means no contact for {data.disconnectAfterMs / 1000} seconds. Saved
              answers remain recorded; connection status is not evidence of misconduct.
            </p>
          </div>
        </>
      )}
    </section>
  );
}

function CandidateRows({
  candidate,
  count,
  now,
  snapshot,
  expanded,
  onToggle,
  time,
  assessmentId,
  stale,
  onChange,
}: {
  candidate: MonitoringSnapshot['candidates'][number];
  count: number;
  now: number;
  snapshot: MonitoringSnapshot;
  expanded: boolean;
  onToggle: () => void;
  time: (at: number | null) => string;
  assessmentId: string;
  stale: boolean;
  onChange: () => void;
}) {
  const waitingConnected =
    candidate.status === 'waiting' &&
    candidate.lastSeenAt !== null &&
    snapshot.serverNow - candidate.lastSeenAt < snapshot.disconnectAfterMs;
  return (
    <>
      <tr className={candidate.status === 'disconnected' ? 'monitor-attention-row' : ''}>
        <td>
          <strong>{candidate.name}</strong>
          <small className="block muted">{candidate.identifier}</small>
        </td>
        <td>
          <span className={'monitor-candidate-status ' + candidate.status}>
            <span className="status-dot" />
            {monitorLabels[candidate.status]}
          </span>
          {waitingConnected && <small className="block muted">Connected · not started</small>}
          {candidate.status === 'expired' && !candidate.startedAt && (
            <small className="block muted">Did not start</small>
          )}
          {candidate.deadline && ['active', 'disconnected'].includes(candidate.status) && (
            <small className="block muted tabular">
              {formatTime(Math.max(0, candidate.deadline - (snapshot.controls?.pausedAt ?? now)))}{' '}
              left
            </small>
          )}
        </td>
        <td>
          <div className="monitor-progress">
            <span>
              {candidate.answered} <span className="muted">/ {count}</span>
            </span>
            <progress
              max={count || 1}
              value={candidate.answered}
              aria-label={`${candidate.name}: ${candidate.answered} of ${count} answers saved`}
            />
          </div>
        </td>
        <td>
          <span
            title={
              candidate.lastSeenAt === null
                ? undefined
                : new Date(candidate.lastSeenAt).toLocaleString()
            }
          >
            {contactAge(candidate.lastSeenAt, now)}
          </span>
        </td>
        <td>
          <button
            type="button"
            className="monitor-details-toggle"
            aria-expanded={expanded}
            aria-controls={'monitor-details-' + candidate.id}
            aria-label={`${expanded ? 'Hide' : 'View'} details for ${candidate.name}`}
            onClick={onToggle}
          >
            <Icon name="chevron" size={16} />
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="monitor-detail-row">
          <td colSpan={5}>
            <div id={'monitor-details-' + candidate.id}>
              <dl className="monitor-candidate-details">
                <div>
                  <dt>Started</dt>
                  <dd>{time(candidate.startedAt)}</dd>
                </div>
                <div>
                  <dt>Last answer saved</dt>
                  <dd>{time(candidate.lastSavedAt)}</dd>
                </div>
                <div>
                  <dt>Submitted</dt>
                  <dd>{time(candidate.submittedAt)}</dd>
                </div>
                <div>
                  <dt>Connections restored</dt>
                  <dd>{candidate.reconnects}</dd>
                </div>
              </dl>
              <CandidateControlActions
                id={assessmentId}
                candidate={candidate}
                data={snapshot}
                stale={stale}
                onChange={onChange}
              />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
