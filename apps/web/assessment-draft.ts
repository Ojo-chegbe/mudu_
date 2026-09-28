// Tab-scoped storage: exam content must not linger in shared localStorage.
export const draftKey = 'mudu.assessment-draft.v1';

export function readDraft<T>(
  storage: Pick<Storage, 'getItem'>,
  validate: (value: unknown) => value is T,
): T | null {
  const raw = storage.getItem(draftKey);
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (!validate(value)) throw new Error('Unrecognized draft');
  return value;
}

export function writeDraft(storage: Pick<Storage, 'setItem'>, value: unknown): boolean {
  try {
    storage.setItem(draftKey, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
