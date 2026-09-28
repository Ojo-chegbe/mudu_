export type QuestionType = 'single' | 'multiple' | 'short';
export interface Option {
  id: string;
  text: string;
}
export interface Question {
  id: string;
  type: QuestionType;
  prompt: string;
  marks: number;
  options: Option[];
  correctOptionIds: string[];
}
export interface Assessment {
  id: string;
  title: string;
  course: string;
  instructions: string;
  durationMinutes: number;
  passPercent: number;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  questions: Question[];
}
export interface CandidateInput {
  identifier: string;
  name: string;
  credential: string;
}
export type Answer = string[] | string;
export type AttemptStatus = 'active' | 'submitted' | 'expired';
export interface Attempt {
  id: string;
  sittingId: string;
  candidateId: string;
  status: AttemptStatus;
  startedAt: number;
  deadline: number;
  submittedAt: number | null;
  order: Array<{ questionId: string; optionIds: string[] }>;
}
export interface ResponseValue {
  value: Answer;
  revision: number;
}
export interface Grade {
  manualScore: number;
  totalScore: number;
  objectiveScore: number;
  maximumScore: number;
  pendingManual: number;
  percentage: number | null;
  passed: boolean | null;
}
export type CandidateQuestion = Omit<Question, 'correctOptionIds'>;
export interface CandidateView {
  serverNow: number;
  candidate: { name: string; identifier: string };
  sitting: {
    id: string;
    title: string;
    course: string;
    instructions: string;
    deadline: number;
    questionCount: number;
    durationMinutes: number;
  };
  attempt:
    | (Omit<Attempt, 'order' | 'candidateId'> & {
        questions: CandidateQuestion[];
        responses: Record<string, ResponseValue>;
      })
    | null;
}

export class DomainError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'INVALID_INPUT') {
    super(message);
    this.name = 'DomainError';
    this.status = status;
    this.code = code;
  }
}
