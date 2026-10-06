import { DomainError } from './model.ts';
import type { Assessment, TimingSettings } from './model.ts';

export const sharedTiming = (): TimingSettings => ({
  mode: 'shared',
  opensAt: null,
  lastStartAt: null,
  finishBy: null,
});
export function parseTiming(value: unknown): TimingSettings {
  if (value === undefined) return sharedTiming();
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DomainError('Choose examination timing.');
  const t = value as Record<string, unknown>;
  if (t.mode !== 'shared' && t.mode !== 'individual')
    throw new DomainError('Choose shared or individual timing.');
  if (t.mode === 'shared') return sharedTiming();
  const timestamp = (value: unknown, label: string, optional = false): number | null => {
    if (optional && (value === null || value === undefined)) return null;
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > 8640000000000000
    )
      throw new DomainError(`Choose a valid ${label} date and time.`);
    return value;
  };
  const opensAt = timestamp(t.opensAt, 'opening')!;
  const lastStartAt = timestamp(t.lastStartAt, 'last start')!;
  const finishBy = timestamp(t.finishBy, 'finish by', true);
  if (lastStartAt <= opensAt)
    throw new DomainError('Last start time must be after the opening time.');
  if (finishBy !== null && finishBy <= lastStartAt)
    throw new DomainError('Finish by must be after the last start time.');
  return { mode: 'individual', opensAt, lastStartAt, finishBy };
}
export function sittingDeadline(assessment: Assessment, startedAt: number) {
  const t = assessment.timing ?? sharedTiming();
  return t.mode === 'shared'
    ? startedAt + assessment.durationMinutes * 60000
    : Math.min(t.lastStartAt! + assessment.durationMinutes * 60000, t.finishBy ?? Infinity);
}
export function admissionWindow(
  assessment: Assessment,
  startedAt: number,
  deadline: number,
  now: number,
) {
  const t = assessment.timing ?? sharedTiming();
  const opensAt = t.mode === 'individual' ? Math.max(startedAt, t.opensAt!) : startedAt;
  const lastStartAt = t.mode === 'individual' ? Math.min(t.lastStartAt!, deadline) : deadline;
  const startRestriction =
    now < opensAt ? ('not_open' as const) : now >= lastStartAt ? ('closed' as const) : null;
  return {
    mode: t.mode,
    opensAt,
    lastStartAt,
    finishBy: t.finishBy,
    canStart: startRestriction === null,
    startRestriction,
  };
}
export function candidateDeadline(assessment: Assessment, deadline: number, now: number) {
  return assessment.timing?.mode === 'individual'
    ? Math.min(now + assessment.durationMinutes * 60000, deadline)
    : deadline;
}
