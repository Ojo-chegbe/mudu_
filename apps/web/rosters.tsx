import { useEffect, useRef, useState } from 'react';
import { RosterEnrolment } from './enrolment.tsx';
import { filterMembers, membershipFilters, type MembershipFilter } from './roster-members.ts';
import { browserId } from './browser-id.ts';
import { useCandidateOrigin } from './local-delivery.tsx';
import type {
  RosterDetail,
  RosterEntry,
  RosterSummary,
  RosterInvitation,
} from '../../packages/contracts/rosters.ts';
import { api, errorMessage } from './api.ts';
import { parseCsv } from '../../packages/exam-core/csv.ts';
import { Brand, Dialog, Icon, Loading, Notice } from './ui.tsx';

export function RostersPage({ id }: { id?: string }) {
  const [rows, setRows] = useState<RosterSummary[] | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    if (!id)
      void api<{ rosters: RosterSummary[] }>('/rosters')
        .then((r) => setRows(r.rosters))
        .catch((e) => setError(errorMessage(e)));
  }, [id]);
  if (id)
    return (
      <div className="roster-workspace">
        <RosterEditor key={id} routeId={id} />
      </div>
    );
  const filtered =
    rows?.filter((r) => r.name.toLowerCase().includes(search.trim().toLowerCase())) ?? [];
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Rosters</h1>
          <p className="muted">Build your group once. Reuse it for every assessment.</p>
        </div>
        {Boolean(rows?.length) && (
          <a className="button primary" href="/rosters/new">
            <Icon name="plus" />
            Create roster
          </a>
        )}
      </div>
      {error && <Notice>{error}</Notice>}
      {Boolean(rows?.length) && (
        <label className="search roster-search">
          <Icon name="search" size={17} />
          <input
            type="search"
            aria-label="Search rosters"
            placeholder="Search rosters…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      )}
      {!rows ? (
        !error && <Loading />
      ) : !rows.length ? (
        <section className="panel roster-empty" aria-labelledby="roster-empty-title">
          <span className="roster-empty-icon" aria-hidden="true">
            <Icon name="people" size={36} />
          </span>
          <h2 id="roster-empty-title">No rosters yet</h2>
          <p className="muted">
            Keep a class or group together, then assign assessments without rebuilding your
            candidate list.
          </p>
          <a className="button primary" href="/rosters/new">
            <Icon name="plus" size={17} />
            Create your first roster
          </a>
          <p className="roster-empty-hint">
            Start with a name. Import a list or invite members with a link.
          </p>
        </section>
      ) : !filtered.length ? (
        <section className="panel roster-empty" aria-live="polite">
          <h2>No matching rosters</h2>
          <p className="muted">Try a different name or clear your search.</p>
          <button type="button" className="button secondary" onClick={() => setSearch('')}>
            Clear search
          </button>
        </section>
      ) : (
        <div className="table-wrap panel">
          <table>
            <thead>
              <tr>
                <th>Roster</th>
                <th>Approved</th>
                <th>Awaiting review</th>
                <th>Expected list</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td>
                    <a href={`/rosters/${r.id}`}>
                      <strong>{r.name}</strong>
                    </a>
                    {Boolean(r.archived) && <small className="block muted">Archived</small>}
                  </td>
                  <td>{r.approved}</td>
                  <td>{r.pending}</td>
                  <td>{r.listed}</td>
                  <td>{new Date(r.updated_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

interface RosterDraft {
  id: string;
  name: string;
  revision: number;
  restricted: boolean;
  open: boolean;
  archived: boolean;
  entries: RosterEntry[];
}
function RosterEditor({ routeId }: { routeId: string }) {
  const candidateOrigin = useCandidateOrigin();
  const saved = useRef(false);
  const draftKey = `mudu.roster-draft.${routeId}`;
  const [draft, setDraft] = useState<RosterDraft | null>(null);
  const [data, setData] = useState<RosterDetail | null>(null);
  const [dirty, setDirty] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [imported, setImported] = useState<RosterEntry[] | null>(null);
  const [replace, setReplace] = useState(false);
  const [review, setReview] = useState<{
    member: RosterDetail['members'][number];
    decision: string;
  } | null>(null);
  const [memberSearch, setMemberSearch] = useState('');
  const [memberFilter, setMemberFilter] = useState<MembershipFilter>('all');
  const visibleMembers = filterMembers(data?.members ?? [], memberFilter, memberSearch);
  const [discard, setDiscard] = useState(false);
  function fromServer(r: RosterDetail): RosterDraft {
    return {
      id: r.id,
      name: r.name,
      revision: r.revision,
      restricted: Boolean(r.restricted),
      open: Boolean(r.is_open),
      archived: Boolean(r.archived),
      entries: r.entries,
    };
  }
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = routeId === 'new' ? null : await api<RosterDetail>(`/rosters/${routeId}`);
        if (!alive) return;
        setData(r);
        let restored: RosterDraft | null = null;
        try {
          const raw = sessionStorage.getItem(draftKey);
          if (raw) {
            const v = JSON.parse(raw);
            if (
              typeof v.name === 'string' &&
              typeof v.id === 'string' &&
              Array.isArray(v.entries) &&
              v.entries.every(
                (e: RosterEntry) => typeof e.name === 'string' && typeof e.identifier === 'string',
              )
            )
              restored = v;
          }
        } catch {
          setStorageError(true);
        }
        setDraft(
          restored ??
            (r
              ? fromServer(r)
              : {
                  id: browserId(),
                  name: '',
                  revision: 0,
                  restricted: false,
                  open: true,
                  archived: false,
                  entries: [],
                }),
        );
        setDirty(Boolean(restored));
      } catch (e) {
        if (alive) setError(errorMessage(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [routeId, draftKey]);
  useEffect(() => {
    if (!dirty || !draft) return;
    try {
      sessionStorage.setItem(draftKey, JSON.stringify(draft));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [draft, dirty, draftKey]);
  useEffect(() => {
    const prevent = (e: BeforeUnloadEvent) => {
      if (dirty && storageError && !saved.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty, storageError]);
  function change(patch: Partial<RosterDraft>) {
    saved.current = false;
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setDirty(true);
  }
  async function importFile(file?: File) {
    if (!file) return;
    setError('');
    try {
      if (file.size > 1024 * 1024) throw new Error('Choose a CSV smaller than 1 MB.');
      const [header, ...rows] = parseCsv(await file.text());
      const cols = header?.map((h) => h.trim().toLowerCase());
      if (
        !cols?.includes('candidate_id') ||
        !cols.includes('name') ||
        new Set(cols).size !== cols.length
      )
        throw new Error('CSV headers must include candidate_id,name without duplicate columns.');
      if (!rows.length || rows.length > 500)
        throw new Error('Import between 1 and 500 candidates.');
      const entries = rows.map((row, i) => {
        if (row.length !== cols.length) throw new Error(`Check row ${i + 2}.`);
        const identifier = row[cols.indexOf('candidate_id')].trim().normalize('NFKC').toUpperCase();
        const name = row[cols.indexOf('name')].trim();
        if (!identifier || !name || identifier.length > 80 || name.length > 160)
          throw new Error(`Check the name and candidate ID on row ${i + 2}.`);
        return { identifier, name };
      });
      if (new Set(entries.map((e) => e.identifier)).size !== entries.length)
        throw new Error('The file contains duplicate candidate IDs.');
      setImported(entries);
      setReplace(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the file.');
    }
  }
  if (!draft) return error ? <Notice>{error}</Notice> : <Loading />;
  const link = data ? `${candidateOrigin}/join/roster/${data.token}` : '';
  return (
    <>
      <a className="back-link" href="/rosters">
        <Icon name="back" size={16} />
        All rosters
      </a>
      <div className="page-heading">
        <div>
          <h1>{data?.name ?? 'Create roster'}</h1>
          <p className="muted">A reusable group, not a separate candidate account.</p>
        </div>
        {data && (
          <a className="button secondary" href={`/assessments/new?roster=${data.id}`}>
            Create assessment
          </a>
        )}
      </div>
      {error && <Notice>{error}</Notice>}
      {storageError && (
        <Notice>Draft backup is unavailable. Keep this tab open until you save.</Notice>
      )}
      {data && (
        <section className="panel padded">
          <div className="section-heading">
            <div>
              <h2>Invite your group</h2>
              <p className="muted small">
                Add candidates directly, or share a joining link for membership requests.
              </p>
            </div>
            <span className="muted small">
              {data.is_open && !data.archived ? 'Joining open' : 'Joining closed'}
            </span>
          </div>
          <div className="registration-link">
            <input
              readOnly
              aria-label="Roster joining link"
              value={link}
              onFocus={(e) => e.target.select()}
            />
            <button
              className="button primary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(link);
                  setCopied(true);
                } catch {
                  setError('Select the joining link and copy it manually.');
                }
              }}
            >
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
          {['localhost', '127.0.0.1', '[::1]'].includes(new URL(candidateOrigin).hostname) && (
            <p className="field-hint">
              This address only works on this computer.{' '}
              <a href="/local-delivery">Start local delivery</a> before sharing it with candidates.
            </p>
          )}
          <a className="text-button" href={link} target="_blank" rel="noreferrer">
            Preview joining page
          </a>
        </section>
      )}
      {dirty && (
        <button
          className="text-button"
          type="button"
          disabled={busy}
          onClick={() => setDiscard(true)}
        >
          Discard unsaved changes
        </button>
      )}
      {discard && (
        <Dialog
          title="Discard unsaved roster changes?"
          confirmLabel="Discard changes"
          busy={busy}
          onClose={() => setDiscard(false)}
          confirm={async () => {
            setBusy(true);
            try {
              const latest = data ? await api<RosterDetail>(`/rosters/${data.id}`) : null;
              sessionStorage.removeItem(draftKey);
              setData(latest);
              setDraft(
                latest
                  ? fromServer(latest)
                  : {
                      id: browserId(),
                      name: '',
                      revision: 0,
                      restricted: false,
                      open: true,
                      archived: false,
                      entries: [],
                    },
              );
              setDirty(false);
              setDiscard(false);
              setError('');
            } catch (e) {
              setError(errorMessage(e));
              setDiscard(false);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p>
            Your saved roster and its members will remain unchanged. Unsaved edits and imported
            entries will be discarded.
          </p>
        </Dialog>
      )}
      {data && (
        <RosterEnrolment
          roster={data}
          disabled={dirty || busy}
          onChange={(r) => {
            setData(r);
            setDraft(fromServer(r));
          }}
        />
      )}
      <form
        className="panel padded"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          try {
            const r = await api<RosterDetail>(`/rosters/${draft.id}`, {
              method: 'POST',
              body: draft,
            });
            setData(r);
            setDraft(fromServer(r));
            setDirty(false);
            saved.current = true;
            try {
              sessionStorage.removeItem(draftKey);
            } catch {}
            if (routeId === 'new') location.replace(`/rosters/${r.id}`);
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset className="assessment-fields" disabled={busy}>
          <label>
            Roster name
            <input
              required
              maxLength={160}
              placeholder="e.g. PCH 401 — 2026 Class"
              value={draft.name}
              onChange={(e) => change({ name: e.target.value })}
            />
          </label>
          {!data && (
            <p className="field-hint">
              Create the roster, then add existing accounts or invite new candidates.
            </p>
          )}
          <details>
            <summary>Settings & optional eligibility rules</summary>
            <label className="check-label">
              <input
                type="checkbox"
                checked={draft.open}
                onChange={(e) => change({ open: e.target.checked })}
              />
              Allow new membership requests
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={draft.restricted}
                onChange={(e) => change({ restricted: e.target.checked })}
              />
              Only accept requests from IDs on the expected list
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={draft.archived}
                onChange={(e) => change({ archived: e.target.checked })}
              />
              Archive roster (closes joining; existing assessments stay unchanged)
            </label>
            <p className="field-hint">
              Optional: limit who can request to join. To enrol someone, use Add to roster above.
              These rules do not add members.
            </p>
            <label className="button secondary upload-label">
              Import CSV
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => {
                  void importFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </label>
            <p className="field-hint">Columns: candidate_id,name · Up to 500 entries</p>
            {draft.entries.map((entry, i) => (
              <div className="roster-row" key={i}>
                <label>
                  Candidate ID
                  <input
                    required
                    maxLength={80}
                    value={entry.identifier}
                    onChange={(e) =>
                      change({
                        entries: draft.entries.map((r, j) =>
                          j === i ? { ...r, identifier: e.target.value } : r,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  Name
                  <input
                    required
                    maxLength={160}
                    value={entry.name}
                    onChange={(e) =>
                      change({
                        entries: draft.entries.map((r, j) =>
                          j === i ? { ...r, name: e.target.value } : r,
                        ),
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove expected entry ${i + 1}`}
                  onClick={() => change({ entries: draft.entries.filter((_, j) => j !== i) })}
                >
                  <Icon name="close" size={16} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="button secondary"
              disabled={draft.entries.length >= 500}
              onClick={() => change({ entries: [...draft.entries, { name: '', identifier: '' }] })}
            >
              Add eligibility rule
            </button>
          </details>
          <div className="wizard-actions">
            <span role="status" className="muted small">
              {dirty
                ? 'Unsaved changes · backed up in this tab when available'
                : data
                  ? 'Saved'
                  : 'Share a joining link after saving'}
            </span>
            <button className="button primary">
              {busy ? 'Saving…' : data ? 'Save changes' : 'Create roster'}
            </button>
          </div>
        </fieldset>
      </form>
      {data && (
        <section className="panel padded">
          <div className="section-heading">
            <div>
              <h2>Members & joining requests</h2>
              <p className="muted small">
                {data.approved} approved · {data.pending} awaiting review
              </p>
            </div>
            <button
              className="text-button"
              disabled={busy || dirty}
              onClick={async () => {
                try {
                  const r = await api<RosterDetail>(`/rosters/${data.id}`);
                  setData(r);
                  setDraft(fromServer(r));
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            >
              Refresh requests
            </button>
          </div>
          {dirty && <p className="field-hint">Save roster changes before reviewing membership.</p>}
          <div className="tabs membership-filters" role="group" aria-label="Filter membership">
            {membershipFilters.map(([value, label]) => (
              <button
                type="button"
                key={value}
                className={`tab${memberFilter === value ? ' current' : ''}`}
                aria-pressed={memberFilter === value}
                onClick={() => setMemberFilter(value)}
              >
                {label}
                <span>
                  {value === 'all'
                    ? data.members.length
                    : data.members.filter((m) => m.status === value).length}
                </span>
              </button>
            ))}
          </div>
          <label className="search">
            <Icon name="search" size={17} />
            <input
              type="search"
              aria-label="Search members"
              placeholder="Search name, email or candidate ID"
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
            />
          </label>
          {!data.members.length ? (
            <p className="muted">
              No members yet. Add an existing account above, or share an invitation.
            </p>
          ) : !visibleMembers.length ? (
            <div className="padded" role="status">
              <p className="muted">No candidates match these filters.</p>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setMemberFilter('all');
                  setMemberSearch('');
                }}
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Candidate</th>
                    <th>Email</th>
                    <th>Membership</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleMembers.map((m) => (
                    <tr key={m.accountId}>
                      <td>
                        <strong>{m.name}</strong>
                        <small className="block muted">
                          {m.identifier.startsWith('ACCOUNT-')
                            ? 'No student number assigned'
                            : m.identifier}
                        </small>
                      </td>
                      <td>{m.email}</td>
                      <td>
                        {m.status === 'pending'
                          ? 'Awaiting approval'
                          : m.status === 'approved'
                            ? 'Approved member'
                            : 'Not admitted'}
                      </td>
                      <td>
                        <div className="actions membership-actions">
                          {(m.status === 'approved' ? ['removed'] : ['approved', 'rejected']).map(
                            (decision) => (
                              <button
                                key={decision}
                                type="button"
                                disabled={busy || dirty || Boolean(data.archived)}
                                className={
                                  decision === 'approved'
                                    ? 'text-button membership-action approve'
                                    : 'text-button membership-action decline'
                                }
                                onClick={() => {
                                  setReview({ member: m, decision });
                                }}
                              >
                                <Icon
                                  name={decision === 'approved' ? 'check' : 'close'}
                                  size={16}
                                />
                                {decision === 'approved'
                                  ? 'Approve'
                                  : decision === 'removed'
                                    ? 'Remove membership'
                                    : 'Decline'}
                              </button>
                            ),
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {imported && (
        <Dialog
          title={`Import ${imported.length} expected candidates?`}
          confirmLabel="Apply import"
          onClose={() => setImported(null)}
          confirm={() => {
            const entries = replace ? imported : [...draft.entries, ...imported];
            if (
              entries.length > 500 ||
              new Set(entries.map((r) => r.identifier.trim().normalize('NFKC').toUpperCase()))
                .size !== entries.length
            ) {
              setError(
                'Import would exceed 500 entries or duplicate a candidate ID. Nothing was changed.',
              );
              setImported(null);
              return;
            }
            change({ entries });
            setImported(null);
          }}
        >
          <p>
            {imported
              .slice(0, 5)
              .map((e) => `${e.identifier} — ${e.name}`)
              .join('\n')}
          </p>
          <label className="check-label">
            <input
              type="checkbox"
              checked={replace}
              onChange={(e) => setReplace(e.target.checked)}
            />
            Replace the existing expected list instead of adding to it
          </label>
          <p className="field-hint">
            Approved memberships and existing assessments are not changed.
          </p>
        </Dialog>
      )}
      {review && data && (
        <Dialog
          title={
            review.decision === 'approved'
              ? 'Approve roster membership?'
              : review.decision === 'removed'
                ? 'Remove this membership?'
                : 'Decline this request?'
          }
          confirmLabel={
            review.decision === 'approved'
              ? 'Approve membership'
              : review.decision === 'removed'
                ? 'Remove membership'
                : 'Decline request'
          }
          danger={review.decision !== 'approved'}
          busy={busy}
          onClose={() => setReview(null)}
          confirm={async () => {
            setBusy(true);
            try {
              const r = await api<RosterDetail>(
                `/rosters/${data.id}/members/${review.member.accountId}`,
                { method: 'POST', body: { decision: review.decision } },
              );
              setData(r);
              setDraft(fromServer(r));
              setReview(null);
            } catch (e) {
              setError(errorMessage(e));
              setReview(null);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p>
            {review.member.name} · {review.member.identifier}
          </p>
          <p>Existing examination enrolments and results remain unchanged.</p>
        </Dialog>
      )}
    </>
  );
}

export function RosterJoin({ token, signedIn }: { token: string; signedIn: boolean }) {
  const [data, setData] = useState<RosterInvitation | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () =>
      api<RosterInvitation>(`/roster-join/${token}`)
        .then((r) => {
          if (active) {
            setData(r);
            setError('');
          }
        })
        .catch((e) => {
          if (active) setError(errorMessage(e));
        });
    void load();
    const timer = setInterval(load, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [token, signedIn]);
  return (
    <section className="panel group-membership-page">
      <div className="group-membership-heading">
        <span className="eyebrow">GROUP MEMBERSHIP</span>
        <h1>{data ? data.name : 'Your group'}</h1>
      </div>
      {error && <Notice>{error}</Notice>}
      {!data && !error && (
        <p className="muted" role="status">
          Loading group details…
        </p>
      )}
      {data && (
        <>
          {data.status ? (
            <>
              <div className={`group-membership-state ${data.status}`} role="status">
                <span className="group-membership-state-icon" aria-hidden="true">
                  <Icon
                    name={
                      data.status === 'approved'
                        ? 'check'
                        : data.status === 'pending'
                          ? 'clock'
                          : 'close'
                    }
                    size={24}
                  />
                </span>
                <div>
                  <h2>
                    {data.status === 'approved'
                      ? 'You’re a member'
                      : data.status === 'pending'
                        ? 'Awaiting approval'
                        : 'Membership unavailable'}
                  </h2>
                  <p className="muted">
                    {data.status === 'rejected'
                      ? 'Contact the assessment organiser if you believe you should have access.'
                      : data.status === 'pending'
                        ? 'No action needed. You’ll receive a notification when your request is reviewed.'
                        : 'You’ll find assessments here in your account when the organiser assigns them.'}
                  </p>
                </div>
              </div>
              <div className="group-membership-footer">
                <a
                  href="/exam"
                  className={
                    data.status === 'approved' ? 'button primary' : 'text-button group-return-link'
                  }
                >
                  {data.status === 'approved' ? 'View my examinations' : 'Back to my examinations'}
                  <Icon name={data.status === 'approved' ? 'arrow' : 'back'} size={16} />
                </a>
              </div>
            </>
          ) : !data.accepting ? (
            <p>Joining is currently closed. Contact the assessment organiser.</p>
          ) : (
            <>
              <p className="muted">Join this group once to receive assessments assigned to you.</p>
              {signedIn ? (
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      setData(await api(`/roster-join/${token}`, { method: 'POST', body: {} }));
                      setError('');
                    } catch (e) {
                      setError(errorMessage(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? 'Sending request…' : 'Request to join group'}
                </button>
              ) : (
                <p>Sign in or create your account below, then request to join this group.</p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

export function CandidateRosters() {
  const [rows, setRows] = useState<Array<{ name: string; token: string; status: string }>>([]);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    async function load() {
      if (document.hidden) return;
      try {
        const r = await api<{ rosters: typeof rows }>('/candidate/rosters');
        if (active) {
          setRows(r.rosters);
          setError('');
        }
      } catch {
        if (active) setError('Group updates are unavailable. The status shown may be out of date.');
      }
    }
    void load();
    const timer = setInterval(load, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [retry]);
  return rows.length || error ? (
    <section className="candidate-groups" aria-labelledby="candidate-groups-title">
      <div className="candidate-groups-heading">
        <h2 id="candidate-groups-title">My groups</h2>
        <span className="muted small">
          {rows.length} {rows.length === 1 ? 'group' : 'groups'}
        </span>
      </div>
      {error && (
        <div className="panel padded">
          <p className="muted small" role="status">
            {error}
          </p>
          <button type="button" className="text-button" onClick={() => setRetry((v) => v + 1)}>
            Try again
          </button>
        </div>
      )}
      <ul className="candidate-group-list">
        {rows.map((r) => (
          <li key={r.token}>
            <a className="candidate-group-row" href={`/join/roster/${r.token}`}>
              <span className="candidate-group-icon" aria-hidden="true">
                <Icon name="people" size={21} />
              </span>
              <span className="candidate-group-content">
                <span className="candidate-group-title">{r.name}</span>
                <span className="candidate-group-description">
                  {r.status === 'approved'
                    ? 'Assigned assessments appear in My examinations.'
                    : r.status === 'pending'
                      ? 'Your request is awaiting approval. No further action is needed.'
                      : 'Contact the assessment organiser if you need help with membership.'}
                </span>
              </span>
              <span className={`candidate-group-status ${r.status}`}>
                {r.status === 'approved'
                  ? 'Member'
                  : r.status === 'pending'
                    ? 'Awaiting approval'
                    : 'Not a member'}
              </span>
              <Icon name="arrow" size={16} />
            </a>
          </li>
        ))}
      </ul>
    </section>
  ) : null;
}

export function AssessmentRoster({ id, onChange }: { id: string; onChange: () => Promise<void> }) {
  type Link = {
    name: string;
    rosterId: string;
    revision: number;
    currentRevision: number;
    started: boolean;
    additions: Array<{ name: string; identifier: string }>;
  };
  const [data, setData] = useState<Link | null>(null);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  async function load() {
    try {
      setData(await api<Link>(`/assessments/${id}/roster`));
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  useEffect(() => {
    void load();
  }, [id]);
  return (
    <section className="panel padded">
      <div className="section-heading">
        <div>
          <h2>Assessment roster</h2>
          {data && (
            <p className="muted">
              {data.name} · snapshot version {data.revision}
            </p>
          )}
        </div>
        {data && (
          <a className="button secondary" href={`/rosters/${data.rosterId}`}>
            Manage roster
          </a>
        )}
      </div>
      {error && <Notice>{error}</Notice>}
      <p className="field-hint">
        Membership and joining links are managed in Rosters. Existing exam enrolments are preserved
        when that group changes.
      </p>
      {data && !data.started && (
        <div className="actions">
          <button className="text-button" onClick={load}>
            Check for new members
          </button>
          {data.additions.length > 0 && (
            <button className="button primary" onClick={() => setConfirm(true)}>
              Review {data.additions.length} new members
            </button>
          )}
        </div>
      )}
      {data?.started && (
        <p className="field-hint">
          Candidate admission is frozen because this examination has started.
        </p>
      )}
      {confirm && data && (
        <Dialog
          title="Add these approved members?"
          confirmLabel="Add to assessment"
          busy={busy}
          onClose={() => setConfirm(false)}
          confirm={async () => {
            setBusy(true);
            try {
              await api(`/assessments/${id}/roster`, {
                method: 'POST',
                body: { revision: data.currentRevision },
              });
              await load();
              await onChange();
              setConfirm(false);
            } catch (e) {
              setError(errorMessage(e));
              setConfirm(false);
            } finally {
              setBusy(false);
            }
          }}
        >
          <ul>
            {data.additions.map((m) => (
              <li key={m.identifier}>
                {m.name} · {m.identifier}
              </li>
            ))}
          </ul>
          <p>These candidates will see the assessment in their existing accounts.</p>
        </Dialog>
      )}
    </section>
  );
}

export function RosterMemberPage({ token }: { token: string }) {
  return (
    <div className="candidate-app">
      <header className="candidate-header">
        <Brand />
        <a href="/exam">My examinations</a>
      </header>
      <main className="candidate-dashboard">
        <RosterJoin token={token} signedIn />
      </main>
    </div>
  );
}
