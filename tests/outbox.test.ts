import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnswerOutbox } from '../apps/web/outbox.ts';
import type { PendingAnswer, QueueStorage } from '../apps/web/outbox.ts';

function storage(): QueueStorage {
  let persisted: PendingAnswer[] = [];
  return {
    load: async () => structuredClone(persisted),
    save: async (entries) => {
      persisted = structuredClone(entries);
    },
  };
}
async function idle(queue: AnswerOutbox) {
  for (let i = 0; i < 100 && queue.flushing; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(queue.flushing, false);
}
test('failed saves survive browser recreation and retry with the same operation ID', async () => {
  const disk = storage();
  const original = new AnswerOutbox({
    responses: {},
    storage: disk,
    send: async () => {
      throw new Error('offline');
    },
    changed: () => {},
    saved: () => {},
  });
  await original.initialize();
  await original.choose('q1', ['b']);
  await idle(original);
  const operation = original.entries[0].operationId;
  original.dispose();
  const retried: PendingAnswer[] = [];
  const recovered = new AnswerOutbox({
    responses: {},
    storage: disk,
    send: async (entry) => {
      retried.push(entry);
      return { revision: 1, savedAt: 10 };
    },
    changed: () => {},
    saved: () => {},
  });
  await recovered.initialize();
  await recovered.flush();
  assert.equal(retried[0].operationId, operation);
  assert.equal(recovered.entries.length, 0);
  assert.deepEqual(await disk.load(), []);
});
test('new input does not replace an in-flight request whose acknowledgment might be lost', async () => {
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const received: PendingAnswer[] = [];
  const queue = new AnswerOutbox({
    responses: {},
    storage: storage(),
    send: async (entry) => {
      received.push(structuredClone(entry));
      if (received.length === 1) await wait;
      return { revision: entry.expectedRevision + 1, savedAt: 100 };
    },
    changed: () => {},
    saved: () => {},
  });
  await queue.initialize();
  await queue.choose('q1', ['a']);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await queue.choose('q1', ['b']);
  assert.deepEqual(queue.entries[0].value, ['a']);
  assert.deepEqual(queue.entries[0].nextValue, ['b']);
  finish();
  await idle(queue);
  assert.equal(received.length, 2);
  assert.deepEqual(received[1].value, ['b']);
  assert.equal(received[1].expectedRevision, 1);
  assert.notEqual(received[1].operationId, received[0].operationId);
  assert.equal(queue.entries.length, 0);
});
test('failed browser persistence never reports an answer as queued or saved', async () => {
  let calls = 0;
  const queue = new AnswerOutbox({
    responses: {},
    storage: {
      load: async () => [],
      save: async () => {
        throw new Error('quota');
      },
    },
    send: async () => {
      calls++;
      return { revision: 1, savedAt: 0 };
    },
    changed: () => {},
    saved: () => {},
  });
  await queue.initialize();
  await assert.rejects(queue.choose('q1', ['a']), /quota/);
  assert.equal(queue.entries.length, 0);
  assert.equal(calls, 0);
});
