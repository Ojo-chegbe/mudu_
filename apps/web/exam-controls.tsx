import { useRef, useState } from 'react';
import type { ExamControlAction } from '../../packages/contracts/exam-controls.ts';
import type {
  MonitoringSnapshot,
  MonitoredCandidate,
} from '../../packages/contracts/monitoring.ts';
import { api, errorMessage } from './api.ts';
import { Dialog, Notice } from './ui.tsx';
import { browserId } from './browser-id.ts';

const labels = {
  announce: 'Send announcement',
  extend: 'Add extra time',
  pause: 'Pause examination',
  resume: 'Resume examination',
  force_submit: 'Submit saved answers',
};

function ControlDialog({
  id,
  action,
  data,
  candidate,
  onClose,
  onSaved,
}: {
  id: string;
  action: ExamControlAction;
  data: MonitoringSnapshot;
  candidate?: MonitoredCandidate;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [minutes, setMinutes] = useState(10);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision] = useState(data.controls?.revision ?? 0);
  const receipt = useRef({ fingerprint: '', operationId: '' });
  const valid =
    action === 'announce'
      ? Boolean(message.trim())
      : reason.trim().length >= 3 &&
        (action !== 'extend' || (Number.isInteger(minutes) && minutes >= 1 && minutes <= 240));
  async function save() {
    if (busy || !valid) return;
    const payload = {
      action,
      expectedRevision: revision,
      ...(candidate ? { candidateId: candidate.id } : {}),
      ...(action === 'announce' ? { message: message.trim() } : { reason: reason.trim() }),
      ...(action === 'extend' ? { minutes } : {}),
    };
    const fingerprint = JSON.stringify(payload);
    if (receipt.current.fingerprint !== fingerprint)
      receipt.current = { fingerprint, operationId: browserId() };
    setBusy(true);
    setError('');
    try {
      await api(`/assessments/${id}/controls`, {
        method: 'POST',
        body: { ...payload, operationId: receipt.current.operationId },
      });
      onSaved(
        action === 'announce'
          ? 'Announcement sent. Candidates will receive it when their examination page connects.'
          : action === 'extend'
            ? `${minutes} extra minutes added${candidate ? ` for ${candidate.name}` : ' for everyone'}.`
            : action === 'force_submit'
              ? `${candidate!.name}’s saved answers have been submitted.`
              : action === 'pause'
                ? 'Examination paused. Timers are frozen.'
                : 'Examination resumed. Paused time has been restored.',
      );
      onClose();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={
        action === 'extend'
          ? candidate
            ? `Extra time · ${candidate.name}`
            : 'Extra time for everyone'
          : labels[action]
      }
      confirmLabel={labels[action]}
      busy={busy}
      danger={action === 'force_submit'}
      confirmDisabled={!valid}
      onClose={onClose}
      confirm={() => void save()}
    >
      {error && <Notice>{error}</Notice>}
      {action === 'announce' ? (
        <>
          <p>
            Send a message to every admitted candidate. It stays available if they disconnect and
            return.
          </p>
          <label>
            Message
            <textarea
              autoFocus
              rows={4}
              maxLength={1000}
              value={message}
              disabled={busy}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="For example: Please check your answers before submitting."
            />
          </label>
          <p className="field-hint">
            {message.length} / 1,000 characters · Send only information candidates need.
          </p>
        </>
      ) : (
        <>
          {action === 'extend' && (
            <>
              <p>
                {candidate
                  ? 'Adds time to this ongoing attempt only. Other candidates are unaffected. The finish-by deadline still applies.'
                  : data.timingMode === 'individual'
                    ? 'Adds time to ongoing attempts and the duration for candidates who have not begun. Any finish-by deadline also moves later. The last start time stays unchanged.'
                    : 'Moves the shared deadline later and adds time to ongoing attempts. Submitted and expired attempts stay closed.'}
              </p>
              <label>
                Extra minutes
                <input
                  type="number"
                  autoFocus
                  min={1}
                  max={240}
                  step={1}
                  value={minutes || ''}
                  disabled={busy}
                  onChange={(e) => setMinutes(Number(e.target.value))}
                />
              </label>
              <div className="schedule-shortcuts">
                {[5, 10, 15, 30].map((n) => (
                  <button
                    type="button"
                    className="schedule-shortcut"
                    key={n}
                    disabled={busy}
                    aria-pressed={minutes === n}
                    onClick={() => setMinutes(n)}
                  >
                    +{n} min
                  </button>
                ))}
              </div>
            </>
          )}
          {action === 'pause' && (
            <p>
              Timers freeze. Candidates cannot begin, change answers or submit until you resume.
              Saved work stays intact; pending saves retry afterwards. Resuming moves start and
              finish deadlines by the paused duration.
            </p>
          )}
          {action === 'resume' && (
            <p>
              Candidates can continue. The paused duration is restored to their timers and the
              start/finish deadlines. Submitted attempts remain closed.
            </p>
          )}
          {action === 'force_submit' && (
            <Notice>
              You are submitting {candidate!.name} ({candidate!.identifier}). Only answers saved
              when this action reaches the server are included. Monitoring last showed{' '}
              {candidate!.answered} saved answers. Unsaved changes on their device are not included.
              This cannot be undone.
            </Notice>
          )}
          <label className="control-reason">
            Reason
            <textarea
              autoFocus={action !== 'extend'}
              rows={2}
              minLength={3}
              maxLength={500}
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explain this change for the examination record."
            />
          </label>
          <p className="field-hint">This action and your reason are recorded in Activity.</p>
        </>
      )}
    </Dialog>
  );
}

export function ExamControlPanel({
  id,
  data,
  stale,
  onChange,
}: {
  id: string;
  data: MonitoringSnapshot;
  stale: boolean;
  onChange: () => void;
}) {
  const [action, setAction] = useState<ExamControlAction | null>(null);
  const [feedback, setFeedback] = useState('');
  const paused = data.controls?.pausedAt != null;
  const now = data.controls?.pausedAt ?? data.serverNow;
  const closed = !data.deadline || now >= data.deadline;
  const saved = (message: string) => {
    setFeedback(message);
    onChange();
  };
  return (
    <section className="exam-control-panel" aria-label="Examination controls">
      {paused && (
        <Notice kind="info">
          Examination paused. Timers are frozen and answers are locked until you resume.
        </Notice>
      )}
      {!closed && (
        <div className="exam-control-toolbar">
          <div>
            <strong>Examination controls</strong>
            <p className="field-hint">Changes are recorded. Closed attempts stay closed.</p>
          </div>
          <div className="exam-control-buttons">
            <button
              type="button"
              className="button secondary"
              disabled={stale}
              data-disabled-reason={
                stale
                  ? 'These controls changed elsewhere. Refresh the assessment to load the latest state.'
                  : undefined
              }
              onClick={() => setAction('announce')}
            >
              Announcement
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={stale}
              data-disabled-reason={
                stale
                  ? 'These controls changed elsewhere. Refresh the assessment to load the latest state.'
                  : undefined
              }
              onClick={() => setAction('extend')}
            >
              Extra time
            </button>
            <button
              type="button"
              className={`button ${paused ? 'primary' : 'secondary'}`}
              disabled={
                stale || (!paused && Boolean(data.opensAt && data.serverNow < data.opensAt))
              }
              onClick={() => setAction(paused ? 'resume' : 'pause')}
            >
              {paused ? 'Resume examination' : 'Pause examination'}
            </button>
          </div>
        </div>
      )}
      {feedback && (
        <p role="status" className="control-feedback">
          {feedback}
        </p>
      )}
      {Boolean(data.announcements?.length) && (
        <details className="control-announcement-history">
          <summary>Announcements ({data.announcements!.length})</summary>
          <ul>
            {data.announcements!.map((a) => (
              <li key={a.id}>
                <p className="pre-wrap">{a.message}</p>
                <time>{new Date(a.createdAt).toLocaleString()}</time>
              </li>
            ))}
          </ul>
        </details>
      )}
      {action && (
        <ControlDialog
          id={id}
          action={action}
          data={data}
          onClose={() => setAction(null)}
          onSaved={saved}
        />
      )}
    </section>
  );
}

export function CandidateControlActions({
  id,
  candidate,
  data,
  stale,
  onChange,
}: {
  id: string;
  candidate: MonitoredCandidate;
  data: MonitoringSnapshot;
  stale: boolean;
  onChange: () => void;
}) {
  const [action, setAction] = useState<ExamControlAction | null>(null);
  const [feedback, setFeedback] = useState('');
  const ongoing = ['active', 'disconnected'].includes(candidate.status);
  return (
    <div className="candidate-control-actions">
      {ongoing && (
        <div className="inline">
          <button
            type="button"
            className="text-button"
            disabled={stale}
            data-disabled-reason={
              stale
                ? 'These controls changed elsewhere. Refresh the assessment to load the latest state.'
                : undefined
            }
            onClick={() => setAction('extend')}
          >
            Add extra time
          </button>
          <button
            type="button"
            className="text-button control-danger"
            disabled={stale}
            data-disabled-reason={
              stale
                ? 'These controls changed elsewhere. Refresh the assessment to load the latest state.'
                : undefined
            }
            onClick={() => setAction('force_submit')}
          >
            Submit saved answers
          </button>
        </div>
      )}
      {feedback && (
        <p role="status" className="control-feedback">
          {feedback}
        </p>
      )}
      {action && (
        <ControlDialog
          id={id}
          action={action}
          candidate={candidate}
          data={data}
          onClose={() => setAction(null)}
          onSaved={(message) => {
            setFeedback(message);
            onChange();
          }}
        />
      )}
    </div>
  );
}
