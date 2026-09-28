import type { Assessment, QuestionType } from '../exam-core/model.ts';

export interface AssessmentInput {
  title: string;
  course: string;
  instructions: string;
  durationMinutes: number;
  passPercent: number;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  questions: Array<{
    type: QuestionType;
    prompt: string;
    marks: number;
    options: string[];
    correctIndices: number[];
  }>;
}
export function assessmentInput(assessment: Assessment): AssessmentInput {
  return {
    title: assessment.title,
    course: assessment.course,
    instructions: assessment.instructions,
    durationMinutes: assessment.durationMinutes,
    passPercent: assessment.passPercent,
    shuffleQuestions: assessment.shuffleQuestions,
    shuffleOptions: assessment.shuffleOptions,
    questions: assessment.questions.map((q) => ({
      type: q.type,
      prompt: q.prompt,
      marks: q.marks,
      options: q.options.map((o) => o.text),
      correctIndices: q.correctOptionIds.map((id) => q.options.findIndex((o) => o.id === id)),
    })),
  };
}
export interface AssessmentEdit {
  input: AssessmentInput;
  version: string;
}
