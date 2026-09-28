import { openDatabase } from '../apps/host/database.ts';
import { ExamStore } from '../apps/host/store.ts';
import { assessment } from './fixtures.ts';

const db = openDatabase(process.argv[2]);
const store = new ExamStore(db);
const exam = assessment();
store.createAssessment(
  exam,
  [{ id: 'crash-candidate', identifier: 'C1', name: 'Crash test', hash: 'test-only' }],
  'admin',
);
const sitting = store.launch(exam.id, 'admin');
const attempt = store.start(sitting.id, 'crash-candidate');
store.save(sitting.id, 'crash-candidate', exam.questions[0].id, {
  value: exam.questions[0].correctOptionIds,
  expectedRevision: 0,
  operationId: 'acknowledged-before-kill',
});
process.stdout.write(
  JSON.stringify({
    attemptId: attempt.id,
    sittingId: sitting.id,
    questionId: exam.questions[0].id,
    answer: exam.questions[0].correctOptionIds,
  }) + '\n',
);
// The parent intentionally terminates the process before a graceful DB close.
setInterval(() => {}, 1000);
