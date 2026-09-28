// One live provider request using synthetic material only. No production database is opened.
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../apps/host/database.ts';
import { ExamStore } from '../apps/host/store.ts';
import { QuestionGeneration, googleGenerate } from '../apps/host/question-generation.ts';
import { DomainError } from '../packages/exam-core/model.ts';

const db = openDatabase(':memory:');
try {
  const ai = new QuestionGeneration(new ExamStore(db), async (key, prompt) => {
    const output = await googleGenerate(key, prompt);
    // Explicit diagnostics contain only output from the synthetic source below.
    if (process.argv.includes('--show-output')) console.log(output);
    return output;
  });
  const result = await ai.generate('smoke-test', {
    requestId: randomUUID(),
    consent: true,
    count: 2,
    type: 'single',
    difficulty: 'easy',
    course: 'Reading comprehension',
    topic: 'Community garden',
    source:
      'The fictional Maple Community Garden opens at eight in the morning and closes at six in the evening. Volunteers water the vegetables every morning. The garden has three raised beds. Tomatoes grow in the first bed, carrots in the second bed, and beans in the third bed. Visitors must stay on the paths. Tools are stored in the blue shed after use. On Saturdays, volunteers collect ripe vegetables and share them with neighbours.',
  });
  console.log(JSON.stringify({ status: result.status, drafts: result.questionIds.length }));
} catch (error) {
  console.error(
    error instanceof DomainError
      ? JSON.stringify({ status: error.status, code: error.code, message: error.message })
      : 'AI smoke test failed.',
  );
  process.exitCode = 1;
} finally {
  db.close();
}
