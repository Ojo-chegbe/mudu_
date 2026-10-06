import type { Assessment, QuestionType, TimingSettings } from '../exam-core/model.ts';
import { sharedTiming } from '../exam-core/timing.ts';

export interface AssessmentInput {
  title: string;
  course: string;
  instructions: string;
  durationMinutes: number;
  passPercent: number;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  timing?: TimingSettings;
  allowLateAdmission?: boolean;
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
    timing: assessment.timing ?? sharedTiming(),
    allowLateAdmission: assessment.allowLateAdmission ?? false,
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
