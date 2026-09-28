import { useEffect, useState } from 'react';
import { useCandidateOrigin } from './local-delivery.tsx';
import type {
  RegistrationRequest,
  RegistrationSettings,
} from '../../packages/contracts/registration.ts';
import { api, errorMessage } from './api.ts';
import { Dialog, Icon, Notice } from './ui.tsx';

export function RegistrationAdmin({
  assessmentId,
  onChange,
}: {
  assessmentId: string;
  onChange: () => Promise<void>;
}) {
  const candidateOrigin = useCandidateOrigin();
  const [data, setData] = useState<{
    settings: RegistrationSettings;
    requests: RegistrationRequest[];
  } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [review, setReview] = useState<{
    request: RegistrationRequest;
    decision: 'approved' | 'rejected';
  } | null>(null);
  const [rotate, setRotate] = useState(false);
  const [justCreated] = useState(() => new URLSearchParams(location.search).get('created') === '1');
  useEffect(() => {
    if (justCreated) {
      const url = new URL(location.href);
      url.searchParams.delete('created');
      history.replaceState(null, '', url);
    }
  }, [justCreated]);
  async function refresh() {
    try {
      setData(await api(`/assessments/${assessmentId}/registration`));
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, [assessmentId]);
  async function settingsChange(rotateLink = false) {
    if (!data) return;
    setBusy(true);
    setError('');
    try {
      await api(`/assessments/${assessmentId}/registration`, {
        method: 'POST',
        body: { open: rotateLink ? data.settings.open : !data.settings.open, rotate: rotateLink },
      });
      setRotate(false);
      setCopied(false);
      await refresh();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function decide() {
    if (!review) return;
    setBusy(true);
    setError('');
    try {
      await api(`/assessments/${assessmentId}/registration/${review.request.id}`, {
        method: 'POST',
        body: { decision: review.decision },
      });
      setReview(null);
      await refresh();
      await onChange();
    } catch (error) {
      setError(errorMessage(error));
      setReview(null);
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return error ? <Notice>{error}</Notice> : <p className="muted small">Loading registration…</p>;
  if (data.settings.mode !== 'accounts') return null;
  const { settings, requests } = data;
  const link = `${candidateOrigin}/join/${settings.token}`;
  const pending = requests.filter((request) => request.status === 'pending').length;
  return (
    <section id="registration" className="registration-management panel padded">
      <div className="section-heading registration-heading">
        <div>
          <h2>Invite candidates</h2>
          <p className="muted small">Share this link so candidates can join your assessment.</p>
        </div>
        <span className="registration-state">
          {settings.accepting ? 'Registration open' : 'Registration closed'}
        </span>
      </div>
      <div className="registration-link">
        <input
          aria-label="Registration link"
          readOnly
          value={link}
          onFocus={(event) => event.target.select()}
        />
        <button
          className="button primary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(link);
              setCopied(true);
              setError('');
            } catch {
              setError('Select the link and copy it manually.');
            }
          }}
        >
          <span aria-live="polite">{copied ? 'Copied' : 'Copy link'}</span>
        </button>
      </div>
      {['localhost', '127.0.0.1', '[::1]'].includes(new URL(candidateOrigin).hostname) && (
        <details className="registration-local-note">
          <summary>This link only works on this computer</summary>
          <p className="field-hint">
            <a href="/local-delivery">Start local delivery</a> to get a link candidates can open on
            the examination Wi-Fi.
          </p>
        </details>
      )}
      <div className="registration-secondary">
        <a className="text-button" href={link} target="_blank" rel="noreferrer">
          Preview candidate page <Icon name="arrow" size={14} />
        </a>
        <details className="registration-options">
          <summary>Registration settings</summary>
          <div className="registration-options-body">
            <p className="field-hint">
              {settings.policy === 'roster'
                ? 'Only candidates on the roster can register.'
                : 'Candidates need your approval before admission.'}
            </p>
            {settings.closesAt && (
              <p className="field-hint">Closes {new Date(settings.closesAt).toLocaleString()}.</p>
            )}
            <p className="field-hint">
              Starting the examination closes registration. Closing it does not remove existing
              candidates.
            </p>
            {!settings.launched && (
              <div className="actions">
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => settingsChange()}
                >
                  {settings.open ? 'Close registration' : 'Reopen registration'}
                </button>
                <button className="text-button" disabled={busy} onClick={() => setRotate(true)}>
                  Replace link
                </button>
              </div>
            )}
          </div>
        </details>
      </div>
      {error && <Notice>{error}</Notice>}
      <div className="registration-review-heading">
        <h3>Candidates</h3>
        <span className="muted small">
          {requests.filter((r) => r.status === 'approved').length} approved · {pending} awaiting
          review
        </span>
      </div>
      {requests.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Candidate</th>
                <th>Application reference</th>
                <th>Registration</th>
                <th>Review</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((request) => (
                <tr key={request.id}>
                  <td>
                    <strong>{request.name}</strong>
                    <small className="block muted">{request.email}</small>
                    {request.rosterName && request.rosterName !== request.name && (
                      <small className="block muted">Roster name: {request.rosterName}</small>
                    )}
                  </td>
                  <td>{request.applicationNumber}</td>
                  <td>
                    <span className={`registration-label ${request.status}`}>
                      {request.status === 'pending'
                        ? 'Awaiting approval'
                        : request.status === 'approved'
                          ? 'Approved'
                          : 'Declined'}
                    </span>
                  </td>
                  <td>
                    {!settings.launched && request.status !== 'approved' ? (
                      <div className="actions">
                        <button
                          className="button secondary"
                          disabled={busy}
                          onClick={() => {
                            setReview({ request, decision: 'approved' });
                          }}
                        >
                          {request.status === 'rejected' ? 'Reconsider' : 'Approve'}
                        </button>
                        {request.status === 'pending' && (
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() => setReview({ request, decision: 'rejected' })}
                          >
                            Decline
                          </button>
                        )}
                      </div>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="registration-empty muted small">
          Requests will appear here when candidates register.
        </p>
      )}
      {review && (
        <Dialog
          title={
            review.decision === 'approved'
              ? 'Approve this candidate?'
              : 'Decline this registration?'
          }
          confirmLabel={
            review.decision === 'approved' ? 'Approve registration' : 'Decline registration'
          }
          confirm={decide}
          onClose={() => setReview(null)}
          busy={busy}
        >
          <p>
            <strong>{review.request.name}</strong>
            <br />
            {review.request.identifier}
            <br />
            {review.request.email}
          </p>
          <p>
            {review.decision === 'approved'
              ? 'This examination will appear as approved in their account.'
              : 'Their other examinations and account remain unchanged.'}
          </p>
        </Dialog>
      )}
      {rotate && (
        <Dialog
          title="Replace the registration link?"
          confirmLabel="Replace link"
          confirm={() => settingsChange(true)}
          onClose={() => setRotate(false)}
          busy={busy}
        >
          <p>
            The old link will stop accepting visits. Existing accounts and registrations are
            unchanged. Share the new link with anyone who has not registered.
          </p>
        </Dialog>
      )}
    </section>
  );
}
