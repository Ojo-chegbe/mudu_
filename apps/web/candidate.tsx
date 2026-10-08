import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AuthState } from '../../packages/contracts/http.ts';
import type { Answer, CandidateView } from '../../packages/exam-core/model.ts';
import { CandidateAnnouncements } from './candidate-announcements.tsx';
import { api, ApiError, errorMessage } from './api.ts';
import { AnswerOutbox, browserQueueStorage } from './outbox.ts';
import { Brand, Icon, Loading, Notice, PasswordInput, formatTime } from './ui.tsx';
import { SubmissionReview } from './submission-review.tsx';

export function Candidate({
  auth,
  onLogin,
  onLogout,
  assessmentId,
}: {
  auth: AuthState;
  onLogin: () => Promise<void>;
  onLogout: () => Promise<void>;
  assessmentId?: string;
}) {
  const [state, setState] = useState<CandidateView | null>(null);
  const [error, setError] = useState('');
  const [deviceRecovery, setDeviceRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [index, setIndex] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [queueReady, setQueueReady] = useState(false);
  const [queueError, setQueueError] = useState('');
  const [draftAnswers, setDraftAnswers] = useState<Record<string, Answer>>({});
  const [confirm, setConfirm] = useState(false);
  const submitting = useRef(false);
  const questionHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!confirm) questionHeading.current?.focus();
  }, [confirm, index]);
  const [, redraw] = useState(0);
  const queue = useRef<AnswerOutbox | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const attemptId = state?.attempt?.id;
  const attemptStatus = state?.attempt?.status;
  const paused = state?.controls?.pausedAt != null;
  const authenticated =
    auth.role === 'candidate' && (assessmentId ? Boolean(auth.accountId) : !auth.accountId);
  const examApi = assessmentId ? `/candidate/examinations/${assessmentId}` : '/candidate';
  const unsavedCount =
    new Set([
      ...Object.keys(draftAnswers),
      ...(queue.current?.entries.map((entry) => entry.questionId) ?? []),
    ]).size || pendingCount;

  async function refresh() {
    try {
      const value = await api<CandidateView>(`${examApi}/state`);
      setState((previous) => {
        if (value.attempt && previous?.attempt?.id === value.attempt.id) {
          for (const [id, response] of Object.entries(previous.attempt.responses)) {
            if (response.revision > (value.attempt.responses[id]?.revision ?? 0))
              value.attempt.responses[id] = response;
          }
        }
        return value;
      });
      if (queue.current && value.attempt)
        for (const [id, response] of Object.entries(value.attempt.responses)) {
          if (!queue.current.entries.some((entry) => entry.questionId === id))
            queue.current.revisions[id] = Math.max(
              queue.current.revisions[id] ?? 0,
              response.revision,
            );
        }
      setError('');
      setDeviceRecovery(false);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ONLINE_DEVICE_CHANGED')
        setDeviceRecovery(true);
      setError(errorMessage(error));
    }
  }
  useEffect(() => {
    if (!authenticated) return;
    void refresh();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, [authenticated, examApi]);
  useEffect(() => {
    if (!authenticated || !state || (attemptStatus && attemptStatus !== 'active')) return;
    let stopped = false;
    let sending = false;
    const beat = async () => {
      if (stopped || sending) return;
      sending = true;
      try {
        const result = await api<{ ended: boolean }>(`${examApi}/heartbeat`, {
          method: 'POST',
          body: {},
          timeoutMs: 10000,
        });
        if (result.ended) stopped = true;
      } catch (error) {
        if (error instanceof ApiError && [401, 403].includes(error.status)) stopped = true;
        // Answer saving and state recovery display their own connection errors.
      } finally {
        sending = false;
      }
    };
    void beat();
    const timer = setInterval(() => void beat(), 15000);
    window.addEventListener('online', beat);
    window.addEventListener('focus', beat);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener('online', beat);
      window.removeEventListener('focus', beat);
    };
  }, [authenticated, examApi, state?.sitting.id, attemptStatus]);
  useEffect(() => {
    if (!state) return;
    const initial =
      (state.attempt?.deadline ?? state.sitting.deadline) -
      (state.controls?.pausedAt ?? state.serverNow);
    const at = performance.now();
    setRemaining(initial);
    if (state.controls?.pausedAt != null) return;
    const timer = setInterval(
      () => setRemaining(Math.max(0, initial - (performance.now() - at))),
      250,
    );
    return () => clearInterval(timer);
  }, [state?.serverNow, state?.controls?.pausedAt]);
  useEffect(() => {
    if (!attemptId || attemptStatus !== 'active') {
      setQueueReady(false);
      if (attemptId)
        void browserQueueStorage(attemptId)
          .load()
          .then((entries) => setPendingCount(entries.length))
          .catch(() => {});
      return;
    }
    let alive = true;
    const current = new AnswerOutbox({
      responses: stateRef.current!.attempt!.responses,
      storage: browserQueueStorage(attemptId),
      send: (entry) =>
        api(`${examApi}/answers/${entry.questionId}`, { method: 'PUT', body: entry }),
      changed: () => {
        if (!alive) return;
        setPendingCount(current.entries.length);
        redraw((n) => n + 1);
        if (current.error instanceof ApiError) setQueueError(current.error.message);
        else if (current.error)
          setQueueError(
            'Connection interrupted. Your pending answers are kept on this device. Keep this page open; MUDU will retry.',
          );
        else setQueueError('');
      },
      saved: (entry, revision) =>
        setState((previous) =>
          previous?.attempt
            ? {
                ...previous,
                attempt: {
                  ...previous.attempt,
                  responses: {
                    ...previous.attempt.responses,
                    [entry.questionId]: { value: entry.value, revision },
                  },
                },
              }
            : previous,
        ),
    });
    queue.current = current;
    void current
      .initialize()
      .then(() => {
        if (alive) {
          setQueueReady(true);
          void current.flush();
        }
      })
      .catch((error) => {
        if (alive)
          setQueueError(
            error instanceof Error ? error.message : 'Could not open pending answer storage.',
          );
      });
    const retry = () => {
      if (stateRef.current?.controls?.pausedAt != null) return;
      if (current.error instanceof ApiError && current.error.code === 'EXAM_PAUSED') {
        void current.flush();
        return;
      }
      if (!(current.error instanceof ApiError && [401, 403, 409].includes(current.error.status)))
        void current.flush();
    };
    const timer = setInterval(retry, 3000);
    window.addEventListener('online', retry);
    return () => {
      alive = false;
      current.dispose();
      clearInterval(timer);
      window.removeEventListener('online', retry);
      queue.current = null;
    };
  }, [attemptId, attemptStatus]);
  useEffect(() => {
    if (!unsavedCount) return;
    const prevent = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [unsavedCount]);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/candidate/login', {
        method: 'POST',
        body: Object.fromEntries(new FormData(event.currentTarget)),
      });
      await onLogin();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function start() {
    setBusy(true);
    setError('');
    try {
      setState(await api<CandidateView>(`${examApi}/start`, { method: 'POST', body: {} }));
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function choose(questionId: string, value: Answer) {
    setDraftAnswers((previous) => ({ ...previous, [questionId]: value }));
    try {
      if (!queue.current) throw new Error('Answer storage unavailable');
      await queue.current.choose(questionId, value);
      setDraftAnswers((previous) => {
        if (JSON.stringify(previous[questionId]) !== JSON.stringify(value)) return previous;
        const next = { ...previous };
        delete next[questionId];
        return next;
      });
    } catch {
      setQueueError(
        'This answer could not be stored on your device. Do not close the page. Free storage or ask your invigilator for help.',
      );
    }
  }
  async function submit() {
    if (
      submitting.current ||
      busy ||
      !queueReady ||
      unsavedCount > 0 ||
      remaining <= 0 ||
      stateRef.current?.controls?.pausedAt != null ||
      stateRef.current?.attempt?.status !== 'active'
    )
      return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      if (!queue.current || Object.keys(draftAnswers).length) throw new Error('PENDING');
      await queue.current.flush();
      if (queue.current.entries.length) throw new Error('PENDING');
      const result = await api<CandidateView>(`${examApi}/submit`, { method: 'POST', body: {} });
      // Only discard the outbox after the server confirms submission.
      setState(result);
      setConfirm(false);
      await queue.current?.clear().catch(() => {});
    } catch (error) {
      setError(
        error instanceof Error && error.message === 'PENDING'
          ? 'Some answers are still waiting to save. Reconnect before submitting.'
          : errorMessage(error),
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  function answerFor(id: string): Answer | undefined {
    if (draftAnswers[id] !== undefined) return draftAnswers[id];
    const pending = queue.current?.entries.find((entry) => entry.questionId === id);
    return pending ? (pending.nextValue ?? pending.value) : state?.attempt?.responses[id]?.value;
  }
  const answered = (value?: Answer) =>
    typeof value === 'string' ? Boolean(value.trim()) : Boolean(value?.length);
  const attempt = state?.attempt;
  const currentQuestion = attempt?.questions[Math.min(index, attempt.questions.length - 1)];
  const answeredCount = attempt?.questions.filter((q) => answered(answerFor(q.id))).length ?? 0;
  return (
    <div className="candidate-app">
      <header className="candidate-header">
        <Brand />
        {assessmentId ? (
          <a className="candidate-header-label" href="/exam">
            My examinations
          </a>
        ) : (
          <span className="candidate-header-label">One-off examination access</span>
        )}
        {authenticated && (
          <button
            className="text-button"
            onClick={onLogout}
            disabled={(attemptStatus === 'active' && unsavedCount > 0) || busy}
            data-disabled-reason={
              busy
                ? 'Please wait for the current action to finish.'
                : attemptStatus === 'active' && unsavedCount > 0
                  ? 'Wait for your answers to save before signing out, so none are lost.'
                  : undefined
            }
          >
            Sign out
          </button>
        )}
      </header>
      {authenticated && state && (
        <>
          {paused && (
            <div className="candidate-pause-banner" role="status">
              <strong>Examination paused</strong>
              <p>
                Your timer is frozen. Saved answers are safe. Wait for your administrator to resume;
                do not close this page if you have pending saves.
              </p>
            </div>
          )}
          <CandidateAnnouncements items={state.announcements ?? []} examApi={examApi} />
        </>
      )}
      {!authenticated ? (
        <main className="candidate-login">
          <div className="auth-card">
            <span className="eyebrow">LET’S GET YOU STARTED</span>
            <h1>
              Your examination
              <br />
              starts here.
            </h1>
            <p className="muted">Use the details provided by your assessment administrator.</p>
            <form onSubmit={login}>
              <label>
                Examination code
                <input
                  name="code"
                  defaultValue={new URLSearchParams(location.search).get('code') ?? ''}
                  autoCapitalize="characters"
                  autoComplete="off"
                  required
                  maxLength={30}
                  placeholder="Enter examination code"
                />
              </label>
              <label>
                Candidate ID
                <input
                  name="identifier"
                  autoComplete="username"
                  required
                  maxLength={80}
                  placeholder="Matriculation or candidate number"
                />
              </label>
              <label>
                Access key
                <PasswordInput
                  name="credential"
                  secretLabel="access key"
                  autoComplete="current-password"
                  required
                  maxLength={128}
                  placeholder="Your personal access key"
                />
              </label>
              {error && <Notice>{error}</Notice>}
              <button className="button primary full" disabled={busy}>
                {busy ? 'Checking your details…' : 'Continue'}
                <Icon name="arrow" size={17} />
              </button>
            </form>
            <p className="field-hint">
              Signing in on another device closes your previous device session. Previously saved
              answers remain available.
            </p>
          </div>
          <p className="muted small">
            Managing an assessment? <a href="/">Administrator sign-in</a>
          </p>
        </main>
      ) : deviceRecovery ? (
        <main className="candidate-login">
          <h1>Continue on this device?</h1>
          <p>
            Your examination is open on another device. Continuing here restores your saved answers
            and closes access on the other device. Your timer does not restart.
          </p>
          {error && <Notice>{error}</Notice>}
          <button
            className="button primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`${examApi}/claim`, { method: 'POST', body: {} });
                setDeviceRecovery(false);
                await refresh();
              } catch (error) {
                setError(errorMessage(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Restoring…' : 'Continue on this device'}
          </button>
        </main>
      ) : !state ? (
        <main className="candidate-login">{error ? <Notice>{error}</Notice> : <Loading />}</main>
      ) : !attempt ? (
        <main className="instructions-page">
          <span className="eyebrow">{state.sitting.course}</span>
          <h1>{state.sitting.title}</h1>
          <p className="muted">
            Welcome, {state.candidate.name} <span className="dot-separator">·</span>{' '}
            {state.candidate.identifier}
          </p>
          <div className="instruction-meta">
            <span>
              <Icon name="paper" />
              {state.sitting.questionCount} questions
            </span>
            <span>
              <Icon name="clock" />
              {state.sitting.timingMode === 'individual'
                ? `${state.sitting.durationMinutes} minutes from when you begin`
                : `${formatTime(remaining)} remaining`}
            </span>
          </div>
          <section className="panel padded">
            <h2>Before you begin</h2>
            <p className="pre-wrap">
              {state.sitting.instructions ||
                'Read each question carefully. You can revisit your answers before submitting.'}
            </p>
            <ul className="instruction-list">
              <li>
                {state.sitting.timingMode === 'individual'
                  ? 'Your timer starts only when you click Begin examination. Once started, it continues if you leave or disconnect.'
                  : 'The examination clock is already running. Leaving this page does not pause it.'}
              </li>
              <li>Your answers save as you go. Check the save status before closing this page.</li>
              <li>If your connection drops, keep this device open while it reconnects.</li>
              <li>Once submitted, your answers cannot be changed.</li>
            </ul>
          </section>
          {state.sitting.timingMode === 'individual' && (
            <div className="panel padded candidate-availability">
              <dl className="summary-list">
                <div>
                  <dt>Open from</dt>
                  <dd>{new Date(state.sitting.opensAt!).toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Start before</dt>
                  <dd>{new Date(state.sitting.lastStartAt!).toLocaleString()}</dd>
                </div>
                {state.sitting.finishBy && (
                  <div>
                    <dt>Finish by</dt>
                    <dd>{new Date(state.sitting.finishBy).toLocaleString()}</dd>
                  </div>
                )}
              </dl>
              {state.sitting.canStart &&
                remaining < state.sitting.durationMinutes * 60000 - 1000 && (
                  <p className="timing-shortening-warning" role="status">
                    The finish-by deadline leaves {formatTime(remaining)} if you begin now, rather
                    than the full {state.sitting.durationMinutes} minutes.
                  </p>
                )}
            </div>
          )}
          {state.sitting.startRestriction && (
            <Notice kind="info">
              {state.sitting.startRestriction === 'not_open'
                ? `This examination opens on ${new Date(state.sitting.opensAt!).toLocaleString()}. Your timer has not started.`
                : 'The start window has closed. You can no longer begin this examination.'}
            </Notice>
          )}
          {error && <Notice>{error}</Notice>}
          <button
            className="button primary"
            disabled={busy || remaining <= 0 || state.sitting.canStart === false}
            data-disabled-reason={
              busy
                ? 'Please wait while the examination is starting.'
                : paused
                  ? 'The examination is paused by the administrator.'
                  : state.sitting.startRestriction === 'not_open'
                    ? `This examination opens on ${new Date(state.sitting.opensAt!).toLocaleString()}.`
                    : state.sitting.canStart === false
                      ? 'The start window has closed. You can no longer begin this examination.'
                      : remaining <= 0
                        ? 'This examination has ended.'
                        : undefined
            }
            onClick={start}
          >
            {state.sitting.startRestriction === 'not_open'
              ? 'Not open yet'
              : paused
                ? 'Examination paused'
                : state.sitting.canStart === false
                  ? 'Starting is closed'
                  : remaining <= 0
                    ? 'This examination has ended'
                    : busy
                      ? 'Starting…'
                      : 'Begin examination'}
            <Icon name="arrow" size={17} />
          </button>
        </main>
      ) : attempt.status !== 'active' ? (
        <main className="submission-page">
          <div className="submission-check">
            <Icon name="check" size={36} />
          </div>
          <span className="eyebrow">
            {attempt.status === 'expired' ? 'TIME COMPLETED' : 'EXAMINATION COMPLETE'}
          </span>
          <h1>
            {attempt.status === 'expired' ? 'Your saved answers are recorded.' : 'You’re all done.'}
          </h1>
          <p className="muted">
            {attempt.status === 'expired'
              ? 'The examination has ended. Answers that reached MUDU before the deadline are included.'
              : 'Your submission is confirmed. Your answers can no longer be changed.'}
          </p>
          <div className="submission-receipt">
            <strong>{state.sitting.title}</strong>
            <span>
              {state.candidate.name} · {state.candidate.identifier}
            </span>
            <span>{attempt.submittedAt ? new Date(attempt.submittedAt).toLocaleString() : ''}</span>
            <span className="receipt-id">Receipt: {attempt.id}</span>
          </div>
          {unsavedCount > 0 && (
            <Notice>
              Some changes on this device were not acknowledged before the examination ended. Tell
              your invigilator; they are not included in the confirmed submission.
            </Notice>
          )}
          <p className="muted small">Your administrator will communicate results separately.</p>
          <button className="button secondary" onClick={onLogout}>
            Sign out
          </button>
        </main>
      ) : (
        currentQuestion && (
          <main className="exam-layout">
            <div className="exam-heading">
              <div>
                <span className="eyebrow">{state.sitting.course}</span>
                <h1>{state.sitting.title}</h1>
                <p className="muted small">
                  {state.candidate.name} · {state.candidate.identifier}
                </p>
              </div>
              <div className={`exam-timer ${remaining < 60000 ? 'urgent' : ''}`}>
                <span>{paused ? 'Paused · time remaining' : 'Time remaining'}</span>
                <strong>
                  <Icon name="clock" size={20} />
                  {formatTime(remaining)}
                </strong>
              </div>
            </div>
            {confirm ? (
              <SubmissionReview
                questions={attempt.questions.map((q) => ({
                  id: q.id,
                  prompt: q.prompt,
                  answered: answered(answerFor(q.id)),
                }))}
                pending={unsavedCount}
                ready={queueReady}
                expired={remaining <= 0}
                busy={busy}
                paused={paused}
                error={error}
                saveError={queueError}
                onBack={() => setConfirm(false)}
                onQuestion={(i) => {
                  setIndex(i);
                  setConfirm(false);
                }}
                onSubmit={() => void submit()}
              />
            ) : (
              <div className="exam-body">
                <section className="exam-question">
                  <div className="inline between">
                    <span className="eyebrow">
                      QUESTION {index + 1} OF {attempt.questions.length}
                    </span>
                    <span className="muted small">
                      {currentQuestion.marks} {currentQuestion.marks === 1 ? 'mark' : 'marks'}
                    </span>
                  </div>
                  <h2 className="pre-wrap" ref={questionHeading} tabIndex={-1}>
                    {currentQuestion.prompt}
                  </h2>
                  <p className="muted small">
                    {currentQuestion.type === 'single'
                      ? 'Select one answer.'
                      : currentQuestion.type === 'multiple'
                        ? 'Select all correct answers.'
                        : 'Write your answer below.'}
                  </p>
                  {currentQuestion.type === 'short' ? (
                    <textarea
                      className="short-answer"
                      rows={8}
                      maxLength={10000}
                      aria-label="Your answer"
                      value={String(answerFor(currentQuestion.id) ?? '')}
                      disabled={!queueReady || busy || remaining <= 0 || paused}
                      onChange={(e) => {
                        void choose(currentQuestion.id, e.target.value);
                      }}
                    />
                  ) : (
                    <fieldset className="candidate-options">
                      <legend className="sr-only">Answer options</legend>
                      {currentQuestion.options.map((option, optionIndex) => {
                        const selected = answerFor(currentQuestion.id);
                        const values = Array.isArray(selected) ? selected : [];
                        return (
                          <label
                            className={`candidate-option ${values.includes(option.id) ? 'selected' : ''}`}
                            key={option.id}
                          >
                            <input
                              type={currentQuestion.type === 'single' ? 'radio' : 'checkbox'}
                              name={currentQuestion.id}
                              checked={values.includes(option.id)}
                              disabled={!queueReady || busy || remaining <= 0 || paused}
                              onChange={(e) => {
                                void choose(
                                  currentQuestion.id,
                                  currentQuestion.type === 'single'
                                    ? [option.id]
                                    : e.target.checked
                                      ? [...values, option.id]
                                      : values.filter((id) => id !== option.id),
                                );
                              }}
                            />
                            <span className="option-letter">
                              {String.fromCharCode(65 + optionIndex)}
                            </span>
                            <span>{option.text}</span>
                          </label>
                        );
                      })}
                    </fieldset>
                  )}
                  <div className="exam-navigation">
                    <button
                      className="button secondary"
                      disabled={index === 0}
                      onClick={() => setIndex(index - 1)}
                    >
                      <Icon name="back" size={16} />
                      Previous
                    </button>
                    <span className={`save-status ${unsavedCount ? 'pending' : ''}`} role="status">
                      {!queueReady ? (
                        'Preparing answer recovery…'
                      ) : unsavedCount ? (
                        `${unsavedCount} waiting to save`
                      ) : (
                        <>
                          <Icon name="check" size={14} />
                          All changes saved
                        </>
                      )}
                    </span>
                    <button
                      className={`button ${index === attempt.questions.length - 1 ? 'primary' : 'secondary'}`}
                      disabled={busy || remaining <= 0 || paused}
                      onClick={() =>
                        index === attempt.questions.length - 1
                          ? setConfirm(true)
                          : setIndex(index + 1)
                      }
                    >
                      {index === attempt.questions.length - 1 ? 'Review & submit' : 'Next'}
                      <Icon name="arrow" size={16} />
                    </button>
                  </div>
                  {queueError && (
                    <Notice
                      kind={
                        queue.current?.error instanceof ApiError &&
                        queue.current.error.code !== 'EXAM_PAUSED'
                          ? 'error'
                          : 'info'
                      }
                    >
                      {queueError}
                    </Notice>
                  )}
                  {error && <Notice>{error}</Notice>}
                  {remaining <= 0 && (
                    <Notice kind="info">
                      Time is up. Waiting for the Host to confirm your final status.
                    </Notice>
                  )}
                </section>
                <aside className="exam-progress">
                  <h3>Your progress</h3>
                  <p className="muted small">
                    {answeredCount} of {attempt.questions.length} answered
                  </p>
                  <progress
                    value={answeredCount}
                    max={attempt.questions.length}
                    aria-label="Questions answered"
                  />
                  <div className="question-grid">
                    {attempt.questions.map((q, i) => (
                      <button
                        key={q.id}
                        className={`${answered(answerFor(q.id)) ? 'answered' : ''} ${i === index ? 'current' : ''}`}
                        onClick={() => setIndex(i)}
                        aria-label={`Question ${i + 1}, ${answered(answerFor(q.id)) ? 'answered' : 'unanswered'}`}
                        aria-current={i === index ? 'step' : undefined}
                      >
                        {i + 1}
                      </button>
                    ))}
                  </div>
                  <div className="progress-legend">
                    <span>
                      <i />
                      Unanswered
                    </span>
                    <span>
                      <i className="answered" />
                      Answered
                    </span>
                  </div>
                </aside>
              </div>
            )}
          </main>
        )
      )}
      <footer className="candidate-footer">
        <Icon name="shield" size={14} />
        Powered by MUDU
      </footer>
    </div>
  );
}
