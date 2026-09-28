import { useEffect, useState } from 'react';
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
  const assessmentId = location.pathname.match(/^\/exam\/assessments\/([a-f0-9-]+)$/)?.[1];
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [profile, setProfile] = useState<CandidateProfile | null>(null);
  const [exams, setExams] = useState<ExamRegistration[] | null>(null);
  const [signUp, setSignUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const hasAccount = auth.role === 'candidate' && Boolean(auth.accountId);
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
  }, [hasAccount, auth.accountId, linkToken]);
  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const result = await api<{ csrf: string }>(
        `/candidate/account/${signUp ? 'signup' : 'login'}`,
        { method: 'POST', body: values },
      );
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
      <header className="candidate-header">
        <Brand />
        <a href="/exam" className="candidate-header-label">
          My examinations
        </a>
        {hasAccount && (
          <div className="actions">
            <Notifications />
            <button className="text-button" onClick={onLogout}>
              Sign out
            </button>
          </div>
        )}
      </header>
      <main className={hasAccount && !linkToken ? 'candidate-dashboard' : 'registration-layout'}>
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
                    <p className="small">Already registered? Sign in to access your examination.</p>
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
        {!hasAccount && auth.identityMode === 'replica' ? (
          <section className="portal-auth panel padded">
            <span className="eyebrow">EXAMINATION HOST</span>
            <h1>Use your existing MUDU identity.</h1>
            <p className="muted">
              This Host does not create a separate account or accept your main account password.
            </p>
            <Notice kind="info">
              Prepared offline admission is not available in this development build. Ask your
              administrator to use the primary MUDU application for account-based examinations.
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
                    Use the same email and password for future assessments. Your organiser assigns
                    student numbers; application references are generated automatically.
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
                  minLength={signUp ? 15 : 1}
                  maxLength={128}
                  autoComplete={signUp ? 'new-password' : 'current-password'}
                  placeholder={
                    signUp ? 'A memorable phrase of at least 15 characters' : 'Your password'
                  }
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
                onClick={() => {
                  setSignUp(!signUp);
                  setError('');
                }}
              >
                {signUp ? 'Sign in' : 'Create an account'}
              </button>
            </p>
            {!linkToken && (
              <p className="muted small">
                Received a one-off exam key? <a href="/exam/legacy">Use an invitation key</a>
              </p>
            )}
            <p className="field-hint">
              Password recovery is not available in this development build. Keep your password safe.
            </p>
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
                    Register using your existing account. You won’t need another password for this
                    examination.
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
            {error && <Notice>{error}</Notice>}
            <CandidateRosters />

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
                          {exam.durationMinutes} minutes · {exam.questionCount} questions
                        </p>
                        <span className={`registration-label ${exam.registrationStatus}`}>
                          {statusLabel(exam)}
                        </span>
                      </div>
                      {available ? (
                        <a
                          className="button secondary"
                          href={`/exam/assessments/${exam.assessmentId}`}
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
      </main>
      <footer className="candidate-footer">
        <Icon name="shield" size={14} />
        One MUDU identity · Online and local delivery
      </footer>
    </div>
  );
}
