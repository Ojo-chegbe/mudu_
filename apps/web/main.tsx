import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { FormEvent } from 'react';
import type { AuthState } from '../../packages/contracts/http.ts';
import { api, errorMessage, setCsrf } from './api.ts';
import { Brand, Icon, Loading, Notice, PasswordInput } from './ui.tsx';
import { Dashboard, Detail } from './workspace.tsx';
import { CreateAssessment } from './create.tsx';
import { draftKey } from './assessment-draft.ts';
import { Candidate } from './candidate.tsx';
import { CandidatePortal } from './portal.tsx';
import './styles.css';
import { Notifications } from './notifications.tsx';
import { RostersPage } from './rosters.tsx';
import { LocalDeliveryPage } from './local-delivery.tsx';
import { AssessmentEditor } from './assessment-editor.tsx';
import { QuestionBankPage } from './question-bank.tsx';
import { BankEditor } from './bank-editor.tsx';
import { BankGenerate } from './bank-generate.tsx';

function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const candidateRoute =
    location.pathname.startsWith('/exam') || location.pathname.startsWith('/join/');
  async function refresh() {
    try {
      const value = await api<AuthState>('/auth');
      setCsrf(value.csrf);
      setAuth(value);
      setError('');
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (!candidateRoute) return;
    // This is reachability telemetry, not an authenticated candidate count.
    const ping = () => {
      void api('/local-connection', { method: 'POST', body: {} }).catch(() => {});
    };
    ping();
    const timer = setInterval(ping, 30000);
    return () => clearInterval(timer);
  }, [candidateRoute]);
  async function logout() {
    try {
      await api('/logout', { method: 'POST', body: {} });
      try {
        sessionStorage.removeItem(draftKey);
        for (const key of Object.keys(sessionStorage))
          if (
            key.startsWith('mudu.roster-draft.') ||
            key.startsWith('mudu.assessment-edit.') ||
            key.startsWith('mudu.assessment-rerun.') ||
            key.startsWith('mudu.bank-')
          )
            sessionStorage.removeItem(key);
      } catch {
        /* Storage may be disabled. */
      }
      setCsrf(null);
      location.href = candidateRoute ? '/exam' : '/';
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api(auth?.configured ? '/admin/login' : '/admin/setup', {
        method: 'POST',
        body: values,
      });
      await refresh();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  if (!auth)
    return (
      <main className="boot">
        <Brand />
        {error ? (
          <>
            <Notice>{error}</Notice>
            <button className="button secondary" onClick={refresh}>
              Try again
            </button>
          </>
        ) : (
          <Loading />
        )}
      </main>
    );
  if (candidateRoute) {
    if (
      location.pathname === '/exam/legacy' ||
      (location.pathname === '/exam' && new URLSearchParams(location.search).has('code'))
    )
      return <Candidate auth={auth} onLogin={refresh} onLogout={logout} />;
    return <CandidatePortal auth={auth} onLogin={refresh} onLogout={logout} />;
  }
  if (auth.role !== 'admin')
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
            <Icon name="server" size={16} /> Your local MUDU workspace
          </span>
        </aside>
        <main className="auth-main">
          <div className="auth-card">
            <span className="eyebrow">MUDU HOST</span>
            <h1>{auth.configured ? 'Welcome back.' : 'Make yourself at home.'}</h1>
            <p className="muted">
              {auth.configured
                ? 'Sign in to manage your assessments on this computer.'
                : 'Set up the administrator account for this computer.'}
            </p>
            {auth.role === 'candidate' && (
              <Notice kind="info">
                You are signed in as a candidate. Administrator sign-in will replace that browser
                session.
              </Notice>
            )}
            <form onSubmit={authenticate}>
              {!auth.configured && (
                <label>
                  Your name
                  <input
                    name="name"
                    autoComplete="name"
                    required
                    maxLength={100}
                    placeholder="How should we address you?"
                  />
                </label>
              )}
              <label>
                Password
                <PasswordInput
                  name="password"
                  autoComplete={auth.configured ? 'current-password' : 'new-password'}
                  minLength={auth.configured ? 1 : 12}
                  maxLength={128}
                  required
                  placeholder={auth.configured ? 'Enter your password' : 'At least 12 characters'}
                />
              </label>
              {!auth.configured && (
                <p className="field-hint">
                  Keep this password safe. Account recovery is not yet available in this development
                  build.
                </p>
              )}
              {error && <Notice>{error}</Notice>}
              <button className="button primary full" disabled={busy}>
                {busy ? 'Please wait…' : auth.configured ? 'Sign in' : 'Create workspace'}
                <Icon name="arrow" size={17} />
              </button>
            </form>
            <div className="auth-divider" />
            <p className="muted small">
              Here to take an examination?{' '}
              <a href="/exam">
                Candidate access <span aria-hidden="true">↗</span>
              </a>
            </p>
          </div>
        </main>
      </div>
    );
  const path = location.pathname;
  const id = path.match(/^\/assessments\/([a-f0-9-]+)$/)?.[1];
  const editId = path.match(/^\/assessments\/([a-f0-9-]+)\/edit$/)?.[1];
  return (
    <div className="workspace">
      <aside className="sidebar">
        <Brand />
        <div className="workspace-label">YOUR WORKSPACE</div>
        <nav aria-label="Main navigation">
          <a
            className={`nav-item ${path === '/' || path.startsWith('/assessments') ? 'selected' : ''}`}
            href="/"
          >
            <Icon name="paper" />
            Assessments
          </a>
          <a
            className={`nav-item ${path.startsWith('/rosters') ? 'selected' : ''}`}
            href="/rosters"
          >
            <Icon name="people" />
            Rosters
          </a>
          <a
            className={`nav-item ${path.startsWith('/question-bank') ? 'selected' : ''}`}
            href="/question-bank"
          >
            <Icon name="paper" />
            Question bank
          </a>
          <a
            className={`nav-item ${path === '/local-delivery' ? 'selected' : ''}`}
            href="/local-delivery"
          >
            <Icon name="server" />
            Local delivery
          </a>
          <a className="nav-item" href="/exam">
            <Icon name="people" />
            Candidate access
            <Icon name="arrow" size={14} />
          </a>
        </nav>
        <div className="sidebar-bottom">
          <div className="host-status">
            <span className="status-dot" />
            <div>
              <strong>Local workspace</strong>
              <span>Stored on this computer</span>
            </div>
          </div>
          <button className="account-button" onClick={logout}>
            <span className="avatar">{auth.name?.[0]?.toUpperCase() ?? 'M'}</span>
            <span>
              {auth.name}
              <small>Administrator</small>
            </span>
            <Icon name="logout" size={17} />
          </button>
        </div>
      </aside>
      <div className="workspace-main">
        <header className="topbar">
          <span>
            Workspace <span className="slash">/</span> <a href="/">Assessments</a>
            {path !== '/' && (
              <>
                <span className="slash">/</span>
                <span>
                  {path.startsWith('/question-bank')
                    ? 'Question bank'
                    : editId
                      ? 'Edit assessment'
                      : path === '/local-delivery'
                        ? 'Local delivery'
                        : path.startsWith('/rosters')
                          ? 'Rosters'
                          : path === '/assessments/new'
                            ? 'Create'
                            : ({ results: 'Results', questions: 'Questions', activity: 'Activity' }[
                                new URLSearchParams(location.search).get('tab') ?? ''
                              ] ?? 'Overview')}
                </span>
              </>
            )}
          </span>
          <div className="actions">
            <Notifications />
            <span className="topbar-label">
              <Icon name="server" size={15} />
              MUDU Host
            </span>
          </div>
        </header>
        <main className="content">
          {error && <Notice>{error}</Notice>}
          {path === '/question-bank' ? (
            <QuestionBankPage />
          ) : path === '/question-bank/generate' ? (
            <BankGenerate />
          ) : path === '/question-bank/new' || /^\/question-bank\/[a-f0-9-]{36}$/.test(path) ? (
            <BankEditor id={path.endsWith('/new') ? undefined : path.split('/')[2]} />
          ) : editId ? (
            <AssessmentEditor id={editId} />
          ) : path === '/local-delivery' ? (
            <LocalDeliveryPage />
          ) : path === '/rosters' || /^\/rosters\/(new|[a-f0-9-]{36})$/.test(path) ? (
            <RostersPage id={path.split('/')[2]} />
          ) : path === '/assessments/new' ? (
            <CreateAssessment />
          ) : id ? (
            <Detail id={id} />
          ) : path === '/' ? (
            <Dashboard name={auth.name ?? 'there'} />
          ) : (
            <>
              <h1>Page not found</h1>
              <a href="/">Back to assessments</a>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
