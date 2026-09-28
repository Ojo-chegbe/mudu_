import type { AssessmentInput } from './assessment-authoring.ts';

export type BankStatus = 'draft' | 'approved' | 'archived';
export type BankQuestion = AssessmentInput['questions'][number];
export interface BankContent {
  question: BankQuestion;
  course: string;
  topic: string;
  difficulty: 'easy' | 'medium' | 'hard';
  tags: string[];
  explanation: string;
}
export interface BankItem extends BankContent {
  id: string;
  revision: number;
  status: BankStatus;
  updatedAt: number;
  origin: 'manual' | 'ai';
  evidence: string;
  model: string | null;
}
export interface BankPage {
  items: BankItem[];
  total: number;
  counts: Record<BankStatus, number>;
}
export const questionTypes = {
  single: 'Multiple choice',
  multiple: 'Multiple select',
  short: 'Written answer',
} as const;
export const emptyBankContent = (): BankContent => ({
  question: { type: 'single', prompt: '', marks: 1, options: ['', '', '', ''], correctIndices: [] },
  course: '',
  topic: '',
  difficulty: 'medium',
  tags: [],
  explanation: '',
});
