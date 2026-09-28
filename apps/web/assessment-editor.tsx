import { useEffect, useRef, useState } from 'react';
import type {
  AssessmentEdit,
  AssessmentInput,
} from '../../packages/contracts/assessment-authoring.ts';
import type { QuestionType } from '../../packages/exam-core/model.ts';
import { api, errorMessage } from './api.ts';
import { browserId } from './browser-id.ts';
import { Dialog, Icon, Loading, Notice } from './ui.tsx';
import type { RosterSummary } from '../../packages/contracts/rosters.ts';
import { QuestionBankPicker } from './question-bank.tsx';

function validDraft(value: unknown): value is AssessmentEdit {
  if (!value || typeof value !== 'object') return false;
  const d = value as AssessmentEdit;
  const a = d.input;
  return (
    typeof d.version === 'string' &&
    Boolean(a) &&
    [a.title, a.course, a.instructions].every((v) => typeof v === 'string') &&
    [a.durationMinutes, a.passPercent].every(Number.isFinite) &&
    typeof a.shuffleOptions === 'boolean' &&
    typeof a.shuffleQuestions === 'boolean' &&
    Array.isArray(a.questions) &&
    a.questions.length >= 1 &&
    a.questions.length <= 200 &&
    a.questions.every(
      (q) =>
        q &&
        ['single', 'multiple', 'short'].includes(q.type) &&
        typeof q.prompt === 'string' &&
        Number.isFinite(q.marks) &&
        Array.isArray(q.options) &&
        q.options.every((o) => typeof o === 'string') &&
        Array.isArray(q.correctIndices) &&
        q.correctIndices.every(Number.isInteger),
    )
  );
}

export function AssessmentEditor({ id }: { id: string }) {
  const [bankOpen, setBankOpen] = useState(false);
  const key = `mudu.assessment-edit.${id}`;
  const [saved, setSaved] = useState<AssessmentEdit | null>(null);
  const [draft, setDraft] = useState<AssessmentEdit | null>(null);
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState(false);
  const [restored, setRestored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState<number | null>(null);
  const [reload, setReload] = useState(false);
  const leaving = useRef(false);
  const dirty = Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved));
  useEffect(() => {
    let alive = true;
    void api<AssessmentEdit>(`/assessments/${id}/edit`)
      .then((value) => {
        if (!alive) return;
        setSaved(value);
        setDraft(value);
        try {
          const raw = sessionStorage.getItem(key);
          if (raw) {
            const local: unknown = JSON.parse(raw);
            if (validDraft(local)) {
              setDraft(local);
              setRestored(true);
            } else
              setError(
                'The previous edit draft could not be restored. The saved assessment is shown.',
              );
          }
        } catch {
          setStorageError(true);
        }
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [id, key]);
  useEffect(() => {
    if (!draft || !saved) return;
    try {
      if (dirty) sessionStorage.setItem(key, JSON.stringify(draft));
      else sessionStorage.removeItem(key);
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [draft, saved, dirty, key]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (dirty && !leaving.current) event.preventDefault();
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);
  const update = (patch: Partial<AssessmentInput>) =>
    setDraft((d) => (d ? { ...d, input: { ...d.input, ...patch } } : d));
  const updateQuestion = (index: number, patch: Partial<AssessmentInput['questions'][number]>) => {
    if (draft)
      update({
        questions: draft.input.questions.map((q, i) => (i === index ? { ...q, ...patch } : q)),
      });
  };
  if (!draft)
    return (
      <>
        <a href={`/assessments/${id}`}>Back to assessment</a>
        {error ? <Notice>{error}</Notice> : <Loading />}
      </>
    );
  const input = draft.input;
  return (
    <div className="assessment-editor">
      <a className="back-link" href={`/assessments/${id}`}>
        <Icon name="back" size={16} />
        Back to assessment
      </a>
      <div className="page-heading">
        <div>
          <h1>Edit assessment</h1>
          <p className="muted">
            Update the paper before it starts. Candidate enrolments and registration links stay
            unchanged.
          </p>
        </div>
      </div>
      {error && <Notice>{error}</Notice>}
      {storageError && (
        <Notice>Draft backup is unavailable. Keep this tab open until you save.</Notice>
      )}
      {restored && (
        <p className="field-hint" role="status">
          Your unfinished edits were restored from this tab.
        </p>
      )}
      {saved && saved.version !== draft.version && (
        <Notice>
          The saved assessment has changed since this draft. Reload the saved version before making
          further changes.
        </Notice>
      )}
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          try {
            const value = await api<AssessmentEdit>(`/assessments/${id}/edit`, {
              method: 'PUT',
              body: { ...input, expectedVersion: draft.version },
            });
            leaving.current = true;
            setSaved(value);
            setDraft(value);
            try {
              sessionStorage.removeItem(key);
            } catch {
              /* The server save is authoritative. */
            }
            location.href = `/assessments/${id}?updated=1`;
          } catch (e) {
            setError(errorMessage(e));
            setBusy(false);
          }
        }}
      >
        <fieldset className="assessment-fields" disabled={busy}>
          <section className="panel padded">
            <h2>Assessment details</h2>
            <label>
              Title
              <input
                required
                maxLength={180}
                value={input.title}
                onChange={(e) => update({ title: e.target.value })}
              />
            </label>
            <label>
              Course or programme
              <input
                required
                maxLength={100}
                value={input.course}
                onChange={(e) => update({ course: e.target.value })}
              />
            </label>
            <label>
              Instructions
              <textarea
                maxLength={10000}
                rows={4}
                value={input.instructions}
                onChange={(e) => update({ instructions: e.target.value })}
              />
            </label>
            <div className="roster-row">
              <label>
                Duration (minutes)
                <input
                  type="number"
                  required
                  min={1}
                  max={480}
                  value={input.durationMinutes}
                  onChange={(e) => update({ durationMinutes: Number(e.target.value) })}
                />
              </label>
              <label>
                Pass mark (%)
                <input
                  type="number"
                  required
                  min={0}
                  max={100}
                  value={input.passPercent}
                  onChange={(e) => update({ passPercent: Number(e.target.value) })}
                />
              </label>
            </div>
            <label className="check-label">
              <input
                type="checkbox"
                checked={input.shuffleQuestions}
                onChange={(e) => update({ shuffleQuestions: e.target.checked })}
              />
              Shuffle questions
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={input.shuffleOptions}
                onChange={(e) => update({ shuffleOptions: e.target.checked })}
              />
              Shuffle answer options
            </label>
          </section>
          <div className="section-heading">
            <h2>Questions ({input.questions.length})</h2>
            <button
              type="button"
              className="button secondary"
              disabled={input.questions.length >= 200}
              onClick={() => setBankOpen(true)}
            >
              Add from question bank
            </button>
          </div>
          {input.questions.map((q, index) => (
            <section className="panel padded editor-question" key={index}>
              <div className="section-heading">
                <h3>Question {index + 1}</h3>
                <div className="actions">
                  <button
                    type="button"
                    className="text-button"
                    disabled={index === 0}
                    aria-label={`Move question ${index + 1} up`}
                    onClick={() => {
                      const items = [...input.questions];
                      [items[index - 1], items[index]] = [items[index], items[index - 1]];
                      update({ questions: items });
                    }}
                  >
                    Move up
                  </button>
                  <button
                    type="button"
                    className="text-button membership-action decline"
                    disabled={input.questions.length === 1}
                    onClick={() => setRemove(index)}
                  >
                    Remove
                  </button>
                </div>
              </div>
              <div className="roster-row">
                <label>
                  Question type
                  <select
                    value={q.type}
                    onChange={(e) => {
                      const type = e.target.value as QuestionType;
                      updateQuestion(index, {
                        type,
                        options: q.options.length ? q.options : ['', '', '', ''],
                        correctIndices:
                          type === 'multiple' ? q.correctIndices : [q.correctIndices[0] ?? 0],
                      });
                    }}
                  >
                    <option value="single">Multiple choice</option>
                    <option value="multiple">Multiple select</option>
                    <option value="short">Written answer</option>
                  </select>
                </label>
                <label>
                  Marks
                  <input
                    type="number"
                    min={1}
                    max={100}
                    required
                    value={q.marks}
                    onChange={(e) => updateQuestion(index, { marks: Number(e.target.value) })}
                  />
                </label>
              </div>
              <label>
                Question
                <textarea
                  required
                  maxLength={10000}
                  rows={3}
                  value={q.prompt}
                  onChange={(e) => updateQuestion(index, { prompt: e.target.value })}
                />
              </label>
              {q.type !== 'short' && (
                <>
                  <p className="field-hint">
                    Select the correct {q.type === 'single' ? 'answer' : 'answers'}.
                  </p>
                  {q.options.map((option, optionIndex) => (
                    <div className="editor-option" key={optionIndex}>
                      <input
                        aria-label={`Question ${index + 1}, option ${optionIndex + 1} is correct`}
                        type={q.type === 'single' ? 'radio' : 'checkbox'}
                        name={`correct-${index}`}
                        checked={q.correctIndices.includes(optionIndex)}
                        onChange={() =>
                          updateQuestion(index, {
                            correctIndices:
                              q.type === 'single'
                                ? [optionIndex]
                                : q.correctIndices.includes(optionIndex)
                                  ? q.correctIndices.filter((n) => n !== optionIndex)
                                  : [...q.correctIndices, optionIndex],
                          })
                        }
                      />
                      <input
                        aria-label={`Question ${index + 1}, option ${optionIndex + 1}`}
                        required
                        maxLength={2000}
                        value={option}
                        onChange={(e) =>
                          updateQuestion(index, {
                            options: q.options.map((o, i) =>
                              i === optionIndex ? e.target.value : o,
                            ),
                          })
                        }
                      />
                      <button
                        type="button"
                        className="icon-button"
                        disabled={q.options.length <= 2}
                        aria-label={`Remove option ${optionIndex + 1} from question ${index + 1}`}
                        onClick={() =>
                          updateQuestion(index, {
                            options: q.options.filter((_, i) => i !== optionIndex),
                            correctIndices: q.correctIndices
                              .filter((n) => n !== optionIndex)
                              .map((n) => (n > optionIndex ? n - 1 : n)),
                          })
                        }
                      >
                        <Icon name="close" size={16} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="text-button"
                    disabled={q.options.length >= 8}
                    onClick={() => updateQuestion(index, { options: [...q.options, ''] })}
                  >
                    Add option
                  </button>
                </>
              )}
            </section>
          ))}
          <button
            type="button"
            className="button secondary"
            disabled={input.questions.length >= 200}
            onClick={() =>
              update({
                questions: [
                  ...input.questions,
                  {
                    type: 'single',
                    prompt: '',
                    marks: 1,
                    options: ['', '', '', ''],
                    correctIndices: [0],
                  },
                ],
              })
            }
          >
            <Icon name="plus" size={16} />
            Add question
          </button>
          <div className="wizard-actions">
            <button type="button" className="text-button" onClick={() => setReload(true)}>
              Reload saved version
            </button>
            <span className="muted small" role="status">
              {dirty
                ? storageError
                  ? 'Unsaved edits'
                  : 'Draft saved in this tab'
                : 'No unsaved changes'}
            </span>
            <button className="button primary" disabled={!dirty}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </fieldset>
      </form>
      {bankOpen && (
        <QuestionBankPicker
          remaining={200 - input.questions.length}
          onClose={() => setBankOpen(false)}
          onAdd={(questions) => update({ questions: [...input.questions, ...questions] })}
        />
      )}
      {remove !== null && (
        <Dialog
          title={`Remove question ${remove + 1}?`}
          confirmLabel="Remove question"
          danger
          onClose={() => setRemove(null)}
          confirm={() => {
            update({ questions: input.questions.filter((_, i) => i !== remove) });
            setRemove(null);
          }}
        >
          <p>
            This removes the question from your draft. The saved assessment is unchanged until you
            save.
          </p>
        </Dialog>
      )}
      {reload && (
        <Dialog
          title="Discard these edits?"
          confirmLabel="Reload saved version"
          onClose={() => setReload(false)}
          confirm={async () => {
            try {
              const value = await api<AssessmentEdit>(`/assessments/${id}/edit`);
              setSaved(value);
              setDraft(value);
              setError('');
              setRestored(false);
              setReload(false);
            } catch (e) {
              setError(errorMessage(e));
              setReload(false);
            }
          }}
        >
          <p>Your unfinished edits will be replaced by the latest saved version.</p>
        </Dialog>
      )}
    </div>
  );
}

export function RerunAssessment({
  id,
  title,
  legacy,
  onClose,
}: {
  id: string;
  title: string;
  legacy: boolean;
  onClose: () => void;
}) {
  const key = `mudu.assessment-rerun.${id}`;
  const [draft, setDraft] = useState(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(key) ?? 'null');
      if (
        value &&
        typeof value.title === 'string' &&
        typeof value.includeCandidates === 'boolean' &&
        /^[a-f0-9-]{36}$/.test(value.requestId)
      )
        return { ...value, includeCandidates: legacy ? false : value.includeCandidates } as {
          title: string;
          includeCandidates: boolean;
          requestId: string;
          rosterId?: string;
          rosterRevision?: number;
        };
    } catch {
      /* Storage may be disabled. */
    }
    return {
      title: `${title.slice(0, 168)} — new run`,
      includeCandidates: !legacy,
      requestId: browserId(),
      rosterId: undefined as string | undefined,
      rosterRevision: undefined as number | undefined,
    };
  });
  const [rosters, setRosters] = useState<RosterSummary[] | null>(null);
  const [rosterError, setRosterError] = useState('');
  const loadRosters = () => {
    setRosterError('');
    void api<{ rosters: RosterSummary[] }>('/rosters')
      .then((r) => setRosters(r.rosters.filter((roster) => !roster.archived)))
      .catch((e) => setRosterError(errorMessage(e)));
  };
  useEffect(loadRosters, []);
  const candidateMode =
    draft.rosterId !== undefined ? 'roster' : draft.includeCandidates ? 'previous' : 'none';
  const selectedRoster = rosters?.find((r) => r.id === draft.rosterId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(draft));
    } catch {
      /* Request ID still protects retries within this dialog. */
    }
  }, [key, draft]);
  return (
    <Dialog
      title="Run this assessment again"
      confirmLabel="Prepare new run"
      busy={busy}
      confirmDisabled={
        !draft.title.trim() ||
        draft.title.length > 180 ||
        (candidateMode === 'roster' &&
          (!selectedRoster ||
            !selectedRoster.approved ||
            selectedRoster.revision !== draft.rosterRevision))
      }
      onClose={onClose}
      confirm={async () => {
        setBusy(true);
        setError('');
        try {
          const result = await api<{ id: string }>(`/assessments/${id}/rerun`, {
            method: 'POST',
            body: draft,
          });
          try {
            sessionStorage.removeItem(key);
          } catch {}
          location.href = `/assessments/${result.id}/edit`;
        } catch (e) {
          setError(errorMessage(e));
          setBusy(false);
        }
      }}
    >
      <p>
        A new assessment will be prepared with the same questions and settings. Previous attempts,
        marks and results stay unchanged.
      </p>
      {error && <Notice>{error}</Notice>}
      <fieldset className="assessment-fields" disabled={busy}>
        <label>
          New assessment title
          <input
            maxLength={180}
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </label>
        <label>
          Who will take this assessment?
          <select
            value={candidateMode}
            onChange={(e) =>
              setDraft({
                ...draft,
                includeCandidates: e.target.value === 'previous',
                rosterId: e.target.value === 'roster' ? '' : undefined,
                rosterRevision: undefined,
              })
            }
          >
            {!legacy && <option value="previous">Previous approved candidates</option>}
            <option value="roster">Choose a roster</option>
            <option value="none">Invite candidates later</option>
          </select>
        </label>
        {candidateMode === 'roster' && (
          <>
            <label>
              Roster
              <select
                value={draft.rosterId ?? ''}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    rosterId: e.target.value,
                    rosterRevision: rosters?.find((r) => r.id === e.target.value)?.revision,
                  })
                }
              >
                <option value="">{rosters ? 'Select a roster' : 'Loading rosters…'}</option>
                {rosters?.map((r) => (
                  <option key={r.id} value={r.id} disabled={!r.approved}>
                    {r.name} · {r.approved} approved
                  </option>
                ))}
              </select>
            </label>
            {selectedRoster && (
              <p className="field-hint">
                {selectedRoster.approved} approved members will be enrolled. Pending requests are
                not included.
              </p>
            )}
            {selectedRoster && selectedRoster.revision !== draft.rosterRevision && (
              <p role="status">
                Membership has changed. Choose the roster again to confirm its current members.
              </p>
            )}
            {rosters?.length === 0 && (
              <p className="field-hint">
                No active rosters yet. You can invite candidates later or create a roster first.
              </p>
            )}
            {rosterError && <Notice>{rosterError}</Notice>}
            <button type="button" className="text-button" onClick={loadRosters}>
              Refresh rosters
            </button>
          </>
        )}
      </fieldset>
      <p className="field-hint">
        {candidateMode === 'roster'
          ? 'The new run uses the roster’s current approved members. Later membership changes do not automatically change this participant list.'
          : legacy
            ? 'Previous access keys are not reused. Invite candidates with their accounts for the new run.'
            : draft.includeCandidates
              ? 'This uses the previous participant list, not the roster’s current membership. Candidates will see a new upcoming assessment.'
              : 'The new run starts with no candidates. Open its registration link when you are ready to invite them.'}
      </p>
      <p className="field-hint">
        Registration starts closed. You can edit the paper before starting; the timer does not start
        now.
      </p>
    </Dialog>
  );
}
