import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AuthState, WorkspaceConnectionState } from '../../packages/contracts/http.ts';
import { api, errorMessage } from './api.ts';
import { Dialog, Notice, PasswordInput } from './ui.tsx';

export function DeviceAccess({
  auth,
  onChanged,
  placement = 'onboarding',
  onConfigured,
}: {
  auth: AuthState;
  onChanged: () => Promise<void>;
  placement?: 'onboarding' | 'settings';
  onConfigured?: () => void;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const [accountPassword, setAccountPassword] = useState(''),
    [devicePassword, setDevicePassword] = useState(''),
    [confirm, setConfirm] = useState('');
  const [disable, setDisable] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  if (
    !auth.deviceAccessAvailable ||
    !auth.cloudConnected ||
    (placement === 'onboarding' && (auth.deviceAccessEnabled || auth.deviceAccessConfigured))
  )
    return null;
  function close() {
    setOpen(false);
    setError('');
    setAccountPassword('');
    setDevicePassword('');
    setConfirm('');
    setDisable(false);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!disable && devicePassword !== confirm) {
      setError('The device passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('/admin/device-access', {
        method: 'POST',
        body: { action: disable ? 'disable' : 'enable', accountPassword, devicePassword },
      });
      setMessage(
        disable
          ? 'Offline access disabled. Your workspace and saved work are unchanged.'
          : 'Offline access enabled on this computer. Use your account email and device password when offline.',
      );
      close();
      await onChanged();
      if (!disable) onConfigured?.();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="workspace-connect-prompt" aria-label="Offline access">
        <div>
          <strong>
            {auth.deviceAccessEnabled
              ? 'Offline access is enabled on this computer'
              : 'One account, even when working offline'}
          </strong>
          <p>
            {auth.connection?.state === 'offline'
              ? 'Your saved workspace stays available. Reconnect online to change device access.'
              : auth.deviceAccessEnabled
                ? 'Connection changes keep you in this workspace. Your device password is only needed to unlock it after signing out.'
                : 'Enable offline access to open your saved workspace without creating another account.'}
          </p>
        </div>
        <button
          className="button secondary"
          disabled={busy}
          onClick={async () => {
            setMessage('');
            if (!auth.cloudSignedIn) {
              if (auth.connection?.needsOnlineSignIn) {
                location.href = '/account/sign-in?return=/settings';
                return;
              }
              setBusy(true);
              setError('');
              try {
                const state = await api<WorkspaceConnectionState>('/workspace/connection', {
                  method: 'POST',
                  body: { mode: 'auto' },
                });
                await onChanged();
                if (state.state !== 'online') {
                  setError(
                    'The online service is still unavailable. Your workspace remains accessible offline.',
                  );
                  return;
                }
              } catch (e) {
                setError(errorMessage(e));
                return;
              } finally {
                setBusy(false);
              }
            }
            setOpen(true);
          }}
        >
          {auth.cloudSignedIn
            ? auth.deviceAccessEnabled
              ? 'Manage offline access'
              : 'Enable offline access'
            : auth.connection?.needsOnlineSignIn
              ? 'Sign in online'
              : 'Reconnect online'}
        </button>
      </section>
      {message && <Notice kind="info">{message}</Notice>}
      {error && !open && <Notice>{error}</Notice>}
      {open &&
        (!auth.cloudSignedIn ? (
          <Dialog
            title="You are working offline"
            confirmLabel="Back to workspace"
            onClose={close}
            confirm={close}
          >
            <p>
              Use the connection controls in Settings to reconnect. If you unlocked this workspace
              after signing out, sign in online with your existing MUDU account. Your saved work
              stays here.
            </p>
          </Dialog>
        ) : (
          <Dialog
            title={
              disable
                ? 'Disable offline access'
                : auth.deviceAccessEnabled
                  ? 'Change your device password'
                  : 'Enable offline access'
            }
            confirmLabel={disable ? 'Disable offline access' : 'Save device password'}
            busy={busy}
            onClose={close}
            confirm={() => form.current?.requestSubmit()}
          >
            <p>
              This applies only to this computer and uses your existing MUDU account. Enable it only
              on a computer you trust.
            </p>
            <form ref={form} className="device-access-form" onSubmit={submit}>
              <label>
                MUDU account password
                <PasswordInput
                  secretLabel="MUDU account password"
                  autoComplete="current-password"
                  required
                  maxLength={128}
                  value={accountPassword}
                  onChange={(e) => setAccountPassword(e.target.value)}
                  disabled={busy}
                />
              </label>
              {!disable && (
                <>
                  <label>
                    Device password
                    <PasswordInput
                      secretLabel="Device password"
                      autoComplete="new-password"
                      required
                      minLength={12}
                      maxLength={128}
                      value={devicePassword}
                      onChange={(e) => setDevicePassword(e.target.value)}
                      disabled={busy}
                    />
                  </label>
                  <label>
                    Confirm device password
                    <PasswordInput
                      secretLabel="Confirm device password"
                      autoComplete="new-password"
                      required
                      minLength={12}
                      maxLength={128}
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      disabled={busy}
                    />
                  </label>
                  <p className="field-hint">
                    Use at least 12 characters. This unlocks your saved workspace here; it does not
                    change your MUDU account password. Internet is still needed for cloud features.
                    Local examinations must be prepared before going offline.
                  </p>
                </>
              )}
              {disable && (
                <p>
                  Other offline sessions for this account on this computer will be signed out. Saved
                  work is kept.
                </p>
              )}
              {error && <Notice>{error}</Notice>}
              <button type="submit" className="sr-only" tabIndex={-1} disabled={busy}>
                Save
              </button>
            </form>
            {auth.deviceAccessEnabled && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => {
                  setDisable(!disable);
                  setError('');
                  setDevicePassword('');
                  setConfirm('');
                }}
              >
                {disable ? 'Change device password instead' : 'Disable offline access'}
              </button>
            )}
          </Dialog>
        ))}
    </>
  );
}
