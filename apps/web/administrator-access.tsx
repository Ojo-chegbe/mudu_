import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AuthState } from '../../packages/contracts/http.ts';
import { api, errorMessage } from './api.ts';
import { Brand, Dialog, Icon, Notice, PasswordInput } from './ui.tsx';
import { pendingConnection, rememberConnection } from './workspace-connection.ts';
import { recoveryHref } from './password-recovery.tsx';

export function AdministratorAccess({
  auth,
  onAuthenticated,
}: {
  auth: AuthState;
  onAuthenticated: () => Promise<void>;
}) {
  const [mode, setMode] = useState<'signin' | 'signup' | 'local' | 'device'>(
    auth.deviceAccessAvailable &&
      (new URLSearchParams(location.search).get('mode') === 'device' ||
        (!auth.cloudAvailable && auth.configured && !auth.localConfigured))
      ? 'device'
      : auth.cloudAvailable && new URLSearchParams(location.search).get('mode') !== 'local'
        ? 'signin'
        : 'local',
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false);
  const [name, setName] = useState(''),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState('');
  const localConfigured = auth.localConfigured ?? auth.configured;
  const creating = mode === 'signup' || (mode === 'local' && !localConfigured);
  function switchMode(next: typeof mode) {
    setMode(next);
    setError('');
    setPassword('');
    setPending(false);
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const path =
        mode === 'device'
          ? '/admin/device/login'
          : mode === 'local'
            ? localConfigured
              ? '/admin/login'
              : '/admin/setup'
            : mode === 'signup'
              ? '/admin/cloud/signup'
              : '/admin/cloud/login';
      const result = await api<{ pending?: boolean }>(path, {
        method: 'POST',
        body: { name, email, password },
      });
      setPassword('');
      if (result.pending) setPending(true);
      else await onAuthenticated();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-layout">
      <aside className="auth-story">
        <Brand />
        <div>
          <span className="eyebrow">ASSESSMENTS, WITHOUT LIMITS</span>
          <h1>
            A little less admin.
            <br />A lot more possibility.
          </h1>
          <p>Create thoughtfully. Deliver confidently. Keep every answer accounted for.</p>
        </div>
        <span className="story-footer">
          <Icon name="shield" size={16} /> Your assessments. Your private workspace.
        </span>
      </aside>
      <main className="auth-main">
        <div className="auth-card">
          <span className="eyebrow">
            {mode === 'device'
              ? 'OFFLINE ACCESS'
              : mode === 'local'
                ? 'EXISTING HOST ACCESS'
                : 'YOUR MUDU ACCOUNT'}
          </span>
          <h1>
            {pending
              ? 'Check your email.'
              : mode === 'device'
                ? 'Open your saved workspace.'
                : creating
                  ? mode === 'signup'
                    ? 'Create your MUDU account.'
                    : 'Set up this computer.'
                  : 'Welcome back.'}
          </h1>
          <p className="muted">
            {pending
              ? `Confirm your account using the email sent to ${email}, then return here to sign in.`
              : mode === 'device'
                ? 'Use your MUDU account email and this computer’s device password. No internet connection or second account is needed.'
                : mode === 'local'
                  ? 'Manage this Host using its local administrator account.'
                  : creating
                    ? 'One account for your assessments, rosters and question bank. Your workspace on this computer is created automatically when you sign in.'
                    : 'Sign in to your private assessment workspace.'}
          </p>
          {auth.role === 'candidate' && (
            <Notice kind="info">
              You are signed in as a candidate. Signing in here replaces this browser session, not
              your candidate account.
            </Notice>
          )}
          {pending ? (
            <button
              type="button"
              className="button primary full"
              onClick={() => switchMode('signin')}
            >
              Back to sign in
            </button>
          ) : (
            <form onSubmit={submit}>
              {creating && (
                <label>
                  Your name
                  <input
                    autoComplete="name"
                    required
                    maxLength={100}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={busy}
                  />
                </label>
              )}
              {mode !== 'local' && (
                <label>
                  Email address
                  <input
                    type="email"
                    autoComplete="username"
                    required
                    maxLength={254}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={busy}
                  />
                </label>
              )}
              <label>
                {mode === 'device' ? 'Device password' : 'Password'}
                <PasswordInput
                  secretLabel={mode === 'device' ? 'Device password' : 'password'}
                  name="password"
                  autoComplete={creating ? 'new-password' : 'current-password'}
                  required
                  minLength={creating ? (mode === 'local' ? 12 : 8) : 1}
                  maxLength={128}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                />
              </label>
              {creating && (
                <p className="field-hint">
                  {mode === 'local'
                    ? 'Keep this Host password safe. It works without internet.'
                    : 'Use at least 8 characters. A memorable passphrase works well.'}
                </p>
              )}
              {mode === 'device' && (
                <p className="field-hint">
                  Offline access must already be enabled on this computer. Forgot the device
                  password? Sign in online to replace it.
                </p>
              )}
              {!creating && mode !== 'device' && (
                <p className="auth-switch muted small">
                  <a href={recoveryHref('admin', mode === 'local')}>Forgot your password?</a>
                </p>
              )}
              {error && <Notice>{error}</Notice>}
              <button className="button primary full" disabled={busy}>
                {busy
                  ? 'Please wait…'
                  : mode === 'device'
                    ? 'Open workspace'
                    : creating
                      ? mode === 'signup'
                        ? 'Create account'
                        : 'Set up computer'
                      : 'Sign in'}
                <Icon name="arrow" size={17} />
              </button>
            </form>
          )}
          {(auth.cloudAvailable || auth.deviceAccessAvailable) && !pending && (
            <div className="administrator-auth-switch">
              {auth.cloudAvailable &&
                (mode === 'signin' ? (
                  <p>
                    New to MUDU?{' '}
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() => switchMode('signup')}
                    >
                      Create an account
                    </button>
                  </p>
                ) : (
                  <p>
                    Already have a MUDU account?{' '}
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() => switchMode('signin')}
                    >
                      Sign in
                    </button>
                  </p>
                ))}
              {auth.deviceAccessAvailable && mode !== 'device' && (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => switchMode('device')}
                >
                  Use offline access on this computer
                </button>
              )}
              {mode !== 'local' && localConfigured && (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => switchMode('local')}
                >
                  Use an existing Host password
                </button>
              )}
            </div>
          )}
          <div className="auth-divider" />
          <p className="muted small">
            Here to take an examination? <a href="/exam">Candidate access</a>
          </p>
        </div>
      </main>
    </div>
  );
}

export function ConnectWorkspace({
  name: initialName,
  ownerId,
  onConnected,
}: {
  name: string;
  ownerId: string;
  onConnected: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [savedEmail] = useState(() => {
    try {
      return pendingConnection(sessionStorage, ownerId);
    } catch {
      return '';
    }
  });
  const [email, setEmail] = useState(savedEmail),
    [name, setName] = useState(initialName),
    [password, setPassword] = useState(''),
    [hostPassword, setHostPassword] = useState('');
  const [mode, setMode] = useState<'create' | 'existing' | 'confirm'>(
    savedEmail ? 'confirm' : 'create',
  );
  const form = useRef<HTMLFormElement>(null);
  function savePending(email: string) {
    try {
      rememberConnection(sessionStorage, ownerId, email);
    } catch {
      /* Optional tab storage. */
    }
  }
  function switchMode(next: typeof mode) {
    savePending('');
    setMode(next);
    setPassword('');
    setHostPassword('');
    setError('');
  }
  async function connect(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ pending?: boolean }>(
        mode === 'create' ? '/admin/cloud/connect/signup' : '/admin/cloud/connect',
        {
          method: 'POST',
          body: { name, email, password, hostPassword },
        },
      );
      setPassword('');
      setHostPassword('');
      if (result.pending) {
        savePending(email);
        setMode('confirm');
        return;
      }
      savePending('');
      setOpen(false);
      await onConnected();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="workspace-connect-prompt" aria-label="Connect your workspace">
        <div>
          <strong>Keep your existing workspace</strong>
          <p>Connect a cloud account without moving or deleting your local records.</p>
        </div>
        <button
          type="button"
          className="button secondary"
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          Connect account
          <Icon name="arrow" size={16} />
        </button>
      </section>
      {open && (
        <Dialog
          title={mode === 'confirm' ? 'Confirm your email' : 'Connect your existing workspace'}
          confirmLabel={
            mode === 'create'
              ? 'Create account & continue'
              : mode === 'confirm'
                ? 'Connect my workspace'
                : 'Sign in & connect'
          }
          busy={busy}
          confirmDisabled={
            !email || !password || !hostPassword || (mode === 'create' && !name.trim())
          }
          onClose={() => {
            setOpen(false);
            setPassword('');
            setHostPassword('');
            setError('');
          }}
          confirm={() => form.current?.requestSubmit()}
        >
          {mode === 'confirm' ? (
            <div className="workspace-connect-confirmation" role="status">
              <Icon name="check" size={20} />
              <div>
                <strong>Check your inbox</strong>
                <p>
                  Open the confirmation email sent to <strong>{email}</strong>, then return here to
                  finish connecting.
                </p>
              </div>
            </div>
          ) : (
            <>
              <p className="workspace-connect-intro">
                Your assessments, rosters and questions stay in this workspace.
              </p>
              <div className="workspace-connect-modes" aria-label="Cloud account options">
                <button
                  type="button"
                  aria-pressed={mode === 'create'}
                  disabled={busy}
                  onClick={() => switchMode('create')}
                >
                  Create an account
                </button>
                <button
                  type="button"
                  aria-pressed={mode === 'existing'}
                  disabled={busy}
                  onClick={() => switchMode('existing')}
                >
                  I already have an account
                </button>
              </div>
            </>
          )}
          <form
            ref={form}
            className="workspace-connect-form"
            onSubmit={(event) => void connect(event)}
          >
            {mode === 'create' && (
              <label>
                Your name
                <input
                  autoComplete="name"
                  required
                  maxLength={100}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={busy}
                />
              </label>
            )}
            {mode !== 'confirm' && (
              <label>
                Email address
                <input
                  type="email"
                  autoComplete="username"
                  required
                  maxLength={254}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={busy}
                />
              </label>
            )}
            {mode === 'confirm' && (
              <p className="field-hint">
                After confirming, enter your passwords below. Your local workspace is still
                available.
              </p>
            )}
            <label>
              {mode === 'create' ? 'Create a cloud password' : 'Cloud account password'}
              <PasswordInput
                key={mode}
                secretLabel="cloud account password"
                autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
                required
                minLength={mode === 'create' ? 8 : 1}
                maxLength={128}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
              />
              {mode === 'create' && (
                <span className="field-hint">
                  Use at least 8 characters. A memorable passphrase works well.
                </span>
              )}
            </label>
            <label>
              Current local Host password
              <PasswordInput
                key={mode}
                secretLabel="local Host password"
                autoComplete="off"
                required
                maxLength={128}
                value={hostPassword}
                onChange={(event) => setHostPassword(event.target.value)}
                disabled={busy}
              />
              <span className="field-hint">
                The password you use to open this workspace. It will still work offline.
              </span>
            </label>
            {error && <Notice>{error}</Notice>}
            <button type="submit" className="sr-only" tabIndex={-1} disabled={busy}>
              Continue
            </button>
          </form>
          {mode !== 'create' && (
            <p className="field-hint">
              <a href={recoveryHref('admin')} target="_blank" rel="noopener noreferrer">
                Forgot your cloud password? Recover it in a new tab
              </a>
            </p>
          )}
          {mode === 'confirm' && (
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => switchMode('existing')}
            >
              Change email or use another account
            </button>
          )}
          <p className="workspace-connect-footnote">
            Your question bank syncs automatically when cloud storage is ready. You choose when to
            sync completed assessments from Cloud sync.
          </p>
        </Dialog>
      )}
    </>
  );
}
