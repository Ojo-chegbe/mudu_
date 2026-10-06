import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AuthState } from '../../packages/contracts/http.ts';
import { api, errorMessage, setCsrf } from './api.ts';
import { Dialog, Notice, PasswordInput } from './ui.tsx';

export function CandidateCloudConnection({
  auth,
  email,
  onConnected,
}: {
  auth: AuthState;
  email: string;
  onConnected: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [create, setCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  if (!auth.candidateCloudAvailable || auth.candidateCloudConnected || !email) return null;
  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ csrf?: string; pending?: boolean }>(
        `/candidate/cloud/connect${create ? '/signup' : ''}`,
        {
          method: 'POST',
          body: { ...Object.fromEntries(new FormData(event.currentTarget)), email },
        },
      );
      if (result.pending) {
        setConfirmation(true);
        setCreate(false);
        form.current?.reset();
      } else if (result.csrf) {
        setCsrf(result.csrf);
        await onConnected();
        setOpen(false);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="candidate-cloud-connect">
        <div>
          <strong>Keep one account across computers</strong>
          <p className="muted small">
            Connect your sign-in without changing your existing enrolments.
          </p>
        </div>
        <button
          className="button secondary"
          onClick={() => {
            setOpen(true);
            setError('');
          }}
        >
          Connect account
        </button>
      </div>
      {open && (
        <Dialog
          title="Connect your candidate account"
          busy={busy}
          confirmLabel={create ? 'Create connected sign-in' : 'Connect account'}
          confirm={() => form.current?.requestSubmit()}
          onClose={() => setOpen(false)}
        >
          <p className="muted small">
            Your account here stays the same. Use the same email for connected sign-in.
          </p>
          {confirmation && (
            <Notice kind="info">
              Check your email to confirm your account, then enter your passwords below to finish
              connecting.
            </Notice>
          )}
          <form ref={form} onSubmit={connect}>
            <fieldset disabled={busy}>
              <label>
                Email address
                <input type="email" value={email} readOnly autoComplete="email" />
              </label>
              <label>
                Existing password on this Host
                <PasswordInput
                  name="localPassword"
                  required
                  maxLength={128}
                  autoComplete="current-password"
                />
              </label>
              <label>
                {create ? 'Password for connected sign-in' : 'Connected account password'}
                <PasswordInput
                  key={create ? 'new' : 'existing'}
                  name="password"
                  required
                  minLength={create ? 8 : 1}
                  maxLength={128}
                  autoComplete={create ? 'new-password' : 'current-password'}
                />
              </label>
            </fieldset>
          </form>
          {!create && (
            <p className="field-hint">
              <a
                href="/account/forgot-password?role=candidate"
                target="_blank"
                rel="noopener noreferrer"
              >
                Forgot your connected password? Recover it in a new tab
              </a>
            </p>
          )}
          <button
            className="text-button"
            disabled={busy}
            onClick={() => {
              setCreate(!create);
              setError('');
            }}
          >
            {create
              ? 'Already have a connected account? Sign in'
              : 'No connected account yet? Create one'}
          </button>
          {error && <Notice>{error}</Notice>}
        </Dialog>
      )}
    </>
  );
}
