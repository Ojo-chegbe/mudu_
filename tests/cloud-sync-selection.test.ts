import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queueSelectedExams, selectableExams } from '../apps/web/cloud-sync-selection.ts';
import type { SyncItem } from '../packages/contracts/cloud-sync.ts';

const item = (assessmentId: string, state: SyncItem['state']): SyncItem => ({
  id: `job-${assessmentId}-${state}`,
  assessmentId,
  state,
  title: assessmentId,
  uploaded: 0,
  total: 1,
  error: null,
  syncedAt: null,
  revision: null,
});

test('Select all includes completed records eligible for sync and skips every unfinished job', () => {
  const ids = ['new', 'synced', 'pending', 'uploading', 'retry', 'conflict'];
  const status = {
    ready: ids.map((id) => ({ id, title: id, candidateCount: 1 })),
    items: [
      item('synced', 'synced'),
      item('pending', 'pending'),
      item('uploading', 'uploading'),
      item('retry', 'retry'),
      item('conflict', 'conflict'),
      item('conflict', 'synced'),
      item('not-in-completed-list', 'synced'),
    ],
  };
  assert.deepEqual(selectableExams(status), ['new', 'synced']);
  assert.deepEqual(selectableExams({ ready: [], items: [] }), []);
});

test('Select all queues more than twenty exams in bounded, sequential batches', async () => {
  const ids = Array.from({ length: 47 }, (_, i) => `exam-${i}`);
  const events: string[] = [];
  const accepted: string[] = [];
  await queueSelectedExams(
    ids,
    async (batch) => {
      events.push(`send:${batch.length}`);
      assert.ok(batch.length <= 20);
      await Promise.resolve();
      events.push(`accepted:${batch.length}`);
    },
    (batch) => {
      events.push(`ack:${batch.length}`);
      accepted.push(...batch);
    },
  );
  assert.deepEqual(accepted, ids);
  assert.deepEqual(events, [
    'send:20',
    'accepted:20',
    'ack:20',
    'send:20',
    'accepted:20',
    'ack:20',
    'send:7',
    'accepted:7',
    'ack:7',
  ]);
});

test('failed batches stop queueing and preserve failed and unattempted selections for retry', async () => {
  const ids = Array.from({ length: 45 }, (_, i) => `exam-${i}`);
  const remaining = new Set(ids);
  let requests = 0;
  await assert.rejects(
    queueSelectedExams(
      ids,
      async () => {
        if (++requests === 2) throw new Error('Connection lost');
      },
      (batch) => {
        for (const id of batch) remaining.delete(id);
      },
    ),
    /Connection lost/,
  );
  assert.equal(requests, 2);
  assert.deepEqual([...remaining], ids.slice(20));
  const retried: string[] = [];
  await queueSelectedExams(
    [...remaining],
    async () => {},
    (batch) => retried.push(...batch),
  );
  assert.deepEqual(retried, ids.slice(20));
});

test('empty selections make no request and duplicate IDs are queued only once', async () => {
  const batches: string[][] = [];
  await queueSelectedExams(
    [],
    async (batch) => {
      batches.push(batch);
    },
    () => {},
  );
  assert.equal(batches.length, 0);
  await queueSelectedExams(
    ['one', 'one', 'two'],
    async (batch) => {
      batches.push(batch);
    },
    () => {},
  );
  assert.deepEqual(batches, [['one', 'two']]);
});
