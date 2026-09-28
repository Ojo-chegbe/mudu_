import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../apps/host/database.ts';
import { ExamStore } from '../apps/host/store.ts';
import type { Session } from '../apps/host/store.ts';
import { notificationFeed, readNotifications } from '../apps/host/notifications.ts';
import { assessment } from './fixtures.ts';

test('written submissions produce deduplicated, recipient-scoped notifications with durable read state', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const store = new ExamStore(db, () => 1000000);
  const exam = assessment();
  exam.questions.push({
    id: 'essay',
    type: 'short',
    prompt: 'Explain.',
    marks: 5,
    options: [],
    correctOptionIds: [],
  });
  store.createAssessment(
    exam,
    [{ id: 'writer', identifier: 'W1', name: 'Writer', hash: 'test' }],
    'admin',
  );
  const sitting = store.launch(exam.id, 'admin');
  store.start(sitting.id, 'writer');
  const admin: Session = {
    role: 'admin',
    principal_id: 'admin',
    sitting_id: null,
    csrf: '',
    expires_at: 99999999,
    account_id: null,
  };
  assert.equal(notificationFeed(db, admin).unread, 0);
  store.save(sitting.id, 'writer', 'essay', {
    value: 'My answer',
    expectedRevision: 0,
    operationId: 'save-essay',
  });
  store.submit(sitting.id, 'writer');
  const feed = notificationFeed(db, admin);
  assert.equal(feed.unread, 1);
  assert.equal(feed.items[0].title, 'Written submission received');
  assert.equal(feed.items[0].href, `/assessments/${exam.id}?tab=results`);
  assert.equal(notificationFeed(db, admin).items.length, 1);
  readNotifications(db, { ...admin, principal_id: 'other' }, [feed.items[0].id], 1000001);
  assert.equal(notificationFeed(db, admin).unread, 1);
  readNotifications(db, admin, [feed.items[0].id], 1000002);
  assert.equal(notificationFeed(db, admin).unread, 0);
  assert.equal(notificationFeed(db, admin).items[0].readAt, 1000002);
  store.mark(exam.id, 'writer', { questionId: 'essay', score: 4, expectedRevision: 0 }, 'admin');
  assert.equal(notificationFeed(db, admin).items.length, 1);
  assert.equal(notificationFeed(db, admin).unread, 0);
  assert.throws(() => notificationFeed(db, { ...admin, role: 'candidate' }), /account/);
});
