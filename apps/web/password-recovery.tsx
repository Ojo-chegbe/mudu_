import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError, errorMessage } from './api.ts';
import { Brand, Notice, PasswordInput } from './ui.tsx';

// Keep the one-time proof out of history, browser storage, referrers and API URLs.
const recoveryFragment =
  location.pathname === '/account/recovery' ? new URLSearchParams(location.hash.slice(1)) : null;
let resetProof = recoveryFragment?.get('token_hash') ?? '';
const linkError = Boolean(recoveryFragment?.size && !resetProof);
if (recoveryFragment && location.hash)
  history.replaceState(null, '', location.pathname + location.search);

export function recoveryHref(role: 'admin' | 'candidate', local = false) {
  return `/account/forgot-password?role=${role}${local ? '&local=1' : ''}`;
}

export function PasswordRecoveryPage({ available }: { available: boolean }) {
  const params = new URLSearchParams(location.search);
  const candidate = params.get('role') === 'candidate';
  const local = params.get('local') === '1';
  const resetting = location.pathname === '/account/recovery';
  const signIn = candidate ? '/exam?mode=connected' : '/account/sign-in';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [done, setDone] = useState(false);
  const [ready, setReady] = useState(!resetting || Boolean(resetProof));
  const [expired, setExpired] = useState(Boolean(linkError));
  const [uncertain, setUncertain] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const grant = useRef('');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Opening another email link in the same tab can be a fragment-only navigation.
    const readLink = () => {
      if (!resetting || !location.hash) return;
      const values = new URLSearchParams(location.hash.slice(1));
      resetProof = values.get('token_hash') ?? '';
      history.replaceState(null, '', location.pathname + location.search);
      grant.current = '';
      setDone(false);
      setExpired(!resetProof);
      setUncertain(false);
      setReady(true);
      setPassword('');
      setConfirmation('');
      setError('');
    };
    window.addEventListener('hashchange', readLink);
    return () => window.removeEventListener('hashchange', readLink);
  }, [resetting]);
  useEffect(() => {
    if (!resetting || resetProof || linkError) return;
    let active = true;
    void api<{ csrf: string; completed: boolean; uncertain?: boolean }>('/password-recovery/state')
      .then((state) => {
        if (!active) return;
        grant.current = state.csrf;
        setDone(state.completed);
        setUncertain(Boolean(state.uncertain));
        setReady(true);
      })
      .catch((err) => {
        if (!active) return;
        if (err instanceof ApiError && err.code === 'RECOVERY_EXPIRED') setExpired(true);
        else setError(errorMessage(err));
        setReady(true);
      });
    return () => {
      active = false;
    };
  }, [resetting]);
  useEffect(() => {
    heading.current?.focus();
  }, [sent, done, expired, uncertain]);
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);
  async function request(event: FormEvent) {
    event.preventDefault();
    if (busy || cooldown) return;
    setBusy(true);
    setError('');
    try {
      await api('/password-recovery/request', {
        method: 'POST',
        body: { email, role: candidate ? 'candidate' : 'admin' },
      });
      setSent(true);
      setCooldown(60);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function complete(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (password !== confirmation) {
      setError('The passwords do not match. Enter the same password in both fields.');
      return;
    }
    setBusy(true);
    try {
      if (resetProof) {
        const state = await api<{ csrf: string }>('/password-recovery/verify', {
          method: 'POST',
          body: { tokenHash: resetProof },
        });
        grant.current = state.csrf;
        resetProof = '';
      }
      if (!grant.current) {
        const state = await api<{ csrf: string; completed: boolean }>('/password-recovery/state');
        grant.current = state.csrf;
        if (state.completed) {
          setDone(true);
          return;
        }
      }
      await api('/password-recovery/complete', {
        method: 'POST',
        csrfToken: grant.current,
        body: { password },
      });
      setPassword('');
      setConfirmation('');
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'RECOVERY_EXPIRED') {
        resetProof = '';
        setExpired(true);
      } else if (err instanceof ApiError && err.code === 'RECOVERY_UNCERTAIN') setUncertain(true);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="boot recovery-layout">
      <Brand />
      <section className="auth-card recovery-card" aria-busy={busy}>
        <span className="eyebrow">ACCOUNT RECOVERY</span>
        <h1 ref={heading} tabIndex={-1}>
          {done
            ? 'Password changed.'
            : uncertain
              ? 'Check your password change.'
              : expired
                ? 'Request a new reset link.'
                : resetting
                  ? 'Choose a new password.'
                  : sent
                    ? 'Check your email.'
                    : local
                      ? 'Recover account access.'
                      : 'Forgot your password?'}
        </h1>
        {uncertain ? (
          <>
            <p className="muted">
              Your password change is still processing or its result could not be confirmed. Try
              signing in with the new password. If it does not work, request a fresh reset link.
            </p>
            <a className="button primary full" href={signIn}>
              Try signing in
            </a>
            <p className="auth-switch muted small">
              <a href={recoveryHref(candidate ? 'candidate' : 'admin')}>Request a new reset link</a>
            </p>
          </>
        ) : done ? (
          <>
            <p>Your new password is ready. Sign in to continue with your existing account.</p>
            <p className="field-hint">
              Your assessments, registrations and saved answers are kept. A separate local Host
              password stays the same.
            </p>
            <a className="button primary full" href={signIn}>
              Back to sign in
            </a>
          </>
        ) : expired ? (
          <>
            <p className="muted">
              This link is invalid, expired or already used. You can request another one.
            </p>
            <a
              className="button primary full"
              href={recoveryHref(candidate ? 'candidate' : 'admin')}
            >
              Request a new link
            </a>
          </>
        ) : local ? (
          <>
            <p className="muted">
              Email recovery resets your connected MUDU password. It cannot reset a separate
              password stored only on this Host.
            </p>
            <p>
              If you connected your account, use email recovery and then connected sign-in. For a
              local-only candidate account, contact your examination organiser. For local Host
              administration, contact the person managing this computer. Keep the Host data folder
              intact.
            </p>
            {available && (
              <a
                className="button primary full"
                href={recoveryHref(candidate ? 'candidate' : 'admin')}
              >
                Recover connected account
              </a>
            )}
          </>
        ) : !available ? (
          <Notice kind="info">
            Account recovery needs the main MUDU service and an internet connection. Open the
            connected service to recover your account.
          </Notice>
        ) : resetting ? (
          <>
            <p className="muted">
              Use at least 8 characters. A longer, memorable passphrase works well.
            </p>
            <form onSubmit={complete}>
              <label>
                New password
                <PasswordInput
                  secretLabel="new password"
                  required
                  minLength={8}
                  maxLength={128}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy || !ready}
                />
              </label>
              <label>
                Confirm new password
                <PasswordInput
                  secretLabel="confirm new password"
                  required
                  minLength={8}
                  maxLength={128}
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  disabled={busy || !ready}
                />
              </label>
              {error && <Notice>{error}</Notice>}
              <button className="button primary full" disabled={busy || !ready}>
                {busy
                  ? 'Changing password…'
                  : !ready
                    ? 'Checking reset session…'
                    : 'Save new password'}
              </button>
            </form>
          </>
        ) : (
          <>
            <p className="muted">
              {sent
                ? `If a connected account exists for ${email}, you’ll receive a reset link. Check your spam folder too.`
                : 'Enter the email address you use for your connected MUDU account.'}
            </p>
            <form onSubmit={request}>
              {!sent && (
                <label>
                  Email address
                  <input
                    type="email"
                    required
                    maxLength={254}
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={busy}
                    autoFocus
                  />
                </label>
              )}
              {error && <Notice>{error}</Notice>}
              <button className="button primary full" disabled={busy || cooldown > 0}>
                {busy
                  ? 'Sending…'
                  : sent
                    ? cooldown
                      ? `Resend available in ${cooldown}s`
                      : 'Resend reset email'
                    : 'Send reset link'}
              </button>
            </form>
            {sent && (
              <button
                className="text-button"
                disabled={busy}
                onClick={() => {
                  setSent(false);
                  setCooldown(0);
                  setError('');
                }}
              >
                Use a different email
              </button>
            )}
            <p className="field-hint">
              A reset link works once. Requesting recovery does not change your password or sign you
              out.
            </p>
          </>
        )}
        {!done && !uncertain && (
          <p className="auth-switch muted small">
            <a href={signIn}>Back to sign in</a>
          </p>
        )}
      </section>
    </main>
  );
}
