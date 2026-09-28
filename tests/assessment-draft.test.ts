import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftKey, readDraft, writeDraft } from '../apps/web/assessment-draft.ts';

test('draft storage restores the review step, answers, roster, and stable save identifier', () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
  const draft = {
    step: 3,
    questions: [{ prompt: 'Question', correctIndices: [1] }],
    candidates: [{ name: 'Candidate' }],
    requestId: 'stable-id',
  };
  const valid = (value: unknown): value is typeof draft =>
    typeof value === 'object' && value !== null && 'requestId' in value;
  assert.equal(readDraft(storage, valid), null);
  assert.equal(writeDraft(storage, draft), true);
  assert.deepEqual(readDraft(storage, valid), draft);
  assert.deepEqual(JSON.parse(data.get(draftKey)!), draft);
});

test('draft storage reports quota failures and rejects damaged data instead of claiming recovery', () => {
  assert.equal(
    writeDraft(
      {
        setItem: () => {
          throw new Error('quota');
        },
      },
      {},
    ),
    false,
  );
  assert.throws(() => readDraft({ getItem: () => '{broken' }, (_): _ is object => true));
  assert.throws(() => readDraft({ getItem: () => '{}' }, (_): _ is object => false));
});
