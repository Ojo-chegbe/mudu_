import { Suspense, lazy, useEffect, useState } from 'react';
import { AcceptEnrolment } from './enrolment.tsx';
import { Notifications } from './notifications.tsx';
import { CandidateRosters, RosterJoin, RosterMemberPage } from './rosters.tsx';
import type { FormEvent } from 'react';
import type { AuthState } from '../../packages/contracts/http.ts';
import type {
  CandidateProfile,
  ExamRegistration,
  Invitation,
} from '../../packages/contracts/registration.ts';
import { api, errorMessage, setCsrf } from './api.ts';
import { Brand, Icon, Loading, Notice, PasswordInput } from './ui.tsx';
import { Candidate } from './candidate.tsx';
import { CandidateCloudConnection } from './candidate-cloud-connection.tsx';
import { CandidateLocalPasses, LocalPassSignIn } from './local-preparation.tsx';
const SettingsPage = lazy(() =>
  import('./account-pages.tsx').then((module) => ({ default: module.SettingsPage })),
);
const ProfilePage = lazy(() =>
  import('./account-pages.tsx').then((module) => ({ default: module.ProfilePage })),
);

export function CandidatePortal({
  auth,
  onLogin,
  onLogout,
}: {
  auth: AuthState;
  onLogin: () => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const enrolToken = location.pathname.match(/^\/join\/enrol\/([A-Za-z0-9_-]+)$/)?.[1];
  const linkToken = location.pathname.match(/^\/join\/([A-Za-z0-9_-]+)$/)?.[1];
  const rosterToken = location.pathname.match(/^\/join\/roster\/([A-Za-z0-9_-]+)$/)?.[1];
  const onlineExam = location.pathname.startsWith('/exam/online/');
  const assessmentId = location.pathname.match(
    /^\/exam\/(?:assessments|online)\/([a-f0-9-]+)$/,
  )?.[1];
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [profile, setProfile] = useState<CandidateProfile | null>(null);
  const [exams, setExams] = useState<ExamRegistration[] | null>(null);
  const [signUp, setSignUp] = useState(false);
  const [hostLogin, setHostLogin] = useState(false);
  // A local Host must not acquire an internet dependency merely because its
  // administrator configured cloud sync. Connected sign-in is opt-in locally.
  const [cloudSignIn, setCloudSignIn] = useState(
    onlineExam ||
      (Boolean(auth.candidateCloudAvailable) &&
        new URLSearchParams(location.search).get('mode') === 'connected') ||
      (Boolean(auth.candidateCloudAvailable) &&
        location.protocol === 'https:' &&
        !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)),
  );
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const hasAccount = auth.role === 'candidate' && Boolean(auth.accountId);
  const accountPage = ['/exam/profile', '/exam/settings'].includes(location.pathname);
  const candidateName = profile?.name ?? auth.name ?? 'My account';
  const candidateInitial = candidateName.trim().charAt(0).toUpperCase() || 'C';
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        if (linkToken) {
          const result = await api<Invitation>(`/registration/${linkToken}`);
          if (alive) setInvitation(result);
        }
        if (hasAccount) {
          const [person, result] = await Promise.all([
            api<CandidateProfile>('/candidate/me'),
            api<{ examinations: ExamRegistration[] }>('/candidate/examinations'),
          ]);
          if (alive) {
            setProfile(person);
            setExams(result.examinations);
            if (auth.onlineAvailable && auth.candidateCloudSignedIn) {
              const online = await api<{ examinations: ExamRegistration[] }>(
                '/online/candidate/examinations',
              );
              const publishedIds = new Set(online.examinations.map((exam) => exam.assessmentId));
              if (alive)
                setExams([
                  ...result.examinations.filter((exam) => !publishedIds.has(exam.assessmentId)),
                  ...online.examinations,
                ]);
            }
          }
        }
        if (alive) setError('');
      } catch (error) {
        if (alive) setError(errorMessage(error));
      }
    }
    void load();
    const timer = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [hasAccount, auth.accountId, linkToken, auth.onlineAvailable, auth.candidateCloudSignedIn]);
  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const result = await api<{ csrf?: string; pending?: boolean; message?: string }>(
        `/candidate/${cloudSignIn ? 'cloud' : 'account'}/${signUp ? 'signup' : 'login'}`,
        {
          method: 'POST',
          body: cloudSignIn ? { ...values, email: values.email ?? values.login } : values,
        },
      );
      if (result.pending) {
        setConfirmation(
          result.message ?? 'Check your email to confirm your account, then sign in.',
        );
        setSignUp(false);
        return;
      }
      if (!result.csrf) throw new Error('Sign-in was not completed. Please try again.');
      setCsrf(result.csrf);
      if (signUp && linkToken && invitation?.accepting) {
        await api(`/registration/${linkToken}`, { method: 'POST', body: {} });
      }
      await onLogin();
    } catch (error) {
      setError(errorMessage(error));
      // A valid account can exist even if registration closed during signup.
      const current = await api<AuthState>('/auth').catch(() => null);
      if (current?.accountId) {
        setCsrf(current.csrf);
        await onLogin();
      }
    } finally {
      setBusy(false);
    }
  }
  async function register() {
    if (!linkToken) return;
    setBusy(true);
    setError('');
    try {
      await api(`/registration/${linkToken}`, { method: 'POST', body: {} });
      setInvitation(await api<Invitation>(`/registration/${linkToken}`));
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  if (enrolToken && hasAccount) return <AcceptEnrolment token={enrolToken} />;
  if (rosterToken && hasAccount) return <RosterMemberPage token={rosterToken} />;
  if (onlineExam && hasAccount && !auth.candidateCloudSignedIn)
    return (
      <main className="candidate-login">
        <h1>Sign in to take your online examination</h1>
        <p>
          Your current session is for this local Host. Use your cloud account for online access.
        </p>
        <button className="button primary" onClick={onLogout}>
          Continue to sign-in
        </button>
      </main>
    );
  if (assessmentId && hasAccount)
    return (
      <Candidate
        key={assessmentId}
        assessmentId={assessmentId}
        auth={auth}
        onLogin={onLogin}
        onLogout={onLogout}
      />
    );
  const statusLabel = (exam: ExamRegistration) =>
    exam.registrationStatus === 'pending'
      ? 'Awaiting approval'
      : exam.registrationStatus === 'rejected'
        ? 'Registration declined'
        : {
            upcoming: 'Registered · Upcoming',
            available: 'Available now',
            active: 'In progress',
            submitted: 'Submitted',
            expired: 'Time completed',
            ended: 'Examination ended',
          }[exam.examStatus];
  const filtered =
    exams?.filter(
      (exam) =>
        filter === 'all' ||
        (filter === 'pending'
          ? exam.registrationStatus === 'pending'
          : filter === 'completed'
            ? ['submitted', 'expired', 'ended'].includes(exam.examStatus)
            : ['available', 'active', 'upcoming'].includes(exam.examStatus) &&
              exam.registrationStatus === 'approved'),
    ) ?? [];
  return (
    <div className="candidate-app">
      <header className="candidate-header candidate-portal-header">
        <Brand />
        <nav className="candidate-primary-nav" aria-label="Candidate navigation">
          <a
            href="/exam"
            className={location.pathname === '/exam' ? 'active' : ''}
            aria-current={location.pathname === '/exam' ? 'page' : undefined}
          >
            <Icon name="paper" size={17} />
            My examinations
          </a>
        </nav>
        {hasAccount && (
          <div className="candidate-header-tools">
            {!auth.offlineAdmission ? (
              <>
                <Notifications showBadge={auth.preferences?.notificationBadge} />
                <details className={`candidate-account-menu${accountPage ? ' current' : ''}`}>
                  <summary aria-label={`Account menu for ${candidateName}`}>
                    <span className="candidate-account-avatar" aria-hidden="true">
                      {candidateInitial}
                    </span>
                    <span className="candidate-account-name">{candidateName}</span>
                    <Icon name="chevron" size={15} />
                  </summary>
                  <div className="candidate-account-dropdown">
                    <div className="candidate-account-heading">
                      <strong>{candidateName}</strong>
                      <span>Candidate account</span>
                    </div>
                    <a
                      href="/exam/profile"
                      aria-current={location.pathname === '/exam/profile' ? 'page' : undefined}
                    >
                      <Icon name="user" size={16} />
                      Profile
                    </a>
                    <a
                      href="/exam/settings"
                      aria-current={location.pathname === '/exam/settings' ? 'page' : undefined}
                    >
                      <Icon name="settings" size={16} />
                      Settings
                    </a>
                    <button type="button" onClick={onLogout}>
                      <Icon name="logout" size={16} />
                      Sign out
                    </button>
                  </div>
                </details>
              </>
            ) : (
              <button className="candidate-signout" type="button" onClick={onLogout}>
                <Icon name="logout" size={16} />
                Sign out
              </button>
            )}
          </div>
        )}
      </header>
      <main className={hasAccount && !linkToken ? 'candidate-dashboard' : 'registration-layout'}>
        {hasAccount && ['/exam/settings', '/exam/profile'].includes(location.pathname) ? (
          <Suspense fallback={<Loading />}>
            {location.pathname === '/exam/settings' ? (
              <SettingsPage auth={auth} onChanged={onLogin} onLogout={onLogout} />
            ) : (
              <ProfilePage auth={auth} onChanged={onLogin} onLogout={onLogout} />
            )}
          </Suspense>
        ) : (
          <>
            {rosterToken && <RosterJoin token={rosterToken} signedIn={false} />}
            {enrolToken && !hasAccount && (
              <Notice kind="info">
                You have a personal group invitation. Sign in or create an account using the email
                address your organiser invited.
              </Notice>
            )}
            {linkToken && (
              <section className="registration-overview">
                {invitation ? (
                  <>
                    <span className="eyebrow">EXAMINATION REGISTRATION</span>
                    <h1>{invitation.title}</h1>
                    <p className="muted">
                      {invitation.organization} · {invitation.course}
                    </p>
                    <div className="instruction-meta">
                      <span>
                        <Icon name="clock" size={18} />
                        {invitation.durationMinutes} minutes
                      </span>
                      <span>
                        <Icon name="paper" size={18} />
                        {invitation.questionCount} questions
                      </span>
                    </div>
                    <div className="panel padded">
                      <h3>
                        {invitation.accepting ? 'Registration is open' : 'Registration is closed'}
                      </h3>
                      <p className="muted small">
                        {invitation.closesAt
                          ? `Registration closes ${new Date(invitation.closesAt).toLocaleString()}.`
                          : 'The assessment organiser controls when registration closes.'}
                      </p>
                      <p className="muted small">
                        {invitation.policy === 'roster'
                          ? 'This examination is restricted to candidates assigned by the organiser.'
                          : 'The assessment organiser reviews registrations before admitting candidates.'}
                      </p>
                      {!invitation.accepting && (
                        <p className="small">
                          Already registered? Sign in to access your examination.
                        </p>
                      )}
                    </div>
                  </>
                ) : error ? (
                  <Notice>{error}</Notice>
                ) : (
                  <Loading />
                )}
              </section>
            )}
            {!onlineExam && !hasAccount && auth.offlineAdmissionAvailable && !hostLogin ? (
              <div>
                <LocalPassSignIn onLogin={onLogin} />
                {auth.identityMode !== 'replica' && (
                  <button className="text-button" onClick={() => setHostLogin(true)}>
                    Use this Host’s account instead
                  </button>
                )}
              </div>
            ) : !hasAccount && auth.identityMode === 'replica' ? (
              <section className="portal-auth panel padded">
                <span className="eyebrow">EXAMINATION HOST</span>
                <h1>Use your existing MUDU identity.</h1>
                <p className="muted">
                  This Host does not create a separate account or accept your main account password.
                </p>
                <Notice kind="info">
                  No local examination has been prepared here yet. Ask the invigilator to prepare
                  the assessment before connecting candidates.
                </Notice>
              </section>
            ) : !hasAccount ? (
              <section className="portal-auth panel padded">
                <span className="eyebrow">YOUR MUDU ACCOUNT</span>
                <h1>{signUp ? 'Create your account.' : 'Welcome back.'}</h1>
                <p className="muted small">
                  {signUp
                    ? 'Create one account and keep it for future examinations.'
                    : 'Sign in to see the examinations you’re registered for.'}
                </p>
                {confirmation && <Notice kind="info">{confirmation}</Notice>}
                {auth.candidateCloudAvailable && !cloudSignIn && (
                  <p className="field-hint">
                    Use the account you already have on this Host. Your local enrolments stay here.
                  </p>
                )}
                {auth.role === 'admin' && (
                  <Notice kind="info">
                    Candidate sign-in replaces your administrator session in this browser. Use a
                    separate browser profile to keep both open.
                  </Notice>
                )}
                <form onSubmit={authenticate}>
                  {signUp ? (
                    <>
                      <label>
                        Full name
                        <input name="name" required maxLength={160} autoComplete="name" />
                      </label>
                      <label>
                        Email address
                        <input
                          name="email"
                          type="email"
                          required
                          maxLength={254}
                          autoComplete="email"
                        />
                      </label>
                      <p className="field-hint">
                        Use the same email and password for future assessments. Your organiser
                        assigns student numbers; application references are generated automatically.
                      </p>
                    </>
                  ) : (
                    <label>
                      Email address
                      <input
                        name="login"
                        type="email"
                        required
                        maxLength={254}
                        autoComplete="username"
                        placeholder="Your email address"
                      />
                    </label>
                  )}
                  <label>
                    Password
                    <PasswordInput
                      key={signUp ? 'signup' : 'signin'}
                      name="password"
                      required
                      minLength={signUp ? 8 : 1}
                      maxLength={128}
                      autoComplete={signUp ? 'new-password' : 'current-password'}
                      placeholder={signUp ? 'At least 8 characters' : 'Your password'}
                    />
                  </label>
                  {error && <Notice>{error}</Notice>}
                  <button className="button primary full" disabled={busy}>
                    {busy
                      ? 'Please wait…'
                      : signUp
                        ? linkToken && invitation?.accepting
                          ? 'Create account & request registration'
                          : 'Create account'
                        : 'Sign in'}
                    <Icon name="arrow" size={16} />
                  </button>
                </form>
                <p className="auth-switch muted small">
                  {signUp ? 'Already have an account?' : 'New to MUDU?'}{' '}
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => {
                      setSignUp(!signUp);
                      setError('');
                    }}
                  >
                    {signUp ? 'Sign in' : 'Create an account'}
                  </button>
                </p>
                {auth.candidateCloudAvailable && (
                  <p className="auth-switch muted small">
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        setCloudSignIn(!cloudSignIn);
                        setSignUp(false);
                        setError('');
                        setConfirmation('');
                      }}
                    >
                      {cloudSignIn
                        ? 'Use my existing account on this Host'
                        : 'Use connected sign-in'}
                    </button>
                  </p>
                )}
                {!linkToken && (
                  <p className="muted small">
                    Received a one-off exam key? <a href="/exam/legacy">Use an invitation key</a>
                  </p>
                )}
                {!signUp && (
                  <p className="auth-switch muted small">
                    <a
                      href={`/account/forgot-password?role=candidate${cloudSignIn ? '' : '&local=1'}`}
                    >
                      Forgot your password?
                    </a>
                  </p>
                )}
              </section>
            ) : linkToken ? (
              <section className="panel padded registration-action">
                <span className="eyebrow">SIGNED IN AS</span>
                <h2>{profile?.name ?? auth.name}</h2>
                <p className="muted small">{profile?.email}</p>
                {error && <Notice>{error}</Notice>}
                {invitation?.registration ? (
                  <>
                    <div className="registration-status">
                      <Icon
                        name={invitation.registration.status === 'approved' ? 'check' : 'clock'}
                        size={24}
                      />
                      <h2>
                        {invitation.registration.status === 'approved'
                          ? 'You’re registered.'
                          : invitation.registration.status === 'pending'
                            ? 'Your request is awaiting approval.'
                            : 'Registration was declined.'}
                      </h2>
                      <p className="muted small">
                        {invitation.registration.status === 'pending'
                          ? 'You do not need to apply again. Your status will update after review.'
                          : invitation.registration.status === 'approved'
                            ? 'This examination is attached to your MUDU account.'
                            : 'Contact the assessment organiser if you believe this is a mistake.'}
                      </p>
                    </div>
                    <a href="/exam" className="button primary">
                      My examinations
                      <Icon name="arrow" size={16} />
                    </a>
                  </>
                ) : (
                  invitation && (
                    <>
                      <p className="muted">
                        Register using your existing account. You won’t need another password for
                        this examination.
                      </p>
                      <button
                        className="button primary"
                        disabled={busy || !invitation.accepting}
                        onClick={register}
                      >
                        {busy
                          ? 'Registering…'
                          : invitation.accepting
                            ? 'Register for this examination'
                            : 'Registration closed'}
                      </button>
                    </>
                  )
                )}
              </section>
            ) : (
              <>
                <div className="page-heading">
                  <div>
                    <span className="eyebrow">YOUR CANDIDATE WORKSPACE</span>
                    <h1>My examinations</h1>
                    <p className="muted">
                      Welcome, {profile?.name ?? auth.name}. Your assessments are all here.
                    </p>
                  </div>
                  <span className="candidate-identity">{profile?.email}</span>
                </div>
                {!auth.offlineAdmission && (
                  <CandidateCloudConnection
                    auth={auth}
                    email={profile?.email ?? ''}
                    onConnected={onLogin}
                  />
                )}
                {error && <Notice>{error}</Notice>}
                {!auth.offlineAdmission && <CandidateRosters />}
                {!auth.offlineAdmission && auth.candidateCloudSignedIn && <CandidateLocalPasses />}

                <div className="tabs">
                  {[
                    ['all', 'All examinations'],
                    ['upcoming', 'Upcoming & active'],
                    ['pending', 'Awaiting approval'],
                    ['completed', 'Completed'],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      className={`tab ${filter === value ? 'current' : ''}`}
                      aria-pressed={filter === value}
                      onClick={() => setFilter(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {!exams ? (
                  <Loading />
                ) : !filtered.length ? (
                  <div className="empty-state">
                    <div className="empty-icon">
                      <Icon name="paper" size={30} />
                    </div>
                    <h2>
                      {exams.length
                        ? 'No examinations in this view.'
                        : 'Your next examination will appear here.'}
                    </h2>
                    <p>
                      Open the registration link shared by the assessment organiser, or wait for an
                      assessment to be assigned to your account.
                    </p>
                  </div>
                ) : (
                  <div className="exam-cards">
                    {filtered.map((exam) => {
                      const available =
                        exam.registrationStatus === 'approved' &&
                        ['available', 'active', 'submitted', 'expired'].includes(exam.examStatus);
                      return (
                        <article key={exam.assessmentId} className="panel exam-card">
                          <div className="paper-icon">
                            <Icon name="paper" />
                          </div>
                          <div className="exam-card-content">
                            <span className="eyebrow">{exam.course}</span>
                            <h2>{exam.title}</h2>
                            <p className="muted small">
                              Application reference: {exam.applicationNumber}
                            </p>
                            <p className="muted small">
                              {exam.durationMinutes} minutes
                              {exam.timingMode === 'individual'
                                ? ' from when you begin'
                                : ''} · {exam.questionCount} questions
                            </p>
                            {exam.timingMode === 'individual' &&
                              exam.lastStartAt &&
                              ['upcoming', 'available'].includes(exam.examStatus) && (
                                <p className="field-hint">
                                  {exam.examStatus === 'upcoming' && exam.opensAt
                                    ? `Opens ${new Date(exam.opensAt).toLocaleString()}. `
                                    : ''}
                                  Start before {new Date(exam.lastStartAt).toLocaleString()}.
                                </p>
                              )}
                            <span className={`registration-label ${exam.registrationStatus}`}>
                              {statusLabel(exam)}
                            </span>
                          </div>
                          {available ? (
                            <a
                              className="button secondary"
                              href={`/exam/${exam.delivery === 'online' ? 'online' : 'assessments'}/${exam.assessmentId}`}
                            >
                              {exam.examStatus === 'active'
                                ? 'Resume'
                                : ['submitted', 'expired'].includes(exam.examStatus)
                                  ? 'View receipt'
                                  : 'Open examination'}
                              <Icon name="arrow" size={16} />
                            </a>
                          ) : (
                            <span className="muted small">
                              {exam.registrationStatus === 'rejected'
                                ? 'Contact the assessment organiser'
                                : exam.registrationStatus === 'pending'
                                  ? 'No action needed'
                                  : exam.examStatus === 'ended'
                                    ? 'Closed'
                                    : 'Not started yet'}
                            </span>
                          )}
                        </article>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </main>
      <footer className="candidate-footer">
        <Icon name="shield" size={14} />
        One MUDU identity · Online and local delivery
      </footer>
    </div>
  );
}
