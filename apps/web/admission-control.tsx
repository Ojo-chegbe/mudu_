import { useState } from 'react';
import { api, errorMessage } from './api.ts';
import { Dialog, Notice } from './ui.tsx';

export function AdmissionControl({
  id,
  enabled,
  completed,
  onChange,
}: {
  id: string;
  enabled: boolean;
  completed: boolean;
  onChange: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  async function save(next: boolean) {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api<{ added: number }>(`/assessments/${id}/admission`, {
        method: 'POST',
        body: { allowLateAdmission: next, expectedAllowLateAdmission: enabled },
      });
      await onChange();
      setMessage(
        next
          ? `Late admission enabled.${result.added ? ` ${result.added} new candidate${result.added === 1 ? '' : 's'} admitted.` : ''}`
          : 'Late admission closed. Existing candidates keep their access.',
      );
      setConfirm(false);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="admission-control">
      <div>
        <strong>New roster members</strong>
        <p className="field-hint">
          {completed
            ? 'This examination is closed.'
            : enabled
              ? 'Approved members can join while the start window is open.'
              : 'Late admission is closed. Existing candidates can still begin within the start window.'}
        </p>
      </div>
      {!completed && (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => (enabled ? void save(false) : setConfirm(true))}
        >
          {busy ? 'Saving…' : enabled ? 'Close late admission' : 'Allow late admission'}
        </button>
      )}
      {message && (
        <p className="field-hint admission-feedback" role="status">
          {message}
        </p>
      )}
      {error && !confirm && <Notice>{error}</Notice>}
      {confirm && (
        <Dialog
          title="Allow late admission?"
          confirmLabel="Allow late admission"
          busy={busy}
          onClose={() => setConfirm(false)}
          confirm={() => void save(true)}
        >
          {error && <Notice>{error}</Notice>}
          <p>
            Newly approved roster members will receive this assessment automatically while its start
            window remains open.
          </p>
          <p>
            Shared-start exams give them only the time remaining. Individual-start exams give them
            the configured duration, subject to any finish-by deadline.
          </p>
        </Dialog>
      )}
    </div>
  );
}
