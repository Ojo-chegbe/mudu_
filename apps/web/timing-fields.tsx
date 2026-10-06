import { useEffect, useId, useState } from 'react';
import type { TimingSettings } from '../../packages/exam-core/model.ts';
import { sharedTiming } from '../../packages/exam-core/timing.ts';
import { scheduleDay, scheduleLabel, scheduleParts, scheduleTimestamp } from './schedule-input.ts';

export function ScheduleField({
  title,
  hint,
  value,
  minimum,
  onChange,
  shortcuts = false,
}: {
  title: string;
  hint: string;
  value: number | null;
  minimum?: number | null;
  onChange: (value: number | null) => void;
  shortcuts?: boolean;
}) {
  const id = useId();
  const [parts, setParts] = useState(() => scheduleParts(value));
  useEffect(() => {
    if (value) setParts(scheduleParts(value));
  }, [value]);
  function change(next: { date: string; time: string }) {
    setParts(next);
    onChange(scheduleTimestamp(next.date, next.time));
  }
  const min = scheduleParts(minimum);
  return (
    <fieldset className="schedule-field" aria-describedby={`${id}-hint`}>
      <legend>{title}</legend>
      <p className="field-hint" id={`${id}-hint`}>
        {hint}
      </p>
      <div className="schedule-input-pair">
        <label htmlFor={`${id}-date`}>
          Date
          <input
            id={`${id}-date`}
            type="date"
            required
            value={parts.date}
            min={min.date || undefined}
            onChange={(e) => change({ ...parts, date: e.target.value })}
          />
        </label>
        <label htmlFor={`${id}-time`}>
          Time
          <input
            id={`${id}-time`}
            type="time"
            required
            value={parts.time}
            min={parts.date === min.date ? min.time || undefined : undefined}
            onChange={(e) => change({ ...parts, time: e.target.value })}
          />
        </label>
      </div>
      {shortcuts && (
        <div className="schedule-shortcuts" aria-label={`${title} shortcuts`}>
          {[
            ['Today', 0],
            ['Tomorrow', 1],
          ].map(([label, offset]) => (
            <button
              key={label}
              type="button"
              className="schedule-shortcut"
              onClick={() =>
                change({ date: scheduleDay(Number(offset)), time: parts.time || '09:00' })
              }
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {parts.date && parts.time && scheduleTimestamp(parts.date, parts.time) === null && (
        <p className="schedule-error" role="alert">
          Choose a valid date and time.
        </p>
      )}
    </fieldset>
  );
}
export function TimingFields({
  value,
  duration,
  onChange,
}: {
  value?: TimingSettings;
  duration: number;
  onChange: (value: TimingSettings) => void;
}) {
  const timing = value ?? sharedTiming();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone.replaceAll('_', ' ');
  const invalidWindow =
    timing.opensAt !== null && timing.lastStartAt !== null && timing.lastStartAt <= timing.opensAt;
  const invalidFinish =
    timing.finishBy !== null &&
    timing.lastStartAt !== null &&
    timing.finishBy <= timing.lastStartAt;
  const shortened =
    timing.finishBy !== null &&
    timing.lastStartAt !== null &&
    timing.finishBy < timing.lastStartAt + duration * 60000;
  return (
    <div className="assessment-timing-fields">
      <h3>Timing</h3>
      <div className="timing-mode-options" role="group" aria-label="Examination timing">
        {(['shared', 'individual'] as const).map((mode) => (
          <button
            type="button"
            key={mode}
            className={'timing-mode-option' + (timing.mode === mode ? ' selected' : '')}
            aria-pressed={timing.mode === mode}
            onClick={() => {
              if (mode === timing.mode) return;
              const now = Math.floor(Date.now() / 60000) * 60000;
              onChange(
                mode === 'shared'
                  ? sharedTiming()
                  : { mode, opensAt: now, lastStartAt: now + 86400000, finishBy: null },
              );
            }}
          >
            <strong>{mode === 'shared' ? 'Shared start' : 'Individual start'}</strong>
            <span>
              {mode === 'shared'
                ? 'One deadline for everyone. Late starters get the time remaining.'
                : `Each candidate gets ${duration || 60} minutes from clicking Begin examination.`}
            </span>
          </button>
        ))}
      </div>
      {timing.mode === 'individual' && (
        <>
          <div className="schedule-heading">
            <h3>When can candidates begin?</h3>
            <span>{timezone}</span>
          </div>
          <div className="schedule-window">
            <ScheduleField
              title="Opens"
              hint="Candidates can begin from this time."
              value={timing.opensAt}
              shortcuts
              onChange={(opensAt) => onChange({ ...timing, opensAt })}
            />
            <ScheduleField
              title="Last chance to begin"
              hint="Candidates already taking the exam can continue."
              value={timing.lastStartAt}
              minimum={timing.opensAt}
              onChange={(lastStartAt) => onChange({ ...timing, lastStartAt })}
            />
          </div>
          <div
            className="schedule-shortcuts schedule-window-shortcuts"
            aria-label="Start window length"
          >
            <span>Keep starting open for</span>
            {[
              ['1 hour', 60],
              ['1 day', 1440],
              ['1 week', 10080],
            ].map(([label, minutes]) => (
              <button
                type="button"
                key={label}
                className="schedule-shortcut"
                disabled={!timing.opensAt}
                aria-pressed={Boolean(
                  timing.opensAt && timing.lastStartAt === timing.opensAt + Number(minutes) * 60000,
                )}
                onClick={() =>
                  onChange({ ...timing, lastStartAt: timing.opensAt! + Number(minutes) * 60000 })
                }
              >
                {label}
              </button>
            ))}
          </div>
          {invalidWindow && (
            <p className="schedule-error" role="alert">
              The last start time must be after opening.
            </p>
          )}
          <div className="schedule-finish">
            <label className="check-label">
              <input
                type="checkbox"
                checked={timing.finishBy !== null}
                onChange={(e) =>
                  onChange({
                    ...timing,
                    finishBy: e.target.checked
                      ? (timing.lastStartAt ?? Date.now()) + duration * 60000
                      : null,
                  })
                }
              />
              <span>
                End all attempts at a fixed time{' '}
                <small>
                  Optional. Otherwise, each candidate gets their full {duration} minutes.
                </small>
              </span>
            </label>
            {timing.finishBy !== null && (
              <div className="schedule-finish-input">
                <ScheduleField
                  title="Everyone finishes by"
                  hint="This deadline can shorten a late starter’s time."
                  value={timing.finishBy}
                  minimum={timing.lastStartAt}
                  onChange={(finishBy) => onChange({ ...timing, finishBy: finishBy ?? 0 })}
                />
                <button
                  type="button"
                  className="text-button"
                  disabled={!timing.lastStartAt || duration <= 0}
                  onClick={() =>
                    onChange({ ...timing, finishBy: timing.lastStartAt! + duration * 60000 })
                  }
                >
                  Allow full time for the last starter
                </button>
              </div>
            )}
            {invalidFinish && (
              <p className="schedule-error" role="alert">
                The finish deadline must be after the last start time.
              </p>
            )}
            {shortened && !invalidFinish && (
              <p className="timing-shortening-warning" role="status">
                Candidates starting near the last start time will have less than {duration} minutes
                because of the finish-by deadline.
              </p>
            )}
          </div>
          {timing.opensAt &&
            timing.lastStartAt &&
            !invalidWindow &&
            !invalidFinish &&
            timing.finishBy !== 0 && (
              <div className="schedule-preview" role="status">
                <strong>
                  Candidates can begin {scheduleLabel(timing.opensAt)} –{' '}
                  {scheduleLabel(timing.lastStartAt)}.
                </strong>
                <p>
                  {timing.finishBy
                    ? `Each gets up to ${duration} minutes. All attempts end by ${scheduleLabel(timing.finishBy)}.`
                    : `Each gets ${duration} minutes, even if they begin just before starting closes.`}
                </p>
              </div>
            )}
        </>
      )}
    </div>
  );
}
export function LateAdmissionField({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <label className="check-label late-admission-field">
      <input type="checkbox" checked={enabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        Allow new candidates after opening
        <small>
          Newly approved roster members can join while the start window is open. Existing candidates
          keep their access.
        </small>
      </span>
    </label>
  );
}
export function TimingSummary({ timing, duration }: { timing?: TimingSettings; duration: number }) {
  return (
    <>
      <div>
        <dt>Timer</dt>
        <dd>
          {timing?.mode === 'individual' ? `${duration} minutes per candidate` : 'Shared deadline'}
        </dd>
      </div>
      {timing?.mode === 'individual' && (
        <>
          <div>
            <dt>Open from</dt>
            <dd>{timing.opensAt ? new Date(timing.opensAt).toLocaleString() : 'Not set'}</dd>
          </div>
          <div>
            <dt>Last start</dt>
            <dd>
              {timing.lastStartAt ? new Date(timing.lastStartAt).toLocaleString() : 'Not set'}
            </dd>
          </div>
          <div>
            <dt>Finish by</dt>
            <dd>
              {timing.finishBy
                ? new Date(timing.finishBy).toLocaleString()
                : 'Each candidate’s deadline'}
            </dd>
          </div>
        </>
      )}
    </>
  );
}
