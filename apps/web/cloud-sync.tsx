import { useEffect, useRef, useState } from 'react';
import type {
  CloudExamRecord,
  CloudRecordSummary,
  CloudSyncStatus,
  SyncItem,
} from '../../packages/contracts/cloud-sync.ts';
import { api, ApiError, errorMessage } from './api.ts';
import { Icon, Loading, Notice } from './ui.tsx';
import { queueSelectedExams, selectableExams } from './cloud-sync-selection.ts';

const labels: Record<SyncItem['state'], string> = {
  pending: 'Queued',
  uploading: 'Uploading',
  retry: 'Waiting to retry',
  conflict: 'Needs attention',
  synced: 'Synced',
};
export function CloudSyncPage({ recordId }: { recordId?: string }) {
  const [status, setStatus] = useState<CloudSyncStatus | null>(null),
    [records, setRecords] = useState<CloudRecordSummary[]>([]);
  const [record, setRecord] = useState<CloudExamRecord | null>(null),
    [selection, setSelection] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<'local' | 'cloud'>(recordId ? 'cloud' : 'local');
  const [error, setError] = useState(''),
    [cloudError, setCloudError] = useState(''),
    [setup, setSetup] = useState(false);
  const [busy, setBusy] = useState(false),
    [loadingRecords, setLoadingRecords] = useState(false),
    [more, setMore] = useState(false);
  const [queueProgress, setQueueProgress] = useState<{ queued: number; total: number } | null>(
    null,
  );
  const selectAll = useRef<HTMLInputElement>(null),
    operationPending = useRef(false);
  const mounted = useRef(true),
    polling = useRef(false),
    syncedStamp = useRef(''),
    recordsLoaded = useRef(false),
    recordsPending = useRef(false);
  async function loadRecords(offset = 0) {
    if (recordsPending.current) return;
    recordsPending.current = true;
    setLoadingRecords(true);
    try {
      const value = await api<{ records: CloudRecordSummary[] }>(
        `/cloud-sync/records?offset=${offset}`,
        { timeoutMs: 30000 },
      );
      if (!mounted.current) return;
      setRecords((previous) =>
        offset
          ? [...previous, ...value.records.filter((r) => !previous.some((p) => p.id === r.id))]
          : value.records,
      );
      setMore(value.records.length === 20);
      setCloudError('');
      setSetup(false);
    } catch (e) {
      if (mounted.current) {
        setSetup(e instanceof ApiError && e.code === 'CLOUD_SETUP_REQUIRED');
        setCloudError(errorMessage(e));
      }
    } finally {
      recordsPending.current = false;
      if (mounted.current) setLoadingRecords(false);
    }
  }
  async function refresh() {
    if (polling.current) return;
    polling.current = true;
    try {
      const value = await api<CloudSyncStatus>('/cloud-sync/status');
      if (!mounted.current) return;
      setStatus(value);
      const selectable = new Set(selectableExams(value));
      setSelection((previous) => {
        const next = new Set([...previous].filter((id) => selectable.has(id)));
        return next.size === previous.size ? previous : next;
      });
      setError('');
      const stamp = value.items
        .filter((i) => i.state === 'synced')
        .map((i) => `${i.id}:${i.revision}`)
        .join(',');
      if (value.signedIn && (!recordsLoaded.current || stamp !== syncedStamp.current)) {
        recordsLoaded.current = true;
        syncedStamp.current = stamp;
        void loadRecords();
      }
    } catch (e) {
      if (mounted.current) setError(errorMessage(e));
    } finally {
      polling.current = false;
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 5000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!recordId) return;
    let alive = true;
    setRecord(null);
    void api<CloudExamRecord>(`/cloud-sync/records/${recordId}`, { timeoutMs: 30000 })
      .then((value) => {
        if (alive) setRecord(value);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [recordId]);
  async function queue() {
    if (operationPending.current || !canSync || !selectedIds.length) return;
    operationPending.current = true;
    setBusy(true);
    const ids = [...selectedIds];
    let queued = 0;
    setQueueProgress({ queued: 0, total: ids.length });
    setError('');
    try {
      await queueSelectedExams(
        ids,
        (batch) => api('/cloud-sync/queue', { method: 'POST', body: { assessmentIds: batch } }),
        (batch) => {
          queued += batch.length;
          if (!mounted.current) return;
          setSelection((previous) => {
            const next = new Set(previous);
            for (const id of batch) next.delete(id);
            return next;
          });
          setQueueProgress({ queued, total: ids.length });
        },
      );
      await refresh();
    } catch (e) {
      if (mounted.current)
        setError(
          queued
            ? `${queued} ${queued === 1 ? 'examination was' : 'examinations were'} queued. ${errorMessage(e)} The remaining examinations are still selected.`
            : errorMessage(e),
        );
    } finally {
      operationPending.current = false;
      if (mounted.current) {
        setBusy(false);
        setQueueProgress(null);
      }
    }
  }
  async function retry(id: string) {
    if (operationPending.current) return;
    operationPending.current = true;
    setBusy(true);
    setError('');
    try {
      await api(`/cloud-sync/jobs/${id}/retry`, { method: 'POST', body: {} });
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  }
  function choose(id: string) {
    setSelection((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const latest = new Map<string, SyncItem>();
  for (const item of status?.items ?? [])
    if (!latest.has(item.assessmentId)) latest.set(item.assessmentId, item);
  const canSync = Boolean(status?.connected && status.signedIn && !setup);
  const eligibleIds = status ? selectableExams(status) : [];
  const selectedIds = eligibleIds.filter((id) => selection.has(id));
  const allSelected = eligibleIds.length > 0 && selectedIds.length === eligibleIds.length;
  const partlySelected = selectedIds.length > 0 && !allSelected;
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = partlySelected;
  }, [partlySelected, tab, status?.available]);
  return (
    <div className="cloud-sync-page">
      {status?.pausedForExam && status.items.some((i) => i.state !== 'synced') && (
        <Notice kind="info">
          Synchronization will continue after the current examination finishes. Its local delivery
          is unaffected.
        </Notice>
      )}
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR PRIVATE RECORDS</span>
          <h1>{record?.assessment.title ?? 'Cloud sync'}</h1>
          <p className="muted">
            {recordId
              ? 'A read-only cloud copy. Marking changes belong to the examination Host.'
              : 'Keep completed examinations available beyond this computer.'}
          </p>
        </div>
        {recordId ? (
          <a className="button secondary" href="/cloud-sync">
            <Icon name="back" size={16} />
            All records
          </a>
        ) : (
          <button
            className="button secondary"
            disabled={loadingRecords}
            onClick={() => {
              void refresh();
              if (status?.signedIn) void loadRecords();
            }}
          >
            Refresh
          </button>
        )}
      </div>
      {error && <Notice>{error}</Notice>}
      {!status && !error && <Loading />}
      {status && !status.available && (
        <Notice kind="info">
          Cloud storage is not configured here. Your examinations remain saved on this computer.
        </Notice>
      )}
      {status?.available && !status.connected && (
        <Notice kind="info">
          Connect your local workspace to a cloud account before synchronizing. Your existing
          records stay here.
        </Notice>
      )}
      {status?.connected && !status.signedIn && (
        <Notice kind="info">
          You’re using local Host access.{' '}
          <a href="/account/sign-in">Sign in to your connected cloud account</a> to synchronize or
          view cloud records.
        </Notice>
      )}
      {setup && (
        <Notice kind="info">
          Cloud storage is not ready yet. You can continue working locally; your saved examinations
          are unaffected.
        </Notice>
      )}
      {cloudError && !setup && status?.signedIn && !recordId && <Notice>{cloudError}</Notice>}
      {recordId ? (
        record ? (
          <section className="panel cloud-results">
            <div className="cloud-section-heading">
              <div>
                <h2>Results</h2>
                <p className="field-hint">
                  {record.candidates.length} candidates · {record.assessment.course}
                </p>
              </div>
              <a
                className="button secondary"
                href={`/api/cloud-sync/records/${recordId}/results.csv`}
              >
                <Icon name="download" size={16} />
                Export CSV
              </a>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Candidate</th>
                    <th>Score</th>
                    <th>Percentage</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {record.candidates.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <strong>{c.name}</strong>
                        <span className="cloud-row-note">{c.identifier}</span>
                      </td>
                      <td>{c.grade?.totalScore ?? '—'}</td>
                      <td>
                        {c.grade?.percentage != null ? `${c.grade.percentage.toFixed(1)}%` : '—'}
                      </td>
                      <td>
                        {c.grade?.pendingManual
                          ? 'Needs manual review'
                          : c.status === 'waiting'
                            ? 'Did not start'
                            : c.status === 'expired'
                              ? 'Time expired'
                              : 'Submitted'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : (
          !error && <Loading />
        )
      ) : (
        status?.available && (
          <>
            <div className="cloud-tabs" role="tablist" aria-label="Examination storage">
              <button
                role="tab"
                aria-selected={tab === 'local'}
                onClick={() => setTab('local')}
                id="cloud-local-tab"
                aria-controls="cloud-local-panel"
              >
                On this computer <span>{status.ready.length}</span>
              </button>
              <button
                role="tab"
                aria-selected={tab === 'cloud'}
                onClick={() => setTab('cloud')}
                id="cloud-records-tab"
                aria-controls="cloud-records-panel"
              >
                Cloud records
              </button>
            </div>
            {tab === 'local' ? (
              <section
                className="panel"
                role="tabpanel"
                id="cloud-local-panel"
                aria-labelledby="cloud-local-tab"
              >
                <div className="cloud-section-heading">
                  <div>
                    <h2>Completed examinations</h2>
                    <p className="field-hint">
                      Select examinations to sync. Active examinations stay local until they finish.
                    </p>
                  </div>
                  <div className="actions">
                    {selectedIds.length > 0 && (
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => setSelection(new Set())}
                      >
                        Clear
                      </button>
                    )}
                    <button
                      className="button primary"
                      disabled={!canSync || busy || !selectedIds.length}
                      data-disabled-reason={
                        busy
                          ? 'Please wait while synchronization is in progress.'
                          : !canSync
                            ? 'Connect this workspace to your MUDU account before syncing.'
                            : !selectedIds.length
                              ? 'Select at least one completed examination to sync.'
                              : undefined
                      }
                      onClick={() => void queue()}
                    >
                      {queueProgress
                        ? `Queueing ${queueProgress.queued} of ${queueProgress.total}…`
                        : busy
                          ? 'Please wait…'
                          : selectedIds.length
                            ? `Sync ${selectedIds.length} ${selectedIds.length === 1 ? 'examination' : 'examinations'}`
                            : 'Sync selected'}
                    </button>
                  </div>
                </div>
                {!status.ready.length ? (
                  <div className="cloud-empty">
                    <Icon name="paper" size={30} />
                    <h3>Your completed exams belong here</h3>
                    <p>
                      Finish an examination, then synchronize its questions, answers and results.
                    </p>
                    <a className="button secondary" href="/">
                      View assessments
                    </a>
                  </div>
                ) : (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th className="cloud-selection">
                            <label className="cloud-select-all">
                              <input
                                ref={selectAll}
                                type="checkbox"
                                aria-label="Select all completed examinations available to sync"
                                checked={allSelected}
                                disabled={!canSync || busy || !eligibleIds.length}
                                onChange={(event) =>
                                  setSelection(
                                    event.target.checked ? new Set(eligibleIds) : new Set(),
                                  )
                                }
                              />
                              <span>Select all</span>
                            </label>
                          </th>
                          <th>Examination</th>
                          <th>Candidates</th>
                          <th>Cloud status</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {status.ready.map((exam) => {
                          const item = latest.get(exam.id),
                            pending = item && item.state !== 'synced';
                          return (
                            <tr key={exam.id}>
                              <td className="cloud-selection">
                                <input
                                  type="checkbox"
                                  aria-label={`Select ${exam.title}`}
                                  checked={selection.has(exam.id)}
                                  disabled={!canSync || Boolean(pending) || busy}
                                  data-disabled-reason={
                                    busy
                                      ? 'Please wait while synchronization is in progress.'
                                      : !canSync
                                        ? 'Connect this workspace to your MUDU account before selecting exams.'
                                        : pending
                                          ? 'This examination already has a sync in progress. Wait for it to finish.'
                                          : undefined
                                  }
                                  onChange={() => choose(exam.id)}
                                />
                              </td>
                              <td>
                                <a href={`/assessments/${exam.id}`}>{exam.title}</a>
                                {item?.state === 'synced' && (
                                  <span className="cloud-row-note">
                                    Select again after marking changes to sync the latest version.
                                  </span>
                                )}
                              </td>
                              <td>{exam.candidateCount}</td>
                              <td>
                                {item ? (
                                  <>
                                    <span className={`cloud-state ${item.state}`}>
                                      {labels[item.state]}
                                    </span>
                                    {item.state === 'uploading' && (
                                      <progress
                                        aria-label={`Upload progress for ${exam.title}`}
                                        value={item.uploaded}
                                        max={item.total}
                                      />
                                    )}{' '}
                                    {item.error && (
                                      <span className="cloud-row-note">{item.error}</span>
                                    )}
                                  </>
                                ) : (
                                  <span className="muted">Not synced</span>
                                )}
                              </td>
                              <td>
                                {item?.state === 'retry' && (
                                  <button
                                    className="text-button"
                                    disabled={busy || !canSync}
                                    onClick={() => void retry(item.id)}
                                  >
                                    Retry now
                                  </button>
                                )}
                                {item && (item.state === 'synced' || item.state === 'conflict') && (
                                  <a href={`/cloud-sync/records/${exam.id}`}>View cloud copy</a>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            ) : (
              <section
                className="panel"
                role="tabpanel"
                id="cloud-records-panel"
                aria-labelledby="cloud-records-tab"
              >
                <div className="cloud-section-heading">
                  <div>
                    <h2>Synced examinations</h2>
                    <p className="field-hint">
                      Available to your cloud account. Local copies are never removed by
                      synchronization.
                    </p>
                  </div>
                </div>
                {!records.length ? (
                  <div className="cloud-empty">
                    {loadingRecords ? (
                      <Loading />
                    ) : (
                      <>
                        <Icon name="server" size={30} />
                        <h3>
                          {cloudError ? 'Cloud records are unavailable' : 'Nothing synced yet'}
                        </h3>
                        <p>
                          {cloudError
                            ? 'Try again when your connection is available.'
                            : 'Synchronize a completed examination to see its results here.'}
                        </p>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Examination</th>
                          <th>Candidates</th>
                          <th>Last synchronized</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {records.map((r) => (
                          <tr key={r.id}>
                            <td>
                              <a href={`/cloud-sync/records/${r.id}`}>{r.title}</a>
                              <span className="cloud-row-note">{r.course}</span>
                            </td>
                            <td>{r.candidateCount}</td>
                            <td>{new Date(r.syncedAt).toLocaleString()}</td>
                            <td>
                              <a href={`/cloud-sync/records/${r.id}`}>View results</a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {more && (
                  <div className="cloud-load-more">
                    <button
                      className="button secondary"
                      disabled={loadingRecords}
                      onClick={() => void loadRecords(records.length)}
                    >
                      {loadingRecords ? 'Loading…' : 'Load more'}
                    </button>
                  </div>
                )}
              </section>
            )}
          </>
        )
      )}
    </div>
  );
}
