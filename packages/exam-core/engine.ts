import { DomainError } from './model.ts';
import { parseTiming } from './timing.ts';
import type {
  Answer,
  Assessment,
  CandidateInput,
  Grade,
  Question,
  ResponseValue,
} from './model.ts';

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DomainError('Expected an object.');
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string, max = 500, min = 1): string {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    throw new DomainError(`${label} must contain ${min}–${max} characters.`);
  }
  return value.trim();
}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new DomainError(`${label} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}
export function identifier(value: unknown): string {
  return text(value, 'Candidate ID', 80).normalize('NFKC').toUpperCase();
}
export function parseAssessment(
  value: unknown,
  newId: () => string,
): { assessment: Assessment; candidates: CandidateInput[] } {
  const input = object(value);
  const accounts = input.accessMode === 'accounts';
  if (
    input.accessMode !== undefined &&
    !['accounts', 'legacy'].includes(String(input.accessMode))
  ) {
    throw new DomainError('Choose a supported candidate access method.');
  }
  if (
    !Array.isArray(input.questions) ||
    input.questions.length < 1 ||
    input.questions.length > 200
  ) {
    throw new DomainError('Add between 1 and 200 questions.');
  }
  if (
    !Array.isArray(input.candidates) ||
    input.candidates.length < (accounts ? 0 : 1) ||
    input.candidates.length > 500
  ) {
    throw new DomainError(
      accounts ? 'Use a roster of at most 500 candidates.' : 'Add between 1 and 500 candidates.',
    );
  }
  const questions: Question[] = input.questions.map((raw, index) => {
    const q = object(raw);
    if (!['single', 'multiple', 'short'].includes(String(q.type)))
      throw new DomainError(`Question ${index + 1}: choose a question type.`);
    const type = q.type as Question['type'];
    const options =
      type === 'short'
        ? []
        : (() => {
            if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 8)
              throw new DomainError(`Question ${index + 1}: add 2–8 options.`);
            return q.options.map((option) => ({ id: newId(), text: text(option, 'Option', 2000) }));
          })();
    const correct = type === 'short' ? [] : q.correctIndices;
    if (
      !Array.isArray(correct) ||
      (type === 'single' && correct.length !== 1) ||
      (type === 'multiple' && correct.length < 1) ||
      new Set(correct).size !== correct.length ||
      correct.some((n) => !Number.isInteger(n) || n < 0 || n >= options.length)
    ) {
      throw new DomainError(`Question ${index + 1}: select valid correct answers.`);
    }
    return {
      id: newId(),
      type,
      prompt: text(q.prompt, 'Question', 10000),
      marks: integer(q.marks, 'Marks', 1, 100),
      options,
      correctOptionIds: correct.map((n: number) => options[n].id),
    };
  });
  const candidates = input.candidates.map((raw) => {
    const candidate = object(raw);
    return {
      identifier: identifier(candidate.identifier),
      name: text(candidate.name, 'Candidate name', 160),
      credential: accounts ? '' : text(candidate.credential, 'Candidate access key', 128, 8),
    };
  });
  if (new Set(candidates.map((c) => c.identifier)).size !== candidates.length)
    throw new DomainError('Candidate IDs must be unique in this roster.');
  for (const key of ['shuffleQuestions', 'shuffleOptions']) {
    if (typeof input[key] !== 'boolean')
      throw new DomainError('Randomization settings must be true or false.');
  }
  if (input.allowLateAdmission !== undefined && typeof input.allowLateAdmission !== 'boolean')
    throw new DomainError('Late admission must be enabled or disabled.');
  return {
    assessment: {
      id: newId(),
      title: text(input.title, 'Assessment title', 180),
      course: text(input.course, 'Course', 100),
      instructions: text(input.instructions ?? '', 'Instructions', 10000, 0),
      durationMinutes: integer(input.durationMinutes, 'Duration', 1, 480),
      passPercent: integer(input.passPercent, 'Pass mark', 0, 100),
      shuffleQuestions: input.shuffleQuestions as boolean,
      shuffleOptions: input.shuffleOptions as boolean,
      questions,
      timing: parseTiming(input.timing),
      allowLateAdmission: input.allowLateAdmission === true,
    },
    candidates,
  };
}

export function validateAnswer(question: Question, value: unknown): Answer {
  if (question.type === 'short') {
    if (typeof value !== 'string' || value.length > 10000)
      throw new DomainError('Answer must contain at most 10,000 characters.');
    return value;
  }
  if (
    !Array.isArray(value) ||
    value.some((id) => typeof id !== 'string' || !question.options.some((o) => o.id === id)) ||
    new Set(value).size !== value.length ||
    (question.type === 'single' && value.length > 1)
  ) {
    throw new DomainError('Choose valid options for this question.');
  }
  return [...value].sort() as string[];
}

export function grade(
  assessment: Assessment,
  responses: Record<string, ResponseValue>,
  manual: Record<string, number> = {},
): Grade {
  let manualScore = 0;
  let objectiveScore = 0;
  let pendingManual = 0;
  let maximumScore = 0;
  for (const question of assessment.questions) {
    maximumScore += question.marks;
    const answer = responses[question.id]?.value;
    if (question.type === 'short') {
      if (Object.hasOwn(manual, question.id)) manualScore += manual[question.id];
      else if (typeof answer === 'string' && answer.trim()) pendingManual++;
    } else if (
      Array.isArray(answer) &&
      answer.length === question.correctOptionIds.length &&
      question.correctOptionIds.every((id) => answer.includes(id))
    )
      objectiveScore += question.marks;
  }
  const totalScore = objectiveScore + manualScore;
  const percentage = pendingManual ? null : (totalScore / maximumScore) * 100;
  return {
    manualScore,
    totalScore,
    objectiveScore,
    maximumScore,
    pendingManual,
    percentage,
    passed: percentage === null ? null : percentage >= assessment.passPercent,
  };
}

export function shuffle<T>(values: T[], randomBelow: (max: number) => number): T[] {
  const output = [...values];
  for (let i = output.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    [output[i], output[j]] = [output[j], output[i]];
  }
  return output;
}

export function createOrder(assessment: Assessment, randomBelow: (max: number) => number) {
  const questions = assessment.shuffleQuestions
    ? shuffle(assessment.questions, randomBelow)
    : assessment.questions;
  return questions.map((q) => ({
    questionId: q.id,
    optionIds: (assessment.shuffleOptions ? shuffle(q.options, randomBelow) : q.options).map(
      (o) => o.id,
    ),
  }));
}
