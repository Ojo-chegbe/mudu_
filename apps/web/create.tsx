import { useEffect, useRef, useState } from 'react';
import { browserId } from './browser-id.ts';
import { QuestionBankPicker } from './question-bank.tsx';
import { AssessmentGenerate } from './assessment-generate.tsx';
import { TimingFields, TimingSummary, LateAdmissionField } from './timing-fields.tsx';
import { parseTiming, sharedTiming } from '../../packages/exam-core/timing.ts';
import type { TimingSettings } from '../../packages/exam-core/model.ts';
import type { CandidateInput, QuestionType } from '../../packages/exam-core/model.ts';
import { parseAssessment } from '../../packages/exam-core/engine.ts';
import { parseCsv, writeCsv } from '../../packages/exam-core/csv.ts';
import { api, download, errorMessage } from './api.ts';
import { Dialog, Icon, Loading, Notice, PasswordInput } from './ui.tsx';
import { AuthoringSaveStatus, useWizardSave } from './authoring.tsx';
import type { SavedWizard } from '../../packages/contracts/cloud-authoring.ts';
import { draftKey, readDraft, writeDraft } from './assessment-draft.ts';
import { RegistrationAdmin } from './registration-admin.tsx';
import type { RosterSummary, RosterDetail } from '../../packages/contracts/rosters.ts';

interface QuestionDraft {
  type: QuestionType;
  prompt: string;
  marks: number;
  options: string[];
  correctIndices: number[];
}
const question = (): QuestionDraft => ({
  type: 'single',
  prompt: '',
  marks: 1,
  options: ['', '', '', ''],
  correctIndices: [0],
});
function accessKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('');
}
const candidate = (): CandidateInput => ({ identifier: '', name: '', credential: accessKey() });

interface Draft {
  useRoster?: boolean;
  accessChoiceConfirmed?: boolean;
  roster?: { id: string; name: string; revision: number } | null;
  step: number;
  details: {
    title: string;
    course: string;
    instructions: string;
    durationMinutes: number;
    passPercent: number;
    shuffleQuestions: boolean;
    shuffleOptions: boolean;
    timing?: TimingSettings;
    allowLateAdmission?: boolean;
  };
  questions: QuestionDraft[];
  candidates: CandidateInput[];
  accessMode: 'accounts' | 'legacy';
  registrationPolicy: 'approval' | 'roster';
  registrationCloses: string;
  registrationCapacity: number;
  keysSaved: boolean;
  requestId: string;
  createdId: string | null;
}
function isDraft(value: unknown): value is Draft {
  if (!value || typeof value !== 'object') return false;
  const d = value as Draft;
  return (
    Number.isInteger(d.step) &&
    d.step >= 0 &&
    d.step <= 3 &&
    Boolean(d.details) &&
    ['title', 'course', 'instructions'].every((k) => typeof d.details[k as 'title'] === 'string') &&
    Number.isFinite(d.details.durationMinutes) &&
    Number.isFinite(d.details.passPercent) &&
    typeof d.details.shuffleQuestions === 'boolean' &&
    typeof d.details.shuffleOptions === 'boolean' &&
    Array.isArray(d.questions) &&
    d.questions.length > 0 &&
    d.questions.length <= 200 &&
    d.questions.every(
      (q) =>
        q &&
        ['single', 'multiple', 'short'].includes(q.type) &&
        typeof q.prompt === 'string' &&
        Number.isFinite(q.marks) &&
        Array.isArray(q.options) &&
        q.options.every((o) => typeof o === 'string') &&
        Array.isArray(q.correctIndices) &&
        q.correctIndices.every(Number.isInteger),
    ) &&
    Array.isArray(d.candidates) &&
    d.candidates.length <= 500 &&
    d.candidates.every(
      (c) =>
        c &&
        typeof c.identifier === 'string' &&
        typeof c.name === 'string' &&
        typeof c.credential === 'string',
    ) &&
    ['accounts', 'legacy'].includes(d.accessMode) &&
    ['approval', 'roster'].includes(d.registrationPolicy) &&
    typeof d.registrationCloses === 'string' &&
    Number.isFinite(d.registrationCapacity) &&
    typeof d.keysSaved === 'boolean' &&
    typeof d.requestId === 'string' &&
    /^[a-f0-9-]{36}$/.test(d.requestId) &&
    (d.createdId === null ||
      (typeof d.createdId === 'string' && /^[a-f0-9-]{36}$/.test(d.createdId)))
  );
}

export function CreateAssessment() {
  const id = new URLSearchParams(location.search).get('draft');
  const [loaded, setLoaded] = useState<{
    draft: Draft | null;
    revision: number;
    conflict: boolean;
  } | null>(() => {
    if (id) return null;
    try {
      const local = readDraft(sessionStorage, isDraft);
      return {
        draft: local,
        revision: local
          ? Number(sessionStorage.getItem(`mudu.authoring-revision.${local.requestId}`) ?? 0)
          : 0,
        conflict: false,
      };
    } catch {
      return { draft: null, revision: 0, conflict: false };
    }
  });
  const [error, setError] = useState('');
  useEffect(() => {
    if (!id) return;
    let alive = true;
    void api<SavedWizard | { createdId: string }>(`/authoring/${id}`)
      .then((value) => {
        if (!alive) return;
        if ('createdId' in value) {
          location.replace(`/assessments/${value.createdId}`);
          return;
        }
        let local: Draft | null = null,
          version = 0;
        try {
          local = readDraft(sessionStorage, isDraft);
          version = Number(sessionStorage.getItem(`mudu.authoring-revision.${id}`) ?? 0);
        } catch {
          /* Cloud draft can still load. */
        }
        const matching = local?.requestId === id && !local.createdId;
        if (!matching)
          try {
            sessionStorage.setItem(`mudu.authoring-revision.${id}`, String(value.revision));
          } catch {
            /* Cloud draft remains saved. */
          }
        setLoaded({
          draft: matching ? local : value.draft,
          revision: matching ? version : value.revision,
          conflict: Boolean(matching && version !== value.revision),
        });
      })
      .catch((e) => {
        if (!alive) return;
        try {
          const local = readDraft(sessionStorage, isDraft);
          if (local?.requestId === id) {
            setLoaded({
              draft: local,
              revision: Number(sessionStorage.getItem(`mudu.authoring-revision.${id}`) ?? 0),
              conflict: false,
            });
            return;
          }
        } catch {
          /* Show the retry path. */
        }
        setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [id]);
  if (!loaded)
    return (
      <>
        {error ? (
          <>
            <Notice>{error}</Notice>
            <div className="actions">
              <button className="button secondary" onClick={() => location.reload()}>
                Try again
              </button>
              <a href="/">Back to assessments</a>
            </div>
          </>
        ) : (
          <Loading />
        )}
      </>
    );
  return (
    <AssessmentCreation
      initial={loaded.draft}
      initialRevision={loaded.revision}
      initialConflict={loaded.conflict}
    />
  );
}
function AssessmentCreation({
  initial,
  initialRevision,
  initialConflict,
}: {
  initial: Draft | null;
  initialRevision: number;
  initialConflict: boolean;
}) {
  const [bankOpen, setBankOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [recovery] = useState(() => {
    try {
      return { draft: initial ?? readDraft(sessionStorage, isDraft), error: '' };
    } catch {
      return {
        draft: null,
        error:
          'Your previous draft could not be restored. Draft recovery may be unavailable in this browser.',
      };
    }
  });
  const restored = recovery.draft;
  const [useRoster, setUseRoster] = useState(restored?.useRoster ?? !restored);
  const [legacyVisible, setLegacyVisible] = useState(restored?.accessChoiceConfirmed ?? false);
  const [pendingRoster, setPendingRoster] = useState<string | null>(null);
  const [rostersLoaded, setRostersLoaded] = useState(false);
  const [roster, setRoster] = useState<Draft['roster']>(restored?.roster ?? null);
  const [rosters, setRosters] = useState<RosterSummary[]>([]);
  const [rosterBusy, setRosterBusy] = useState(false);
  async function loadRosters() {
    try {
      setRosters(
        (await api<{ rosters: RosterSummary[] }>('/rosters')).rosters.filter((r) => !r.archived),
      );
      setRostersLoaded(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function selectRoster(id: string) {
    if (!id) {
      setRoster(null);
      setCandidates([]);
      return;
    }
    setRosterBusy(true);
    setError('');
    try {
      const r = await api<RosterDetail>(`/rosters/${id}`);
      setUseRoster(true);
      setLegacyVisible(false);
      setRoster({ id: r.id, name: r.name, revision: r.revision });
      setCandidates(
        r.members
          .filter((m) => m.status === 'approved' && m.identityStatus === 'verified')
          .map((m) => ({ name: m.name, identifier: m.identifier, credential: '' })),
      );
      setAccessMode('accounts');
      setRegistrationPolicy('roster');
      setRegistrationCapacity(500);
      setRegistrationCloses('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRosterBusy(false);
    }
  }
  const [requestId] = useState(() => restored?.requestId ?? browserId());
  const [createdId, setCreatedId] = useState<string | null>(restored?.createdId ?? null);
  const [recoveredSave, setRecoveredSave] = useState(false);
  const [discard, setDiscard] = useState(false);
  const submitting = useRef(false);
  const draftSaved = useRef(false);
  const [draftError, setDraftError] = useState(recovery.error);
  const [step, setStep] = useState(
    restored && restored.useRoster !== true && !restored.accessChoiceConfirmed && restored.step >= 2
      ? 2
      : (restored?.step ?? 0),
  );
  useEffect(() => {
    if (step === 2 && (useRoster || !legacyVisible)) {
      void loadRosters();
      const suggested = new URLSearchParams(location.search).get('roster');
      if (suggested && !roster) {
        if (!useRoster && candidates.length) setPendingRoster(suggested);
        else void selectRoster(suggested);
      }
    }
  }, [step, useRoster, legacyVisible]);
  const [details, setDetails] = useState<Draft['details']>(
    restored?.details ?? {
      title: '',
      course: '',
      instructions: '',
      durationMinutes: 60,
      passPercent: 50,
      shuffleQuestions: true,
      shuffleOptions: true,
      timing: sharedTiming(),
      allowLateAdmission: false,
    },
  );
  const [questions, setQuestions] = useState<QuestionDraft[]>(restored?.questions ?? [question()]);
  const [candidates, setCandidates] = useState<CandidateInput[]>(restored?.candidates ?? []);
  const [accessMode, setAccessMode] = useState<'accounts' | 'legacy'>(
    restored?.accessMode ?? 'accounts',
  );
  const [registrationPolicy, setRegistrationPolicy] = useState<'approval' | 'roster'>(
    restored?.registrationPolicy ?? 'approval',
  );
  const [registrationCloses, setRegistrationCloses] = useState(restored?.registrationCloses ?? '');
  const [registrationCapacity, setRegistrationCapacity] = useState(
    restored?.registrationCapacity ?? 500,
  );
  const [directory, setDirectory] = useState<Array<{ name: string; identifier: string }>>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [keysSaved, setKeysSaved] = useState(restored?.keysSaved ?? false);
  const saved = useRef(Boolean(restored?.createdId));
  const draft: Draft = {
    accessChoiceConfirmed: legacyVisible,
    useRoster,
    roster,
    step,
    details,
    questions,
    candidates,
    accessMode,
    registrationPolicy,
    registrationCloses,
    registrationCapacity,
    keysSaved,
    requestId,
    createdId,
  };
  const serialized = JSON.stringify(draft);
  const authoring = useWizardSave(draft, initialRevision, initialConflict);
  useEffect(() => {
    try {
      draftSaved.current = writeDraft(sessionStorage, JSON.parse(serialized));
    } catch {
      draftSaved.current = false;
    }
    setDraftError(
      draftSaved.current
        ? ''
        : 'Draft backup is unavailable. Keep this tab open until your assessment is created.',
    );
  }, [serialized]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (!saved.current && !draftSaved.current) event.preventDefault();
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, []);
  const payload = {
    ...(useRoster && roster ? { rosterId: roster.id, rosterRevision: roster.revision } : {}),
    ...details,
    questions,
    candidates,
    accessMode,
    registrationPolicy,
    registrationCapacity,
    registrationClosesAt: registrationCloses ? new Date(registrationCloses).getTime() : null,
  };
  useEffect(() => {
    if (step === 2 && accessMode === 'accounts')
      void api<{ candidates: Array<{ name: string; identifier: string }> }>('/candidate-directory')
        .then((result) => setDirectory(result.candidates))
        .catch(() => {});
  }, [step, accessMode]);
  function updateQuestion(index: number, patch: Partial<QuestionDraft>) {
    setQuestions((items) => items.map((q, i) => (i === index ? { ...q, ...patch } : q)));
  }
  function updateCandidate(index: number, patch: Partial<CandidateInput>) {
    setKeysSaved(false);
    setCandidates((items) => items.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }
  function next() {
    setError('');
    if (step === 0) {
      try {
        parseTiming(details.timing);
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Check the timing settings.');
        return;
      }
    }
    if (step === 2) {
      try {
        if (!useRoster && !legacyVisible)
          throw new Error('Select a roster, or explicitly continue with the saved access method.');
        if (useRoster && (!roster || !candidates.length || rosterBusy))
          throw new Error('Choose a roster with at least one approved member.');
        parseAssessment(payload, browserId);
        if (accessMode === 'accounts' && registrationPolicy === 'roster' && !candidates.length)
          throw new Error('Add a roster for roster-restricted registration.');
        if (registrationCloses && new Date(registrationCloses).getTime() <= Date.now())
          throw new Error('Choose a closing time in the future.');
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Check the assessment.');
        return;
      }
    }
    setStep(Math.min(3, step + 1));
  }
  async function importRoster(file?: File) {
    if (!file) return;
    setError('');
    if (file.size > 1024 * 1024) {
      setError('Choose a CSV smaller than 1 MB.');
      return;
    }
    try {
      const [headers, ...rows] = parseCsv(await file.text());
      const columns = headers?.map((h) => h.trim().toLowerCase());
      if (!columns?.includes('candidate_id') || !columns.includes('name'))
        throw new Error('CSV headers must include candidate_id and name. access_key is optional.');
      if (new Set(columns).size !== columns.length)
        throw new Error('CSV column names must be unique.');
      if (!rows.length || rows.length > 500)
        throw new Error('Import between 1 and 500 candidates.');
      const imported = rows.map((row, index) => {
        if (row.length !== columns.length)
          throw new Error(`Row ${index + 2} has the wrong number of columns.`);
        const id = row[columns.indexOf('candidate_id')]?.trim();
        const name = row[columns.indexOf('name')]?.trim();
        const credential = row[columns.indexOf('access_key')]?.trim() || accessKey();
        if (!id || !name || (accessMode === 'legacy' && credential.length < 8))
          throw new Error(
            `Row ${index + 2}: provide an ID, name, and access key of at least 8 characters.`,
          );
        return { identifier: id, name, credential };
      });
      setCandidates(imported);
      setKeysSaved(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not read the CSV.');
    }
  }
  async function create() {
    if (submitting.current || createdId) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      if (accessMode === 'accounts') await authoring.save();
      const result = await api<{ id: string; recovered?: boolean }>('/assessments', {
        method: 'POST',
        body: {
          ...payload,
          creationRequestId: requestId,
          ...(accessMode === 'accounts' ? { authoringRevision: authoring.revision.current } : {}),
        },
      });
      saved.current = true;
      setRecoveredSave(Boolean(result.recovered));
      setCreatedId(result.id);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  if (createdId)
    return (
      <>
        <div className="page-heading">
          <div>
            <h1>Assessment created</h1>
            <p className="muted">Your assessment is saved. You can safely leave this page.</p>
          </div>
        </div>
        {recoveredSave && (
          <Notice>
            An earlier save already succeeded. We recovered that assessment without making a
            duplicate. Changes made after that save are not included.
          </Notice>
        )}
        {accessMode === 'accounts' && !useRoster && (
          <RegistrationAdmin assessmentId={createdId} onChange={async () => {}} />
        )}
        <div className="actions">
          <a className="button primary" href={`/assessments/${createdId}`}>
            Open assessment <Icon name="arrow" size={16} />
          </a>
          <button
            className="button secondary"
            type="button"
            onClick={() => {
              try {
                sessionStorage.removeItem(draftKey);
                location.href = '/assessments/new';
              } catch {
                setDraftError(
                  'Could not clear this tab’s draft. Open a new tab to create another assessment.',
                );
              }
            }}
          >
            Create another assessment
          </button>
        </div>
        {draftError && <Notice>{draftError}</Notice>}
      </>
    );
  return (
    <>
      <a className="back-link" href="/">
        <Icon name="back" size={16} />
        All assessments
      </a>
      <div className="page-heading">
        <div>
          <span className="eyebrow">LET’S PUT IT TOGETHER</span>
          <h1>Create an assessment</h1>
          <p className="muted">A clear path from your questions to a ready examination.</p>
        </div>
        <span className="muted small">Step {step + 1} of 4</span>
      </div>
      <ol className="steps">
        {['Details & rules', 'Questions', 'Candidate access', 'Review'].map((label, i) => (
          <li
            key={label}
            className={step === i ? 'current' : i < step ? 'done' : ''}
            aria-current={step === i ? 'step' : undefined}
          >
            <span>{i < step ? <Icon name="check" size={14} /> : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      <div className="draft-toolbar">
        {draftError ? (
          <Notice>{draftError}</Notice>
        ) : (
          <span className="muted small" role="status">
            <Icon name="check" size={14} />{' '}
            {authoring.saving
              ? 'Saving draft…'
              : authoring.saved
                ? 'Draft saved to your workspace'
                : restored
                  ? 'Draft restored · saved in this tab'
                  : 'Draft saved in this tab'}
          </span>
        )}
        <details className="draft-options">
          <summary>Draft options</summary>
          <p className="field-hint">
            {accessMode === 'accounts'
              ? 'Saved workspace drafts can be reopened from Continue drafting. Cloud-saved drafts are available on your other connected devices.'
              : 'Individual access-key drafts stay in this tab only.'}
          </p>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => setDiscard(true)}
          >
            Discard draft
          </button>
        </details>
      </div>
      {accessMode === 'accounts' && (
        <>
          <AuthoringSaveStatus
            id={requestId}
            dirty={authoring.dirty}
            onResolved={() => {
              try {
                sessionStorage.removeItem(draftKey);
                sessionStorage.removeItem(`mudu.authoring-revision.${requestId}`);
              } catch {
                /* Load saved copy. */
              }
              location.reload();
            }}
          />
          {authoring.message && (
            <Notice>
              {authoring.message}
              {authoring.conflict && (
                <div className="actions">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      const link = document.createElement('a');
                      link.href = URL.createObjectURL(
                        new Blob([serialized], { type: 'application/json' }),
                      );
                      link.download = 'assessment-tab-draft.json';
                      link.click();
                      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
                    }}
                  >
                    Download tab changes
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      try {
                        sessionStorage.removeItem(draftKey);
                        sessionStorage.removeItem(`mudu.authoring-revision.${requestId}`);
                      } catch {
                        /* Load saved draft. */
                      }
                      location.reload();
                    }}
                  >
                    Reopen saved draft
                  </button>
                </div>
              )}
            </Notice>
          )}
          <button
            type="button"
            className="text-button authoring-save"
            disabled={busy || authoring.saving || authoring.conflict}
            onClick={() => void authoring.save().catch(() => {})}
          >
            Save draft
          </button>
        </>
      )}
      {pendingRoster && (
        <Dialog
          title="Use this roster for the assessment?"
          confirmLabel="Use roster"
          onClose={() => setPendingRoster(null)}
          confirm={() => {
            const id = pendingRoster;
            setPendingRoster(null);
            void selectRoster(id);
          }}
        >
          <p>
            Your questions and examination settings will be kept. The {candidates.length}{' '}
            individually listed candidates will be replaced by the roster’s approved members.
          </p>
        </Dialog>
      )}
      {discard && (
        <Dialog
          title="Discard this draft?"
          confirmLabel="Discard draft"
          busy={busy}
          onClose={() => setDiscard(false)}
          confirm={async () => {
            setBusy(true);
            try {
              await authoring.discard();
              sessionStorage.removeItem(draftKey);
              saved.current = true;
              location.href = '/assessments/new';
            } catch {
              setDraftError('Could not discard the draft. Your work has been kept.');
              setDiscard(false);
              setBusy(false);
            }
          }}
        >
          <p>
            This discards the unfinished draft from this workspace and its connected devices. It
            cannot be undone. An assessment already saved on the server will not be deleted.
          </p>
        </Dialog>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (step === 3) void create();
          else next();
        }}
      >
        <fieldset disabled={busy} className="assessment-fields">
          {error && <Notice>{error}</Notice>}
          {step === 0 && (
            <section className="panel padded form-section">
              <div className="form-intro">
                <h2>The essentials</h2>
                <p className="muted">Give your assessment a name and set the examination rules.</p>
              </div>
              <label>
                Assessment title
                <input
                  required
                  maxLength={180}
                  placeholder="e.g. Pharmacology final examination"
                  value={details.title}
                  onChange={(e) => setDetails({ ...details, title: e.target.value })}
                />
              </label>
              <label>
                Course or assessment category
                <input
                  required
                  maxLength={100}
                  placeholder="e.g. PCH 401"
                  value={details.course}
                  onChange={(e) => setDetails({ ...details, course: e.target.value })}
                />
              </label>
              <div className="form-grid">
                <label>
                  Duration (minutes)
                  <input
                    type="number"
                    required
                    min={1}
                    max={480}
                    value={details.durationMinutes}
                    onChange={(e) =>
                      setDetails({ ...details, durationMinutes: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  Pass mark (%)
                  <input
                    type="number"
                    required
                    min={0}
                    max={100}
                    value={details.passPercent}
                    onChange={(e) =>
                      setDetails({ ...details, passPercent: Number(e.target.value) })
                    }
                  />
                </label>
              </div>
              <TimingFields
                value={details.timing}
                duration={details.durationMinutes}
                onChange={(timing) => setDetails({ ...details, timing })}
              />
              <LateAdmissionField
                enabled={details.allowLateAdmission ?? false}
                onChange={(allowLateAdmission) => setDetails({ ...details, allowLateAdmission })}
              />
              <label>
                Candidate instructions <span className="optional">Optional</span>
                <textarea
                  rows={4}
                  maxLength={10000}
                  placeholder="What should candidates know before they begin?"
                  value={details.instructions}
                  onChange={(e) => setDetails({ ...details, instructions: e.target.value })}
                />
              </label>
              <div className="rule-group">
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={details.shuffleQuestions}
                    onChange={(e) => setDetails({ ...details, shuffleQuestions: e.target.checked })}
                  />
                  <span>
                    Shuffle question order
                    <small>Each candidate receives a consistent, individual order.</small>
                  </span>
                </label>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={details.shuffleOptions}
                    onChange={(e) => setDetails({ ...details, shuffleOptions: e.target.checked })}
                  />
                  <span>
                    Shuffle answer options
                    <small>Options keep their order when a candidate reconnects.</small>
                  </span>
                </label>
              </div>
            </section>
          )}
          {step === 1 && (
            <div className="question-list">
              <div className="section-heading">
                <div>
                  <h2>Build your question paper</h2>
                  <p className="field-hint">
                    Write questions below or reuse approved questions from your bank.
                  </p>
                </div>
                <div className="actions assessment-question-actions">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={questions.length >= 200}
                    onClick={() => setBankOpen(true)}
                  >
                    Add from question bank
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={questions.length >= 200}
                    onClick={() => setGenerateOpen(true)}
                  >
                    <Icon name="sparkles" size={16} /> Generate with AI
                  </button>
                </div>
              </div>
              {questions.map((q, index) => (
                <section key={index} className="panel padded">
                  <div className="inline between">
                    <span className="eyebrow">QUESTION {index + 1}</span>
                    {questions.length > 1 && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remove question ${index + 1}`}
                        onClick={() => setQuestions(questions.filter((_, i) => i !== index))}
                      >
                        <Icon name="close" size={17} />
                      </button>
                    )}
                  </div>
                  <div className="form-grid question-settings">
                    <label>
                      Question type
                      <select
                        value={q.type}
                        onChange={(e) =>
                          updateQuestion(index, {
                            type: e.target.value as QuestionType,
                            correctIndices: e.target.value === 'short' ? [] : [0],
                          })
                        }
                      >
                        <option value="single">Single choice</option>
                        <option value="multiple">Multiple select</option>
                        <option value="short">Short answer</option>
                      </select>
                    </label>
                    <label>
                      Marks
                      <input
                        type="number"
                        required
                        min={1}
                        max={100}
                        value={q.marks}
                        onChange={(e) => updateQuestion(index, { marks: Number(e.target.value) })}
                      />
                    </label>
                  </div>
                  <label>
                    Question
                    <textarea
                      rows={3}
                      required
                      maxLength={10000}
                      placeholder="Write your question…"
                      value={q.prompt}
                      onChange={(e) => updateQuestion(index, { prompt: e.target.value })}
                    />
                  </label>
                  {q.type !== 'short' ? (
                    <fieldset className="options-editor">
                      <legend>
                        Answer options{' '}
                        <span className="muted small">
                          Select the correct {q.type === 'single' ? 'answer' : 'answers'}.
                        </span>
                      </legend>
                      {q.options.map((option, optionIndex) => (
                        <div className="option-editor" key={optionIndex}>
                          <input
                            type={q.type === 'single' ? 'radio' : 'checkbox'}
                            name={`correct-${index}`}
                            checked={q.correctIndices.includes(optionIndex)}
                            aria-label={`Option ${optionIndex + 1} is correct`}
                            onChange={(e) =>
                              updateQuestion(index, {
                                correctIndices:
                                  q.type === 'single'
                                    ? [optionIndex]
                                    : e.target.checked
                                      ? [...q.correctIndices, optionIndex]
                                      : q.correctIndices.filter((n) => n !== optionIndex),
                              })
                            }
                          />
                          <span>{String.fromCharCode(65 + optionIndex)}</span>
                          <input
                            required
                            aria-label={`Question ${index + 1}, option ${optionIndex + 1}`}
                            maxLength={2000}
                            placeholder={`Option ${String.fromCharCode(65 + optionIndex)}`}
                            value={option}
                            onChange={(e) =>
                              updateQuestion(index, {
                                options: q.options.map((o, i) =>
                                  i === optionIndex ? e.target.value : o,
                                ),
                              })
                            }
                          />
                        </div>
                      ))}
                    </fieldset>
                  ) : (
                    <Notice kind="info">
                      Written answers are saved for manual marking in Results. Scores remain
                      provisional until marking is complete.
                    </Notice>
                  )}
                </section>
              ))}
              <button
                type="button"
                className="button secondary"
                disabled={questions.length >= 200}
                onClick={() => setQuestions([...questions, question()])}
              >
                <Icon name="plus" size={16} />
                Add question
              </button>
            </div>
          )}
          {step === 2 && (useRoster || !legacyVisible) && (
            <section className="panel padded access-roster-panel">
              <h2>Who will take this assessment?</h2>
              <p className="muted">
                Choose a roster. Approved members receive access automatically—no new registration.
              </p>
              {!useRoster && (
                <p className="access-draft-note">
                  This draft uses an older access method. Choose a roster below, or{' '}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setLegacyVisible(true)}
                  >
                    keep its existing setup
                  </button>
                  . Your questions are safe.
                </p>
              )}
              {!rostersLoaded && !error && (
                <p className="muted small" role="status">
                  Loading rosters…
                </p>
              )}
              {rostersLoaded && !rosters.length ? (
                <div className="access-roster-empty">
                  <Icon name="people" size={28} />
                  <h3>Create your group first</h3>
                  <p className="muted small">
                    Create a roster and approve its members, then return to this draft.
                  </p>
                  <a
                    className="button primary"
                    href="/rosters/new"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Create roster <Icon name="arrow" size={16} />
                  </a>
                  <span className="field-hint">Opens in a new tab. This draft stays here.</span>
                </div>
              ) : (
                <>
                  <label>
                    Select roster
                    <select
                      value={useRoster ? (roster?.id ?? '') : ''}
                      disabled={rosterBusy || !rostersLoaded}
                      onChange={(e) => {
                        if (!useRoster && candidates.length && e.target.value)
                          setPendingRoster(e.target.value);
                        else void selectRoster(e.target.value);
                      }}
                    >
                      <option value="">Select your class or group</option>
                      {rosters.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name} — {r.approved} approved
                        </option>
                      ))}
                    </select>
                  </label>
                  {useRoster && roster && (
                    <div className="access-roster-summary">
                      <div>
                        <span className="muted small">Selected roster</span>
                        <h3>{roster.name}</h3>
                        <a
                          className="text-button"
                          href={`/rosters/${roster.id}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Manage members <Icon name="arrow" size={14} />
                        </a>
                      </div>
                      <div>
                        <strong>{candidates.length}</strong>
                        <span className="muted small">
                          approved {candidates.length === 1 ? 'member' : 'members'}
                        </span>
                      </div>
                      <p className="field-hint">
                        {candidates.length
                          ? 'Approved members are assigned automatically. Members approved later also receive this assessment, subject to its admission settings.'
                          : 'Approve at least one member in Rosters, then refresh here to continue.'}
                        {Boolean(rosters.find((r) => r.id === roster.id)?.pending) &&
                          ` ${rosters.find((r) => r.id === roster.id)?.pending} awaiting approval—not included.`}
                      </p>
                    </div>
                  )}
                </>
              )}
              <div className="actions">
                {rosters.length > 0 && (
                  <a className="text-button" href="/rosters/new" target="_blank" rel="noreferrer">
                    Create new roster <Icon name="arrow" size={14} />
                  </a>
                )}
                <button
                  type="button"
                  className="text-button"
                  disabled={rosterBusy}
                  onClick={() => {
                    void loadRosters();
                    if (useRoster && roster) void selectRoster(roster.id);
                  }}
                >
                  Refresh rosters
                </button>
              </div>
              <details className="access-alternatives">
                <summary>Need a one-off access method?</summary>
                <p className="field-hint">
                  For assessment-specific registration or individual keys only. Reusable groups
                  belong in Rosters.
                </p>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    if (!useRoster) {
                      setLegacyVisible(true);
                      return;
                    }
                    setUseRoster(false);
                    setLegacyVisible(true);
                    setRoster(null);
                    setCandidates([]);
                    setRegistrationPolicy('approval');
                  }}
                >
                  Set up one-off access
                </button>
              </details>
            </section>
          )}
          {step === 2 && !useRoster && legacyVisible && (
            <section className="panel padded">
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  setLegacyVisible(false);
                }}
              >
                Back to roster selection
              </button>
              <div className="section-heading">
                <div>
                  <h2>One-off candidate access</h2>
                  <p className="muted small">
                    These settings apply only to this assessment, not a reusable group.
                  </p>
                </div>
                <label className="button secondary upload-label">
                  <Icon name="download" size={16} />
                  Import CSV
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => {
                      void importRoster(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
              <label>
                Candidate access
                <select
                  value={accessMode}
                  onChange={(event) => {
                    const mode = event.target.value as 'accounts' | 'legacy';
                    setAccessMode(mode);
                    if (mode === 'legacy')
                      setCandidates((current) =>
                        current.length
                          ? current.map((entry) => ({
                              ...entry,
                              credential: entry.credential || accessKey(),
                            }))
                          : [candidate()],
                      );
                  }}
                >
                  <option value="accounts">MUDU account — reusable across examinations</option>
                  <option value="legacy">One-off invitation keys</option>
                </select>
              </label>
              {accessMode === 'accounts' && (
                <>
                  <p className="field-hint">
                    Your registration link appears after creation. New candidates need approval
                    before admission.
                  </p>
                  <div className="form-grid">
                    <label>
                      Registration policy
                      <select
                        value={registrationPolicy}
                        onChange={(event) =>
                          setRegistrationPolicy(event.target.value as 'approval' | 'roster')
                        }
                      >
                        <option value="approval">Organiser approval</option>
                        <option value="roster">Restricted to the roster below</option>
                      </select>
                    </label>
                    <label>
                      Candidate limit
                      <input
                        type="number"
                        min={1}
                        max={500}
                        required
                        value={registrationCapacity}
                        onChange={(event) => setRegistrationCapacity(Number(event.target.value))}
                      />
                    </label>
                  </div>
                  <label>
                    Close registration automatically{' '}
                    <span className="optional">Optional · your local time</span>
                    <input
                      type="datetime-local"
                      value={registrationCloses}
                      onChange={(event) => setRegistrationCloses(event.target.value)}
                    />
                  </label>
                  {directory.length > 0 && (
                    <details className="directory-picker">
                      <summary>Reuse verified candidates ({directory.length})</summary>
                      <p className="field-hint">
                        Selected candidates are assigned automatically. They will see this
                        assessment in their account.
                      </p>
                      {directory.map((entry) => (
                        <label className="check-label" key={entry.identifier}>
                          <input
                            type="checkbox"
                            checked={candidates.some((c) => c.identifier === entry.identifier)}
                            onChange={(event) =>
                              setCandidates((current) =>
                                event.target.checked
                                  ? [...current, { ...entry, credential: '' }]
                                  : current.filter((c) => c.identifier !== entry.identifier),
                              )
                            }
                          />
                          <span>
                            {entry.name}
                            <small>{entry.identifier}</small>
                          </span>
                        </label>
                      ))}
                    </details>
                  )}
                </>
              )}
              <p className="field-hint">
                {accessMode === 'accounts' ? (
                  <>
                    {registrationPolicy === 'roster'
                      ? 'Add the candidates allowed to register. A roster is required for this policy.'
                      : 'No candidate list yet? You can skip the roster and invite candidates using your link.'}{' '}
                    To import a list, use CSV columns <code>candidate_id,name</code>. No passwords
                    needed.
                  </>
                ) : (
                  <>
                    CSV columns: <code>candidate_id,name,access_key</code>. Leave access_key empty
                    to generate one.
                  </>
                )}{' '}
                Import replaces the list below.
              </p>
              <div className="roster-editor">
                {candidates.map((c, index) => (
                  <div className="roster-row" key={index}>
                    <label>
                      Candidate ID
                      <input
                        required
                        maxLength={80}
                        placeholder="e.g. UJ/2024/001"
                        value={c.identifier}
                        onChange={(e) => updateCandidate(index, { identifier: e.target.value })}
                      />
                    </label>
                    <label>
                      Full name
                      <input
                        required
                        maxLength={160}
                        placeholder="Candidate name"
                        value={c.name}
                        onChange={(e) => updateCandidate(index, { name: e.target.value })}
                      />
                    </label>
                    {accessMode === 'legacy' && (
                      <label>
                        Access key
                        <PasswordInput
                          secretLabel={`access key for candidate ${index + 1}`}
                          autoComplete="off"
                          required
                          minLength={8}
                          maxLength={128}
                          value={c.credential}
                          onChange={(e) => updateCandidate(index, { credential: e.target.value })}
                        />
                      </label>
                    )}
                    <button
                      type="button"
                      className="icon-button"
                      disabled={accessMode === 'legacy' && candidates.length === 1}
                      aria-label={`Remove candidate ${index + 1}`}
                      onClick={() => {
                        setCandidates(candidates.filter((_, i) => i !== index));
                        setKeysSaved(false);
                      }}
                    >
                      <Icon name="close" size={16} />
                    </button>
                  </div>
                ))}
              </div>
              <button
                className="button secondary"
                type="button"
                disabled={candidates.length >= 500}
                onClick={() => {
                  setCandidates([...candidates, candidate()]);
                  setKeysSaved(false);
                }}
              >
                <Icon name="plus" size={16} />
                Add candidate
              </button>
            </section>
          )}
          {step === 3 && (
            <div className="review-grid">
              <section className="panel padded">
                <span className="eyebrow">ASSESSMENT SUMMARY</span>
                <h2>{details.title}</h2>
                {useRoster && roster && (
                  <p className="muted">Roster: {roster.name} · membership stays connected</p>
                )}
                <p className="muted">{details.course}</p>
                <dl className="summary-list">
                  <TimingSummary timing={details.timing} duration={details.durationMinutes} />
                  <div>
                    <dt>Late admission</dt>
                    <dd>
                      {details.allowLateAdmission
                        ? 'Allowed while admission is open'
                        : 'New members only before opening'}
                    </dd>
                  </div>
                  <div>
                    <dt>Questions</dt>
                    <dd>{questions.length}</dd>
                  </div>
                  <div>
                    <dt>Candidates</dt>
                    <dd>{candidates.length}</dd>
                  </div>
                  <div>
                    <dt>Duration</dt>
                    <dd>{details.durationMinutes} minutes</dd>
                  </div>
                  <div>
                    <dt>Pass mark</dt>
                    <dd>{details.passPercent}%</dd>
                  </div>
                  <div>
                    <dt>Delivery</dt>
                    <dd>Local MUDU Host</dd>
                  </div>
                  <div>
                    <dt>Question order</dt>
                    <dd>{details.shuffleQuestions ? 'Shuffled' : 'Fixed'}</dd>
                  </div>
                  <div>
                    <dt>Answer options</dt>
                    <dd>{details.shuffleOptions ? 'Shuffled' : 'Fixed'}</dd>
                  </div>
                </dl>
                <p className="field-hint">
                  {details.timing?.mode === 'individual'
                    ? 'Creating does not open the assessment. Publish it from the overview; each candidate’s timer starts only when they begin.'
                    : 'Creating the assessment does not start its timer. You will launch it when everyone is ready.'}
                </p>
              </section>
              {accessMode === 'legacy' ? (
                <section className="panel padded">
                  <span className="eyebrow">ONE LAST THING</span>
                  <h2>Save the access keys.</h2>
                  <p className="muted">
                    Distribute each key privately to its candidate. MUDU stores a protected
                    verifier, so these original keys cannot be displayed later.
                  </p>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() =>
                      download(
                        'mudu-candidate-access.csv',
                        writeCsv([
                          ['candidate_id', 'name', 'access_key'],
                          ...candidates.map((c) => [c.identifier, c.name, c.credential]),
                        ]),
                      )
                    }
                  >
                    <Icon name="download" size={17} />
                    Download access keys
                  </button>
                  <label className="check-label key-confirm">
                    <input
                      type="checkbox"
                      required
                      checked={keysSaved}
                      onChange={(e) => setKeysSaved(e.target.checked)}
                    />
                    <span>I have saved the candidate access keys.</span>
                  </label>
                </section>
              ) : (
                <section className="panel padded">
                  <span className="eyebrow">
                    {useRoster ? 'ROSTER ASSIGNMENT' : 'CANDIDATE REGISTRATION'}
                  </span>
                  <h2>One account. Every examination.</h2>
                  <p className="muted">
                    {useRoster
                      ? `${candidates.length} approved members of ${roster?.name} will receive this assessment in their accounts. They do not register again.`
                      : 'Share the registration link after creating this assessment. New candidates create a MUDU account; returning candidates simply sign in.'}
                  </p>
                  <dl className="summary-list">
                    <div>
                      <dt>Admission</dt>
                      <dd>
                        {registrationPolicy === 'roster'
                          ? 'Roster restricted'
                          : 'Lecturer approval'}
                      </dd>
                    </div>
                    <div>
                      <dt>{useRoster ? 'Membership changes' : 'Registration closes'}</dt>
                      <dd>
                        {useRoster
                          ? 'Review and add before the exam starts'
                          : registrationCloses
                            ? new Date(registrationCloses).toLocaleString()
                            : 'When you close it'}
                      </dd>
                    </div>
                    <div>
                      <dt>Candidate limit</dt>
                      <dd>{registrationCapacity}</dd>
                    </div>
                  </dl>
                  <p className="field-hint">
                    {useRoster
                      ? 'New approved members receive this assessment according to its admission settings. Existing attempts and results are preserved.'
                      : 'No access-key spreadsheet to distribute. A shared link never bypasses eligibility checks.'}
                  </p>
                </section>
              )}
            </div>
          )}
          <div className="wizard-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setStep(Math.max(0, step - 1));
                setError('');
              }}
              disabled={step === 0 || busy}
            >
              <Icon name="back" size={16} />
              Back
            </button>
            <button
              className="button primary"
              disabled={
                busy ||
                rosterBusy ||
                (step === 2 &&
                  (useRoster || !legacyVisible) &&
                  (!useRoster || !roster || !candidates.length)) ||
                (step === 3 && accessMode === 'legacy' && !keysSaved)
              }
            >
              {busy
                ? 'Creating assessment…'
                : step === 3
                  ? accessMode === 'accounts'
                    ? useRoster
                      ? 'Create assessment'
                      : 'Create assessment & get link'
                    : 'Create assessment'
                  : step === 2
                    ? 'Continue to review'
                    : 'Continue'}
              <Icon name="arrow" size={16} />
            </button>
          </div>
        </fieldset>
      </form>
      {generateOpen && (
        <AssessmentGenerate
          remaining={
            200 -
            (questions.length === 1 &&
            !questions[0].prompt.trim() &&
            questions[0].options.every((o) => !o.trim())
              ? 0
              : questions.length)
          }
          onClose={() => setGenerateOpen(false)}
          onAdd={(items) =>
            setQuestions((current) =>
              current.length === 1 &&
              !current[0].prompt.trim() &&
              current[0].options.every((o) => !o.trim())
                ? items
                : [...current, ...items],
            )
          }
        />
      )}
      {bankOpen && (
        <QuestionBankPicker
          remaining={
            200 -
            (questions.length === 1 &&
            !questions[0].prompt.trim() &&
            questions[0].options.every((o) => !o.trim())
              ? 0
              : questions.length)
          }
          onClose={() => setBankOpen(false)}
          onAdd={(items) =>
            setQuestions((current) =>
              current.length === 1 &&
              !current[0].prompt.trim() &&
              current[0].options.every((o) => !o.trim())
                ? items
                : [...current, ...items],
            )
          }
        />
      )}
    </>
  );
}
