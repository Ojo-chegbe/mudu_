import { draftKey } from './assessment-draft.ts';

export const draftOwnerKey = 'mudu.admin-draft-owner';
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

export function clearWorkspaceDrafts(storage: DraftStorage) {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (
      key &&
      (key === draftKey ||
        key === draftOwnerKey ||
        key.startsWith('mudu.roster-draft.') ||
        key.startsWith('mudu.assessment-edit.') ||
        key.startsWith('mudu.authoring-revision.') ||
        key.startsWith('mudu.assessment-rerun.') ||
        key.startsWith('mudu.bank-'))
    )
      keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}

export function selectDraftWorkspace(
  storage: DraftStorage,
  administratorId: string,
  preserveLegacyDrafts = false,
) {
  const previous = storage.getItem(draftOwnerKey);
  // Preserve the existing local administrator's drafts on the first upgrade.
  if (previous !== administratorId && (previous || !preserveLegacyDrafts))
    clearWorkspaceDrafts(storage);
  storage.setItem(draftOwnerKey, administratorId);
}
