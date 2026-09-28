import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createOrder,
  grade,
  parseAssessment,
  validateAnswer,
} from '../packages/exam-core/engine.ts';
import { parseCsv, writeCsv } from '../packages/exam-core/csv.ts';
import { assessment, input } from './fixtures.ts';

test('validation rejects duplicate normalized candidate IDs and invalid answer keys', () => {
  const payload = input();
  payload.candidates.push({ ...payload.candidates[0], identifier: ' mud/001 ' });
  assert.throws(() => parseAssessment(payload, randomUUID), /unique/);
  const invalid = input();
  invalid.questions[0].correctIndices = [20];
  assert.throws(() => parseAssessment(invalid, randomUUID), /correct answers/);
});
test('objective grading uses stable IDs and exact matches for multiple select', () => {
  const exam = assessment();
  const [single, multiple] = exam.questions;
  const result = grade(exam, {
    [single.id]: { revision: 1, value: single.correctOptionIds },
    [multiple.id]: { revision: 1, value: [...multiple.correctOptionIds].reverse() },
  });
  assert.equal(result.objectiveScore, 5);
  assert.equal(result.percentage, 100);
  assert.equal(result.passed, true);
  assert.equal(
    grade(exam, { [multiple.id]: { revision: 1, value: multiple.correctOptionIds.slice(0, 1) } })
      .objectiveScore,
    0,
  );
});
test('short answers are explicitly provisional until manually graded', () => {
  const exam = assessment();
  exam.questions.push({
    id: 'short',
    type: 'short',
    prompt: 'Explain.',
    marks: 4,
    options: [],
    correctOptionIds: [],
  });
  const result = grade(exam, { short: { value: 'A response', revision: 1 } });
  assert.equal(result.pendingManual, 1);
  assert.equal(result.percentage, null);
  assert.equal(result.passed, null);
});
test('invalid choices, duplicate choices, and oversized text are rejected', () => {
  const [question] = assessment().questions;
  assert.throws(() => validateAnswer(question, ['foreign-option']), /valid options/);
  assert.throws(
    () => validateAnswer(question, [question.options[0].id, question.options[0].id]),
    /valid options/,
  );
  assert.throws(() => validateAnswer({ ...question, type: 'short' }, 'a'.repeat(10001)), /10,000/);
});
test('randomization preserves every question and option without altering assessment content', () => {
  const exam = assessment();
  const before = structuredClone(exam);
  const order = createOrder(exam, () => 0);
  assert.deepEqual(exam, before);
  assert.deepEqual(order.map((q) => q.questionId).sort(), exam.questions.map((q) => q.id).sort());
  for (const entry of order)
    assert.deepEqual(
      [...entry.optionIds].sort(),
      exam.questions
        .find((q) => q.id === entry.questionId)!
        .options.map((o) => o.id)
        .sort(),
    );
});
test('CSV imports quoted commas, escaped quotes, CRLF and embedded newlines', () => {
  assert.deepEqual(
    parseCsv('\uFEFFcandidate_id,name\r\nA,"Doe, Jane"\r\nB,"Jo ""Jay""\nSmith"\r\n'),
    [
      ['candidate_id', 'name'],
      ['A', 'Doe, Jane'],
      ['B', 'Jo "Jay"\nSmith'],
    ],
  );
  assert.throws(() => parseCsv('name\n"unfinished'), /unclosed/);
  assert.throws(() => parseCsv('name\n"value"garbage'), /quoting/);
});
test('CSV exports neutralize formula-like cells', () => {
  const csv = writeCsv([['name'], ['=HYPERLINK("malicious")'], ['+SUM(1,2)'], ['Normal name']]);
  const rows = parseCsv(csv);
  assert.equal(rows[1][0][0], "'");
  assert.equal(rows[2][0][0], "'");
  assert.equal(rows[3][0], 'Normal name');
});
