import { StrictMode, Suspense, lazy, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AuthState, WorkspaceConnectionState } from '../../packages/contracts/http.ts';
import { api, ApiError, errorMessage, setCsrf } from './api.ts';
import { Brand, Icon, Loading, Notice } from './ui.tsx';
import { AdministratorAccess, ConnectWorkspace } from './administrator-access.tsx';
import { BankCloudStatus } from './bank-cloud-status.tsx';
import { Dashboard, Detail } from './workspace.tsx';
import { clearWorkspaceDrafts, selectDraftWorkspace } from './workspace-drafts.ts';
import { Candidate } from './candidate.tsx';
const CandidatePortal = lazy(() =>
  import('./portal.tsx').then((module) => ({ default: module.CandidatePortal })),
);
import './styles.css';
import { Notifications } from './notifications.tsx';
import { RostersPage } from './rosters.tsx';
import { LocalDeliveryPage } from './local-delivery.tsx';
import { AssessmentEditor } from './assessment-editor.tsx';
import { QuestionBankPage } from './question-bank.tsx';
import { QuestionBankHome } from './bank-projects.tsx';
import { BankEditor } from './bank-editor.tsx';
import { BankGenerate } from './bank-generate.tsx';
import { CloudSyncPage } from './cloud-sync.tsx';
import { PasswordRecoveryPage } from './password-recovery.tsx';
const DeviceAccess = lazy(() =>
  import('./device-access.tsx').then((module) => ({ default: module.DeviceAccess })),
);

const CreateAssessment = lazy(() =>
  import('./create.tsx').then((module) => ({ default: module.CreateAssessment })),
);
const SettingsPage = lazy(() =>
  import('./account-pages.tsx').then((module) => ({ default: module.SettingsPage })),
);
const ProfilePage = lazy(() =>
  import('./account-pages.tsx').then((module) => ({ default: module.ProfilePage })),
);

function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState(''),
    [modeBusy, setModeBusy] = useState(false);
  const connectionBusy = useRef(false);
  const candidateRoute =
    location.pathname.startsWith('/exam') || location.pathname.startsWith('/join/');
  async function refresh() {
    try {
      const value = await api<AuthState>('/auth');
      if (value.role === 'admin' && value.adminId) {
        try {
          selectDraftWorkspace(sessionStorage, value.adminId, Boolean(value.hostOperator));
        } catch {
          /* Storage may be disabled. */
        }
      }
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
    document.documentElement.dataset.textSize = auth?.preferences?.textSize ?? 'normal';
    document.documentElement.dataset.motion = auth?.preferences?.reducedMotion ?? 'system';
  }, [auth?.preferences?.textSize, auth?.preferences?.reducedMotion]);
  useEffect(() => {
    if (auth?.role !== 'admin' || !auth.cloudConnected) return;
    let active = true;
    const check = async () => {
      if (connectionBusy.current || document.hidden) return;
      connectionBusy.current = true;
      try {
        await api<WorkspaceConnectionState>('/workspace/connection', { timeoutMs: 30000 });
        if (active) await refresh();
      } catch (e) {
        if (active && e instanceof ApiError && (e.status === 401 || e.status === 503))
          await refresh();
      } finally {
        connectionBusy.current = false;
      }
    };
    void check();
    const timer = setInterval(check, 15000);
    window.addEventListener('online', check);
    window.addEventListener('offline', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('online', check);
      window.removeEventListener('offline', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [auth?.role, auth?.adminId, auth?.cloudConnected]);
  async function changeMode(mode: 'auto' | 'offline') {
    if (modeBusy) return;
    setModeBusy(true);
    setError('');
    setFeedback('');
    try {
      const state = await api<WorkspaceConnectionState>('/workspace/connection', {
        method: 'POST',
        body: { mode },
        timeoutMs: 30000,
      });
      await refresh();
      setFeedback(
        state.needsOnlineSignIn
          ? 'Your workspace stays open offline. Sign in online from Settings when you need cloud access.'
          : state.state === 'offline'
            ? mode === 'offline'
              ? 'Working offline. Your page and saved work stay here.'
              : 'The online service is unavailable. Continuing in your saved workspace offline.'
            : 'Automatic connection enabled. You are connected online.',
      );
    } catch (e) {
      setError(errorMessage(e));
      throw e;
    } finally {
      setModeBusy(false);
    }
  }
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
        clearWorkspaceDrafts(sessionStorage);
      } catch {
        /* Storage may be disabled. */
      }
      setCsrf(null);
      location.href = candidateRoute ? '/exam' : '/';
    } catch (error) {
      setError(errorMessage(error));
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
    return (
      <Suspense fallback={<Loading />}>
        <CandidatePortal auth={auth} onLogin={refresh} onLogout={logout} />
      </Suspense>
    );
  }
  if (['/account/forgot-password', '/account/recovery'].includes(location.pathname))
    return (
      <PasswordRecoveryPage
        available={Boolean(auth.cloudAvailable || auth.candidateCloudAvailable)}
      />
    );
  if (auth.role !== 'admin' || location.pathname === '/account/sign-in')
    return (
      <AdministratorAccess
        auth={auth}
        onAuthenticated={async () => {
          await refresh();
          if (location.pathname === '/account/sign-in') {
            const requested = new URLSearchParams(location.search).get('return');
            location.href =
              requested &&
              [
                '/',
                '/local-delivery',
                '/cloud-sync',
                '/question-bank',
                '/rosters',
                '/settings',
                '/profile',
              ].includes(requested)
                ? requested
                : '/';
          }
        }}
      />
    );
  const path = location.pathname;
  const id = path.match(/^\/(?:online\/)?assessments\/([a-f0-9-]+)$/)?.[1];
  const editId = path.match(/^\/assessments\/([a-f0-9-]+)\/edit$/)?.[1];
  return (
    <div className="workspace">
      <aside className="sidebar">
        <Brand />
        <div className="workspace-label">YOUR WORKSPACE</div>
        <nav aria-label="Main navigation">
          <a
            className={`nav-item ${path === '/' || path.startsWith('/assessments') || path.startsWith('/online/assessments') ? 'selected' : ''}`}
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
            <Icon name="help" />
            Question bank
          </a>
          {auth.hostOperator !== false && (
            <a
              className={`nav-item ${path === '/local-delivery' ? 'selected' : ''}`}
              href="/local-delivery"
            >
              <Icon name="server" />
              Local delivery
            </a>
          )}
          {auth.cloudAvailable && auth.cloudConnected && (
            <a
              className={`nav-item ${path.startsWith('/cloud-sync') ? 'selected' : ''}`}
              href="/cloud-sync"
            >
              <Icon name="cloud" />
              Cloud sync
            </a>
          )}
          <a
            className={`nav-item ${path === '/settings' || path === '/profile' ? 'selected' : ''}`}
            href="/settings"
          >
            <Icon name="settings" />
            Settings
          </a>
          <a className="nav-item" href="/exam">
            <Icon name="user" />
            Candidate access
          </a>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-account">
            <a
              className="account-button"
              href="/settings"
              aria-label="Open account settings"
              title={auth.name ?? 'Account settings'}
            >
              <span className="avatar" aria-hidden="true">
                {(auth.name ?? 'MUDU')
                  .trim()
                  .split(/\s+/)
                  .filter((_, index, words) => index === 0 || index === words.length - 1)
                  .map((word) => word[0])
                  .join('')
                  .slice(0, 2)
                  .toUpperCase()}
              </span>
              <span className="sidebar-account-details">
                <strong>{auth.name ?? 'Your account'}</strong>
                <small>Administrator</small>
              </span>
              <Icon name="settings" size={16} />
            </a>
            <div className="sidebar-connection">
              <span
                className={`sidebar-connection-status ${auth.connection?.state === 'offline' ? 'offline' : auth.cloudSignedIn ? 'online' : 'local'}`}
                role="status"
              >
                <span className="status-dot" aria-hidden="true" />
                {auth.connection?.state === 'offline'
                  ? 'Offline'
                  : auth.cloudSignedIn
                    ? 'Online'
                    : auth.cloudConnected
                      ? 'Sign-in needed'
                      : 'Local workspace'}
              </span>
              {auth.deviceAccessEnabled && auth.deviceAccessAvailable && (
                auth.connection?.needsOnlineSignIn ? (
                  <a className="sidebar-connection-action" href="/settings#offline-access">
                    Sign in online
                  </a>
                ) : (
                  <button
                    type="button"
                    className="sidebar-connection-action"
                    disabled={modeBusy}
                    aria-busy={modeBusy}
                    title={
                      auth.connection?.state === 'offline'
                        ? 'Reconnect using your existing account session'
                        : 'Keep working in this workspace without online services'
                    }
                    onClick={() => {
                      void changeMode(
                        auth.connection?.state === 'offline' ? 'auto' : 'offline',
                      ).catch(() => {});
                    }}
                  >
                    {modeBusy
                      ? 'Updating…'
                      : auth.connection?.state === 'offline'
                        ? auth.connection?.mode === 'offline'
                          ? 'Go online'
                          : 'Retry connection'
                        : 'Work offline'}
                  </button>
                )
              )}
            </div>
          </div>
        </div>
      </aside>
      <div className="workspace-main">
        <header className="topbar">
          <span>
            <a href="/">Workspace</a>
            <span className="slash">/</span>
            {path === '/settings' ? (
              'Settings'
            ) : path === '/profile' ? (
              <>
                <a href="/settings">Settings</a>
                <span className="slash">/</span>
                Profile
              </>
            ) : path === '/' ? (
              'Assessments'
            ) : path.startsWith('/question-bank') ? (
              'Question bank'
            ) : path.startsWith('/cloud-sync') ? (
              'Cloud sync'
            ) : path === '/local-delivery' ? (
              'Local delivery'
            ) : path.startsWith('/rosters') ? (
              'Rosters'
            ) : path.startsWith('/assessments/') ? (
              <>
                <a href="/">Assessments</a>
                <span className="slash">/</span>
                {editId
                  ? 'Edit assessment'
                  : path === '/assessments/new'
                    ? 'Create'
                    : ({
                        results: 'Results',
                        questions: 'Questions',
                        activity: 'Activity',
                      }[new URLSearchParams(location.search).get('tab') ?? ''] ?? 'Overview')}
              </>
            ) : (
              'Workspace'
            )}
          </span>
          <div className="actions">
            <Notifications showBadge={auth.preferences?.notificationBadge} />
            {auth.cloudConnected && (
              <span
                className={`connection-indicator ${auth.connection?.state === 'offline' ? 'offline' : ''}`}
                role="status"
              >
                <span className="status-dot" />
                {auth.connection?.state === 'offline'
                  ? 'Offline'
                  : auth.cloudSignedIn
                    ? 'Online'
                    : 'Local access'}
              </span>
            )}
          </div>
        </header>
        <main className="content">
          {path === '/' && (
            <Suspense fallback={null}>
              <DeviceAccess
                auth={auth}
                onChanged={refresh}
                onConfigured={() =>
                  setFeedback('Offline access enabled. You can manage it in Settings.')
                }
              />
            </Suspense>
          )}
          {error && <Notice>{error}</Notice>}
          {feedback && (
            <div className="workspace-feedback" role="status">
              <span>{feedback}</span>
              <button
                type="button"
                className="text-button"
                aria-label="Dismiss status message"
                onClick={() => setFeedback('')}
              >
                Dismiss
              </button>
            </div>
          )}
          {auth.cloudAvailable && auth.hostOperator && !auth.cloudConnected && (
            <ConnectWorkspace
              name={auth.name ?? ''}
              ownerId={auth.adminId ?? ''}
              onConnected={refresh}
            />
          )}
          {auth.cloudAvailable && auth.cloudConnected && path.startsWith('/question-bank') && (
            <BankCloudStatus />
          )}
          {path === '/settings' || path === '/profile' ? (
            <Suspense fallback={<Loading />}>
              {path === '/settings' ? (
                <SettingsPage
                  auth={auth}
                  onChanged={refresh}
                  onLogout={logout}
                  onModeChange={changeMode}
                />
              ) : (
                <ProfilePage auth={auth} onChanged={refresh} onLogout={logout} />
              )}
            </Suspense>
          ) : path === '/cloud-sync' || /^\/cloud-sync\/records\/[a-f0-9-]{36}$/.test(path) ? (
            <CloudSyncPage recordId={path.split('/')[3]} />
          ) : path === '/question-bank' ? (
            <QuestionBankHome />
          ) : /^\/question-bank\/projects\/[a-f0-9-]{36}$/.test(path) ? (
            <QuestionBankPage key={path} id={path.split('/')[3]} />
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
            <Suspense fallback={<Loading />}>
              <CreateAssessment />
            </Suspense>
          ) : id ? (
            <Detail id={id} />
          ) : path === '/' ? (
            <Dashboard
              name={auth.name ?? 'there'}
              online={Boolean(auth.onlineAvailable && auth.cloudSignedIn)}
            />
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
