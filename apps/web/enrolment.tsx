import { useEffect, useState } from 'react';
import type { RosterDetail } from '../../packages/contracts/rosters.ts';
import { api, errorMessage } from './api.ts';
import { Dialog, Notice } from './ui.tsx';
import { useCandidateOrigin } from './local-delivery.tsx';

type Account = { accountId: string; name: string; email: string; identifier: string };
export function RosterEnrolment({
  roster,
  disabled,
  onChange,
}: {
  roster: RosterDetail;
  disabled: boolean;
  onChange: (roster: RosterDetail) => void;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Account | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [number, setNumber] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState('');
  const [cancel, setCancel] = useState<string | null>(null);
  const origin = useCandidateOrigin();
  useEffect(() => {
    let alive = true;
    api<{ candidates: Account[] }>('/enrolment-directory')
      .then((value) => {
        if (alive) setAccounts(value.candidates);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [roster.revision]);
  const matches = search.trim()
    ? accounts
        .filter((a) =>
          `${a.name} ${a.email} ${a.identifier}`
            .toLowerCase()
            .includes(search.trim().toLowerCase()),
        )
        .slice(0, 8)
    : [];
  return (
    <section className="panel padded enrolment-panel">
      <h2>Add to roster</h2>
      {disabled && <p className="field-hint">Save your roster changes before adding candidates.</p>}
      <p className="muted small">Enrol an existing account, or reserve a place for someone new.</p>
      {error && <Notice>{error}</Notice>}
      {message && (
        <p role="status" className="field-hint">
          {message}
        </p>
      )}
      <div className="tabs">
        <button
          type="button"
          className={`tab ${mode === 'existing' ? 'current' : ''}`}
          onClick={() => {
            setMode('existing');
            setError('');
            setMessage('');
          }}
        >
          Existing account
        </button>
        <button
          type="button"
          className={`tab ${mode === 'new' ? 'current' : ''}`}
          onClick={() => {
            setMode('new');
            setError('');
            setMessage('');
          }}
        >
          New candidate
        </button>
      </div>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || disabled) return;
          setBusy(true);
          setError('');
          setMessage('');
          try {
            const value = await api<RosterDetail>(`/rosters/${roster.id}/enrol`, {
              method: 'POST',
              body: {
                revision: roster.revision,
                email: mode === 'existing' ? selected?.email : email,
                name,
                identifier: number.trim(),
                accountId: mode === 'existing' ? selected?.accountId : undefined,
              },
            });
            onChange(value);
            setSelected(null);
            setSearch('');
            setName('');
            setEmail('');
            setNumber('');
            setMessage(
              mode === 'existing'
                ? 'Added to roster. The group is now visible in their account.'
                : 'Place reserved. Copy the personal invitation below and share it with this candidate. No email has been sent.',
            );
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset
          disabled={busy || disabled || Boolean(roster.archived)}
          className="assessment-fields"
        >
          {mode === 'existing' ? (
            <>
              <label>
                Find an account
                <input
                  type="search"
                  placeholder="Name, email or existing student number"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setSelected(null);
                    setNumber('');
                  }}
                />
              </label>
              {!selected && matches.length > 0 && (
                <ul className="enrolment-matches">
                  {matches.map((account) => (
                    <li key={account.accountId}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelected(account);
                          setNumber(
                            account.identifier.startsWith('ACCOUNT-') ? '' : account.identifier,
                          );
                        }}
                      >
                        <strong>{account.name}</strong>
                        <span>
                          {account.email}
                          {!account.identifier.startsWith('ACCOUNT-')
                            ? ` · ${account.identifier}`
                            : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {search.trim() && !selected && !matches.length && (
                <p className="field-hint">
                  No matching account on this Host. Choose New candidate to create an invitation.
                </p>
              )}
              {selected && (
                <p className="enrolment-selected">
                  <strong>{selected.name}</strong>
                  <br />
                  {selected.email}
                </p>
              )}
            </>
          ) : (
            <>
              <label>
                Full name
                <input
                  required
                  maxLength={160}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                Email address
                <input
                  required
                  type="email"
                  maxLength={254}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
            </>
          )}
          <label>
            Student number{' '}
            <span className="muted small">Optional · for this institution/workspace</span>
            <input
              maxLength={80}
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="e.g. 001 — leave blank for general assessments"
            />
          </label>
          <p className="field-hint">
            Candidates sign in with email and password. Numbers are not login credentials.
          </p>
          <button className="button primary" disabled={mode === 'existing' && !selected}>
            {busy
              ? 'Saving…'
              : mode === 'existing'
                ? 'Add to roster'
                : 'Create personal invitation'}
          </button>
        </fieldset>
      </form>
      {roster.invitations.length > 0 && (
        <div className="enrolment-invitations">
          <h3>Invitation pending ({roster.invitations.length})</h3>
          <p className="muted small">
            These places are reserved. Share each personal link with its intended candidate. Joining
            enrols them automatically.
          </p>
          {roster.invitations.map((invite) => (
            <div key={invite.id} className="enrolment-invitation">
              <strong>{invite.name}</strong>
              <span className="muted small">
                {invite.email}
                {!invite.identifier.startsWith('ACCOUNT-') ? ` · ${invite.identifier}` : ''}
              </span>
              <div className="registration-link">
                <input
                  aria-label={`Invitation for ${invite.name}`}
                  readOnly
                  value={`${origin}/join/enrol/${invite.token}`}
                  onFocus={(e) => e.target.select()}
                />
                <button
                  className="button secondary"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(`${origin}/join/enrol/${invite.token}`);
                      setCopied(invite.id);
                    } catch {
                      setError('Select the invitation address and copy it manually.');
                    }
                  }}
                >
                  {copied === invite.id ? 'Copied' : 'Copy invitation'}
                </button>
              </div>
              <button
                className="text-button membership-action decline"
                disabled={disabled || busy}
                onClick={() => {
                  setError('');
                  setCancel(invite.id);
                }}
              >
                Cancel invitation
              </button>
            </div>
          ))}
        </div>
      )}
      {cancel && (
        <Dialog
          title="Cancel this invitation?"
          confirmLabel="Cancel invitation"
          danger
          busy={busy}
          onClose={() => setCancel(null)}
          confirm={async () => {
            setBusy(true);
            setError('');
            try {
              onChange(
                await api<RosterDetail>(`/rosters/${roster.id}/invitations/${cancel}`, {
                  method: 'DELETE',
                  body: { revision: roster.revision },
                }),
              );
              setCancel(null);
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <p>
            The personal link will stop working and the reserved place will be released. No account
            or examination result will be deleted.
          </p>
          {error && <Notice>{error}</Notice>}
        </Dialog>
      )}
    </section>
  );
}

export function AcceptEnrolment({ token }: { token: string }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<{ name: string; accepting: boolean } | null>(null);
  useEffect(() => {
    void api<{ name: string; accepting: boolean }>(`/enrolment-join/${token}`)
      .then(setInvite)
      .catch((e) => setError(errorMessage(e)));
  }, [token]);
  return (
    <main className="content">
      <section className="panel padded">
        <h1>{invite ? `Join ${invite.name}` : 'Your invitation'}</h1>
        <p>
          Accept this invitation to add the group to your account. Use the email address your
          organiser invited.
        </p>
        {error && <Notice>{error}</Notice>}
        <p>
          <button
            className="text-button"
            disabled={busy}
            onClick={async () => {
              try {
                await api('/logout', { method: 'POST', body: {} });
                location.reload();
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            Use a different account
          </button>
        </p>
        <button
          className="button primary"
          disabled={busy || !invite?.accepting}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await api(`/enrolment-join/${token}`, { method: 'POST', body: {} });
              location.href = '/exam';
            } catch (e) {
              setError(errorMessage(e));
              setBusy(false);
            }
          }}
        >
          {busy ? 'Joining…' : 'Join group'}
        </button>
        {invite && !invite.accepting && <p>Joining is closed. Contact the organiser.</p>}
        <p>
          <a href="/exam">My examinations</a>
        </p>
      </section>
    </main>
  );
}
