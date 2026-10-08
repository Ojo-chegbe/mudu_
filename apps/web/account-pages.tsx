import { useEffect, useRef, useState } from 'react';
import type { FormEvent, MouseEvent, ReactNode } from 'react';
import type {
  AccountPreferences,
  AccountProfile,
  AuthState,
} from '../../packages/contracts/http.ts';
import { api, errorMessage } from './api.ts';
import { Dialog, Icon, Loading, Notice, PasswordInput } from './ui.tsx';
import { DeviceAccess } from './device-access.tsx';
import { recoveryHref } from './password-recovery.tsx';

type PageProps = {
  auth: AuthState;
  onChanged: () => Promise<void>;
  onLogout: () => Promise<void>;
  onModeChange?: (mode: 'auto' | 'offline') => Promise<void>;
};
function AccountTabs({ candidate, page }: { candidate: boolean; page: 'profile' | 'settings' }) {
  const prefix = candidate ? '/exam' : '';
  const switchPage = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    event.preventDefault();
    const url = new URL(event.currentTarget.href);
    window.history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.scrollTo(0, 0);
  };

  return (
    <nav className="account-tabs" aria-label="Account pages">
      <a
        href={`${prefix}/settings`}
        className={page === 'settings' ? 'selected' : ''}
        aria-current={page === 'settings' ? 'page' : undefined}
        onClick={switchPage}
      >
        Settings
      </a>
      <a
        href={`${prefix}/profile`}
        className={page === 'profile' ? 'selected' : ''}
        aria-current={page === 'profile' ? 'page' : undefined}
        onClick={switchPage}
      >
        Profile
      </a>
    </nav>
  );
}
function Card({
  title,
  description,
  children,
  id,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className="account-card" id={id}>
      <div className="account-card-heading">
        <h2>{title}</h2>
        {description && <p className="muted">{description}</p>}
      </div>
      {children}
    </section>
  );
}
function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}
export function ProfilePage({ auth, onChanged, onLogout }: PageProps) {
  const [profile, setProfile] = useState<AccountProfile | null>(null),
    [name, setName] = useState('');
  const [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false),
    [password, setPassword] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const candidate = auth.role === 'candidate';
  useEffect(() => {
    let active = true;
    void api<AccountProfile>('/account/profile')
      .then((value) => {
        if (active) {
          setProfile(value);
          setName(value.name);
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, []);
  const dirty = Boolean(profile && name !== profile.name);
  const canEdit = Boolean(
    profile?.canEditName &&
    (!profile.connected || auth.cloudSignedIn || auth.candidateCloudSignedIn),
  );
  useUnsavedChanges(dirty);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const value = await api<AccountProfile>('/account/profile', {
        method: 'POST',
        body: { name },
      });
      setProfile(value);
      setName(value.name);
      await onChanged();
      setMessage('Your profile has been saved.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function revoke(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api('/account/sessions', { method: 'POST', body: { password } });
      setPassword('');
      setSessionsOpen(false);
      setMessage('Other sessions for your account on this Host have been signed out.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="account-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR MUDU ACCOUNT</span>
          <h1>Profile</h1>
          <p className="muted">Your identity, your account, your workspace.</p>
        </div>
      </div>
      <AccountTabs candidate={candidate} page="profile" />
      {error && !sessionsOpen && <Notice>{error}</Notice>}
      {message && <Notice kind="info">{message}</Notice>}
      {!profile ? (
        !error && <Loading />
      ) : (
        <>
          <section className="profile-summary">
            <span className="profile-avatar" aria-hidden="true">
              {profile.name[0]?.toUpperCase()}
            </span>
            <div>
              <h2>{profile.name}</h2>
              <p>{profile.email ?? 'Existing Host account'}</p>
              <span className="account-tag">
                {candidate
                  ? 'Candidate'
                  : profile.hostOperator
                    ? 'Administrator · Host operator'
                    : 'Administrator'}
              </span>
            </div>
          </section>
          <div className="account-columns">
            <Card
              title="Personal details"
              description="The name associated with your MUDU account."
            >
              <form className="account-form" onSubmit={save}>
                <label>
                  Full name
                  <input
                    autoComplete="name"
                    required
                    maxLength={100}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={busy || !canEdit}
                  />
                </label>
                <label>
                  Email address
                  <input
                    type="text"
                    readOnly
                    value={profile.email ?? 'No online email connected'}
                  />
                </label>
                <p className="field-hint">
                  Your email identifies your account. Changing a name does not change account
                  ownership or examination records.
                </p>
                {!canEdit && (
                  <p className="field-hint">Reconnect online to edit a connected profile.</p>
                )}
                <div className="actions">
                  <button
                    className="button primary"
                    disabled={busy || !dirty || !name.trim() || !canEdit}
                    data-disabled-reason={
                      busy
                        ? 'Please wait while your profile is being saved.'
                        : !canEdit
                          ? 'Reconnect online to edit a connected profile.'
                          : !name.trim()
                            ? 'Enter your name before saving.'
                            : !dirty
                              ? 'There are no profile changes to save.'
                              : undefined
                    }
                  >
                    {busy ? 'Saving…' : 'Save profile'}
                  </button>
                  {dirty && (
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy}
                      onClick={() => setName(profile.name)}
                    >
                      Discard changes
                    </button>
                  )}
                </div>
              </form>
            </Card>
            <Card
              title="Account security"
              description="Keep access to your account under your control."
            >
              <div className="account-detail">
                <span>Email verification</span>
                <strong>
                  {profile.emailVerified
                    ? 'Verified'
                    : profile.connected
                      ? 'Confirmation required'
                      : 'Online account not connected'}
                </strong>
              </div>
              <p className="field-hint">
                Confirmed email ownership does not expire. Sign-in sessions are separate and can be
                renewed or revoked to protect your account.
              </p>
              <div className="account-link-row">
                <div>
                  <strong>Password recovery</strong>
                  <p>Recover your connected account without losing saved work.</p>
                </div>
                <a
                  className="button secondary"
                  href={recoveryHref(candidate ? 'candidate' : 'admin', !profile.connected)}
                >
                  Reset password
                </a>
              </div>
              <div className="account-link-row">
                <div>
                  <strong>Other Host sessions</strong>
                  <p>
                    This affects your account on this Host. It does not sign out other computers.
                  </p>
                </div>
                <button
                  className="button secondary"
                  disabled={
                    busy ||
                    Boolean(
                      profile.connected && !auth.cloudSignedIn && !auth.candidateCloudSignedIn,
                    )
                  }
                  onClick={() => {
                    setError('');
                    setSessionsOpen(true);
                  }}
                >
                  Sign out other sessions
                </button>
              </div>
              <a className="text-button" href={candidate ? '/exam/settings' : '/settings'}>
                {candidate
                  ? 'Manage your display and notification preferences'
                  : 'Manage trusted offline access and preferences'}{' '}
                <Icon name="arrow" size={14} />
              </a>
            </Card>
            {profile.candidate && (
              <Card
                title="Examination identity"
                description="These details are managed through your examination organiser."
              >
                <div className="account-detail">
                  <span>Candidate number</span>
                  <strong>{profile.candidate.identifier}</strong>
                </div>
                <div className="account-detail">
                  <span>Organisation</span>
                  <strong>{profile.candidate.organization}</strong>
                </div>
                <div className="account-detail">
                  <span>Candidate-number verification</span>
                  <strong>
                    {profile.candidate.identityStatus === 'verified'
                      ? 'Verified by organiser'
                      : 'Awaiting organiser verification'}
                  </strong>
                </div>
                <p className="field-hint">
                  Email verification and candidate-number verification are separate. Contact your
                  organiser to correct examination identity details.
                </p>
              </Card>
            )}
            <Card
              title="Your workspace"
              description="One account, with records kept separate from other users."
            >
              <p>
                {candidate
                  ? 'Your registrations, saved answers and results stay attached to your existing account.'
                  : 'Your assessments, rosters, questions and results stay attached to this workspace.'}
              </p>
              <p className="field-hint">
                Signing out keeps saved records. Unsynchronized work remains on its original Host.
              </p>
              <button
                type="button"
                className="button secondary"
                disabled={busy || dirty}
                onClick={onLogout}
              >
                Sign out of this session
              </button>
            </Card>
          </div>
        </>
      )}
      {sessionsOpen && (
        <Dialog
          title="Sign out other Host sessions"
          confirmLabel="Sign out other sessions"
          onClose={() => {
            setSessionsOpen(false);
            setPassword('');
            setError('');
          }}
          busy={busy}
          confirm={() => form.current?.requestSubmit()}
        >
          <p>
            Your current session stays open. Other sessions for this account on this Host will lose
            access. Saved records are kept.
          </p>
          <form ref={form} className="account-form" onSubmit={revoke}>
            <label>
              Account password
              <PasswordInput
                secretLabel="Account password"
                required
                autoComplete="current-password"
                maxLength={128}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
              />
            </label>
            {error && <Notice>{error}</Notice>}
            <button type="submit" className="sr-only" tabIndex={-1}>
              Confirm
            </button>
          </form>
        </Dialog>
      )}
    </div>
  );
}

type Diagnostics = {
  generatedAt: string;
  version: string;
  schema: number;
  features: Record<string, boolean>;
};
export function SettingsPage({ auth, onChanged, onLogout, onModeChange }: PageProps) {
  const candidate = auth.role === 'candidate';
  const routeSection = location.pathname.split('/')[2];
  const sections: Record<string, string> = {
    access: 'settings-access',
    preferences: 'settings-preferences',
    workspace: 'settings-workspace',
    time: 'settings-time',
    support: 'settings-support',
    account: 'settings-account',
  };
  const defaultSection = candidate ? 'settings-preferences' : 'settings-access';
  const requestedSection = sections[routeSection ?? ''];
  const [activeSection, setActiveSection] = useState(
    requestedSection && (!candidate || requestedSection !== 'settings-access')
      ? requestedSection
      : defaultSection,
  );
  function navigateSection(event: MouseEvent<HTMLAnchorElement>, section: string) {
    event.preventDefault();
    const destination = `/settings/${section.replace('settings-', '')}`;
    if (location.pathname !== destination) history.pushState(null, '', destination);
    setActiveSection(section);
    window.scrollTo(0, 0);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  const initial: AccountPreferences = auth.preferences ?? {
    textSize: 'normal',
    reducedMotion: 'system',
    notificationBadge: true,
  };
  const [draft, setDraft] = useState(initial),
    [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  useUnsavedChanges(dirty);
  useEffect(() => {
    let active = true;
    void api<Diagnostics>('/account/diagnostics')
      .then((value) => {
        if (active) setDiagnostics(value);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const updateSection = () => {
      const requested = sections[location.pathname.split('/')[2] ?? ''];
      setActiveSection(
        requested && (!candidate || requested !== 'settings-access') ? requested : defaultSection,
      );
    };
    window.addEventListener('popstate', updateSection);
    return () => window.removeEventListener('popstate', updateSection);
  }, [candidate]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const value = await api<AccountPreferences>('/account/preferences', {
        method: 'POST',
        body: draft,
      });
      setSaved(value);
      setDraft(value);
      await onChanged();
      setMessage('Preferences saved for your account on this Host.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function mode(value: 'auto' | 'offline') {
    if (busy || !onModeChange) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await onModeChange(value);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const offline = auth.connection?.state === 'offline';
  return (
    <div className="account-page">
      <div className="settings-sticky-header">
        <div className="page-heading">
          <div>
            <span className="eyebrow">MAKE MUDU WORK FOR YOU</span>
            <h1>Settings</h1>
            <p className="muted">
              {candidate
                ? 'Display, notifications and your account preferences.'
                : 'Connection, device access and your workspace preferences.'}
            </p>
          </div>
        </div>
        <AccountTabs candidate={candidate} page="settings" />
      </div>
      {error && <Notice>{error}</Notice>}
      {message && <Notice kind="info">{message}</Notice>}
      <div className="settings-shell">
        <nav className="settings-sidebar" aria-label="Settings sections">
          {!candidate && (
            <a
              className={activeSection === 'settings-access' ? 'active' : ''}
              aria-current={activeSection === 'settings-access' ? 'location' : undefined}
              href="/settings/access"
              onClick={(event) => navigateSection(event, 'settings-access')}
            >
              Access & connection
            </a>
          )}
          <a
            className={activeSection === 'settings-preferences' ? 'active' : ''}
            aria-current={activeSection === 'settings-preferences' ? 'location' : undefined}
            href="/settings/preferences"
            onClick={(event) => navigateSection(event, 'settings-preferences')}
          >
            Preferences
          </a>
          <a
            className={activeSection === 'settings-workspace' ? 'active' : ''}
            aria-current={activeSection === 'settings-workspace' ? 'location' : undefined}
            href="/settings/workspace"
            onClick={(event) => navigateSection(event, 'settings-workspace')}
          >
            Workspace
          </a>
          <a
            className={activeSection === 'settings-time' ? 'active' : ''}
            aria-current={activeSection === 'settings-time' ? 'location' : undefined}
            href="/settings/time"
            onClick={(event) => navigateSection(event, 'settings-time')}
          >
            Time & schedules
          </a>
          <a
            className={activeSection === 'settings-support' ? 'active' : ''}
            aria-current={activeSection === 'settings-support' ? 'location' : undefined}
            href="/settings/support"
            onClick={(event) => navigateSection(event, 'settings-support')}
          >
            Help & support
          </a>
          <a
            className={activeSection === 'settings-account' ? 'active' : ''}
            aria-current={activeSection === 'settings-account' ? 'location' : undefined}
            href="/settings/account"
            onClick={(event) => navigateSection(event, 'settings-account')}
          >
            Account
          </a>
        </nav>
        <div className="settings-content">
          {!candidate && activeSection === 'settings-access' && (
            <section className="settings-section" id="settings-access">
              <div className="settings-section-heading">
                <h2>Access & connection</h2>
                <p>Choose how this workspace connects and set up the Windows app.</p>
              </div>
              <div className="settings-card-grid">
                <Card
                  title="Connection"
                  description="Stay in your workspace when the connection changes."
                  id="connection"
                >
                  <div className="account-detail">
                    <span>Current status</span>
                    <strong role="status">
                      {offline
                        ? 'Working offline'
                        : auth.cloudSignedIn
                          ? 'Connected online'
                          : 'Saved on this Host'}
                    </strong>
                  </div>
                  {auth.deviceAccessAvailable && auth.cloudConnected && (
                    <div
                      className="connection-options"
                      role="group"
                      aria-label="Workspace connection mode"
                    >
                      <button
                        type="button"
                        className={`connection-option ${auth.connection?.mode !== 'offline' ? 'selected' : ''}`}
                        aria-pressed={auth.connection?.mode !== 'offline'}
                        disabled={busy}
                        onClick={() => mode('auto')}
                      >
                        <Icon name="server" />
                        <strong>Automatic</strong>
                        <span>
                          Use online services when available. Continue offline on this trusted Host
                          if the connection drops.
                        </span>
                      </button>
                      <button
                        type="button"
                        className={`connection-option ${auth.connection?.mode === 'offline' ? 'selected' : ''}`}
                        aria-pressed={auth.connection?.mode === 'offline'}
                        disabled={busy || !auth.deviceAccessEnabled}
                        onClick={() => mode('offline')}
                      >
                        <Icon name="shield" />
                        <strong>Work offline</strong>
                        <span>
                          Keep working with saved local records. Pause cloud synchronization until
                          you reconnect.
                        </span>
                      </button>
                    </div>
                  )}
                  {!auth.deviceAccessEnabled && auth.cloudConnected && (
                    <p className="field-hint">
                      Enable offline access below to allow automatic fallback and manual offline
                      mode.
                    </p>
                  )}
                  {auth.connection?.needsOnlineSignIn && (
                    <p className="field-hint">
                      This workspace was unlocked after sign-out.{' '}
                      <a href="/account/sign-in?return=/settings">Sign in online once</a> to restore
                      cloud access.
                    </p>
                  )}
                  <p className="field-hint">
                    Connection mode does not change an examination’s delivery method, deadline or
                    saved answers.
                  </p>
                </Card>
                {!candidate && auth.cloudConnected && (
                  <Card
                    title="Offline access"
                    description={
                      auth.deviceAccessAvailable
                        ? 'Authorize this computer for your existing account.'
                        : 'Set up the Windows app with your existing account.'
                    }
                    id="offline-access"
                  >
                    <DeviceAccess auth={auth} onChanged={onChanged} placement="settings" />
                  </Card>
                )}
                {!candidate && (auth.hostDownloadUrl || import.meta.env.DEV) && (
                  <Card title="MUDU Host" description="Your MUDU account, on Windows.">
                    <div className="host-download">
                      <a
                        className="button primary"
                        href={auth.hostDownloadUrl || '/downloads/mudu-host.exe'}
                      >
                        Download for Windows
                      </a>
                      <p className="muted">
                        Windows 10/11 · 64-bit. Sign in with your MUDU account and enable offline
                        access in the app. Only work saved on this computer is available offline.
                      </p>
                    </div>
                  </Card>
                )}
              </div>
            </section>
          )}
          {activeSection === 'settings-preferences' && (
            <section className="settings-section" id="settings-preferences">
              <div className="settings-section-heading">
                <h2>Preferences</h2>
                <p>Adjust how MUDU looks and keeps you informed.</p>
              </div>
              <Card
                title="Display and notifications"
                description="These preferences apply to your account on this Host."
                id="preferences"
              >
                <form className="account-form" onSubmit={save}>
                  <label>
                    Reading size
                    <select
                      aria-label="Reading size"
                      value={draft.textSize}
                      disabled={busy}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          textSize: e.target.value as AccountPreferences['textSize'],
                        })
                      }
                    >
                      <option value="normal">Standard</option>
                      <option value="large">Larger text</option>
                    </select>
                  </label>
                  <label>
                    Motion
                    <select
                      aria-label="Motion"
                      value={draft.reducedMotion}
                      disabled={busy}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          reducedMotion: e.target.value as AccountPreferences['reducedMotion'],
                        })
                      }
                    >
                      <option value="system">Follow device accessibility setting</option>
                      <option value="reduce">Reduce motion</option>
                    </select>
                  </label>
                  <label className="account-checkbox">
                    <input
                      type="checkbox"
                      checked={draft.notificationBadge}
                      disabled={busy}
                      onChange={(e) => setDraft({ ...draft, notificationBadge: e.target.checked })}
                    />
                    <span>Show the unread notification badge</span>
                  </label>
                  <p className="field-hint">
                    Notifications and examination announcements remain available when the badge is
                    hidden.
                  </p>
                  <div className="actions">
                    <button
                      className="button primary"
                      disabled={busy || !dirty}
                      data-disabled-reason={
                        busy
                          ? 'Please wait while your preferences are being saved.'
                          : !dirty
                            ? 'There are no preference changes to save.'
                            : undefined
                      }
                    >
                      {busy ? 'Saving…' : 'Save preferences'}
                    </button>
                    {dirty && (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy}
                        onClick={() => setDraft(saved)}
                      >
                        Discard changes
                      </button>
                    )}
                  </div>
                </form>
              </Card>
            </section>
          )}
          {activeSection === 'settings-workspace' && (
            <section className="settings-section" id="settings-workspace">
              <div className="settings-section-heading">
                <h2>Workspace</h2>
                <p>Cloud services, examination delivery and authoring tools.</p>
              </div>
              <div className="settings-card-grid">
                {!candidate ? (
                  <>
                    <Card
                      title="Cloud storage and synchronization"
                      description="Account connection and uploaded records are separate."
                    >
                      {[
                        'cloudAuthoring',
                        'cloudQuestionBank',
                        'cloudRosters',
                        'cloudResults',
                        'onlineDelivery',
                      ].map((key, index) => (
                        <div className="account-detail" key={key}>
                          <span>
                            {
                              [
                                'Assessment authoring',
                                'Question bank',
                                'Rosters',
                                'Completed examination records',
                                'Online delivery',
                              ][index]
                            }
                          </span>
                          <strong>
                            {!diagnostics
                              ? 'Checking…'
                              : diagnostics.features[key]
                                ? 'Configured'
                                : 'Setup required'}
                          </strong>
                        </div>
                      ))}
                      <p className="field-hint">
                        Each feature shows its actual save status on its own page. Completed
                        examinations upload only when selected. Sync conflicts require review.
                      </p>
                      {auth.cloudConnected ? (
                        <a className="button secondary" href="/cloud-sync">
                          Open Cloud sync <Icon name="arrow" size={14} />
                        </a>
                      ) : (
                        <a href="/">Connect your existing workspace</a>
                      )}
                    </Card>
                    <Card
                      title="Examination delivery"
                      description="Delivery settings belong to each examination."
                    >
                      <p>
                        Choose online delivery or prepare a local run from an assessment. Configure
                        timing, admission, question order and grading there.
                      </p>
                      <div className="actions">
                        <a className="button secondary" href="/">
                          Open assessments
                        </a>
                        {auth.hostOperator && (
                          <a className="button secondary" href="/local-delivery">
                            Manage local network
                          </a>
                        )}
                      </div>
                      {!auth.hostOperator && (
                        <p className="field-hint">
                          Local network controls belong to this computer’s Host operator.
                        </p>
                      )}
                      <p className="field-hint">
                        Prepare local examinations and candidate admission while online before
                        disconnected delivery.
                      </p>
                    </Card>
                  </>
                ) : (
                  <Card
                    title="Examinations and offline admission"
                    description="Your examination organiser controls admission and delivery."
                  >
                    <p>
                      Prepared admission files grant access to an existing account and examination.
                      They do not create another account or replace your account password.
                    </p>
                    <a className="button secondary" href="/exam">
                      My examinations <Icon name="arrow" size={14} />
                    </a>
                    <p className="field-hint">
                      Timers and saved-answer acknowledgements follow the examination server,
                      regardless of your device connection.
                    </p>
                  </Card>
                )}
                {!candidate && (
                  <Card
                    title="Question generation"
                    description="Create and review questions before adding them to an assessment."
                  >
                    <div className="account-detail">
                      <span>Generation service</span>
                      <strong>
                        {!diagnostics
                          ? 'Checking…'
                          : diagnostics.features.questionGeneration
                            ? 'Configured on this Host'
                            : 'Not configured on this Host'}
                      </strong>
                    </div>
                    <p className="field-hint">
                      Your Host operator manages the service configuration. Generation needs
                      internet access; manual authoring remains available. Generated questions
                      always require review.
                    </p>
                    <a className="button secondary" href="/question-bank">
                      Open question bank <Icon name="arrow" size={14} />
                    </a>
                  </Card>
                )}
              </div>
            </section>
          )}
          {activeSection === 'settings-time' && (
            <section className="settings-section" id="settings-time">
              <div className="settings-section-heading">
                <h2>Time & schedules</h2>
                <p>Dates follow this device; examination deadlines remain server controlled.</p>
              </div>
              <Card
                title="Time and schedules"
                description="Keep displayed dates clear without changing examination rules."
              >
                <div className="account-detail">
                  <span>Device time zone</span>
                  <strong>{Intl.DateTimeFormat().resolvedOptions().timeZone}</strong>
                </div>
                <div className="account-detail">
                  <span>Interface language</span>
                  <strong>English</strong>
                </div>
                <p className="field-hint">
                  Dates use this device?s time zone. Correct it in your device settings if needed.
                  Examination deadlines are enforced by the server and do not change when your
                  device clock or connection changes.
                </p>
              </Card>
            </section>
          )}
          {activeSection === 'settings-support' && (
            <section className="settings-section" id="settings-support">
              <div className="settings-section-heading">
                <h2>Help & support</h2>
                <p>Check your app version and download a private diagnostic report.</p>
              </div>
              <Card
                title="Saved data and support"
                description="Keep records separate from account and device settings."
              >
                {diagnostics && (
                  <div className="account-detail">
                    <span>MUDU version</span>
                    <strong>{diagnostics.version}</strong>
                  </div>
                )}
                <p>
                  {candidate
                    ? 'Saved answers and registrations remain attached to your account.'
                    : 'Saved work stays on this Host until its supported cloud synchronization completes. Export examination results from the relevant assessment.'}
                </p>
                <p className="field-hint">
                  Changing preferences, connection mode or device access does not delete records.
                  This diagnostic file contains capability and connection information, without
                  passwords, tokens, names, emails or examination content.
                </p>
                <a className="button secondary" href="/api/account/diagnostics" download>
                  Download diagnostics <Icon name="download" size={14} />
                </a>
              </Card>
            </section>
          )}
          {activeSection === 'settings-account' && (
            <section className="settings-section" id="settings-account">
              <div className="settings-section-heading">
                <h2>Account</h2>
                <p>Profile, security and sign-out.</p>
              </div>
              <Card title="Account and security">
                <p>
                  Review your verified email, account identity, password recovery and Host sessions
                  in Profile.
                </p>
                <div className="actions">
                  <a className="button secondary" href={candidate ? '/exam/profile' : '/profile'}>
                    Open Profile
                  </a>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy || dirty}
                    onClick={onLogout}
                  >
                    Sign out
                  </button>
                </div>
              </Card>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
