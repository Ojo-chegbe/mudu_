import type { Answer, ResponseValue } from '../../packages/exam-core/model.ts';
import { browserId } from './browser-id.ts';

export interface PendingAnswer {
  questionId: string;
  operationId: string;
  expectedRevision: number;
  value: Answer;
  nextValue?: Answer;
}
export interface QueueStorage {
  load: () => Promise<PendingAnswer[]>;
  save: (entries: PendingAnswer[]) => Promise<void>;
}
type SendAnswer = (entry: PendingAnswer) => Promise<{ revision: number; savedAt: number }>;
const same = (a: Answer, b: Answer) => JSON.stringify(a) === JSON.stringify(b);

// An in-flight operation is never overwritten. Its replacement waits for the
// original acknowledgment, including after a connection loss or page reload.
export class AnswerOutbox {
  entries: PendingAnswer[] = [];
  revisions: Record<string, number>;
  storage: QueueStorage;
  send: SendAnswer;
  changed: () => void;
  saved: (entry: PendingAnswer, revision: number) => void;
  serial: Promise<void> = Promise.resolve();
  flushing = false;
  disposed = false;
  error: unknown = null;
  constructor(options: {
    responses: Record<string, ResponseValue>;
    storage: QueueStorage;
    send: SendAnswer;
    changed: () => void;
    saved: (entry: PendingAnswer, revision: number) => void;
  }) {
    this.revisions = Object.fromEntries(
      Object.entries(options.responses).map(([id, response]) => [id, response.revision]),
    );
    this.storage = options.storage;
    this.send = options.send;
    this.changed = options.changed;
    this.saved = options.saved;
  }
  async initialize() {
    this.entries = await this.storage.load();
    this.changed();
  }
  mutate(action: (entries: PendingAnswer[]) => PendingAnswer[]) {
    const task = this.serial.then(async () => {
      const next = action(structuredClone(this.entries));
      await this.storage.save(next);
      this.entries = next;
      if (!this.disposed) this.changed();
    });
    this.serial = task.catch(() => {});
    return task;
  }
  async choose(questionId: string, value: Answer) {
    await this.mutate((entries) => {
      const current = entries.find((entry) => entry.questionId === questionId);
      if (current) current.nextValue = value;
      else
        entries.push({
          questionId,
          value,
          operationId: browserId(),
          expectedRevision: this.revisions[questionId] ?? 0,
        });
      return entries;
    });
    void this.flush();
  }
  async flush() {
    if (this.flushing || this.disposed) return;
    this.flushing = true;
    try {
      await this.serial;
      while (this.entries.length && !this.disposed) {
        const entry = structuredClone(this.entries[0]);
        const receipt = await this.send(entry);
        await this.mutate((entries) => {
          const current = entries.find((e) => e.operationId === entry.operationId);
          if (!current) return entries;
          this.revisions[entry.questionId] = receipt.revision;
          if (current.nextValue !== undefined && !same(current.value, current.nextValue)) {
            current.value = current.nextValue;
            delete current.nextValue;
            current.expectedRevision = receipt.revision;
            current.operationId = browserId();
            return entries;
          }
          return entries.filter((e) => e.operationId !== entry.operationId);
        });
        this.error = null;
        if (!this.disposed) this.saved(entry, receipt.revision);
      }
    } catch (error) {
      this.error = error;
    } finally {
      this.flushing = false;
      if (!this.disposed) this.changed();
    }
  }
  async clear() {
    await this.mutate(() => []);
  }
  dispose() {
    this.disposed = true;
  }
}

export function browserQueueStorage(attemptId: string): QueueStorage {
  let connection: Promise<IDBDatabase> | undefined;
  function open() {
    if (!connection)
      connection = new Promise((resolve, reject) => {
        const request = indexedDB.open('mudu-pending-answers', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('attempts');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
          reject(
            new Error(
              'This browser cannot preserve pending answers. Enable site storage before continuing.',
            ),
          );
        request.onblocked = () =>
          reject(new Error('Close other MUDU tabs and reload to enable answer recovery.'));
      });
    return connection;
  }
  return {
    async load() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const request = db.transaction('attempts').objectStore('attempts').get(attemptId);
        request.onsuccess = () => resolve(request.result ?? []);
        request.onerror = () => reject(request.error);
      });
    },
    async save(entries) {
      const db = await open();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('attempts', 'readwrite');
        const store = transaction.objectStore('attempts');
        if (entries.length) store.put(entries, attemptId);
        else store.delete(attemptId);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('Pending answer storage was interrupted.'));
      });
    },
  };
}
