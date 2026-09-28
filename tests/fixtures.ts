import { randomUUID } from 'node:crypto';
import { parseAssessment } from '../packages/exam-core/engine.ts';

export function input() {
  return {
    title: 'Foundations assessment',
    course: 'MUD 101',
    instructions: 'Read each question carefully.',
    durationMinutes: 60,
    passPercent: 50,
    shuffleQuestions: true,
    shuffleOptions: true,
    questions: [
      {
        type: 'single',
        prompt: 'What is 2 + 2?',
        marks: 2,
        options: ['3', '4', '5', '6'],
        correctIndices: [1],
      },
      {
        type: 'multiple',
        prompt: 'Select the prime numbers.',
        marks: 3,
        options: ['2', '3', '4', '6'],
        correctIndices: [0, 1],
      },
    ],
    candidates: [
      { identifier: 'MUD/001', name: 'Test Candidate', credential: 'candidate-key-123' },
    ],
  };
}
export function assessment() {
  return parseAssessment(input(), randomUUID).assessment;
}
