import { DomainError } from '../../packages/exam-core/model.ts';
import { validateBankContent } from './question-bank.ts';

export const unreadableGenerationMessage =
  'The generated questions came back in an unreadable format. Please generate again, or try fewer questions. Your material is unchanged.';
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function malformed(message = unreadableGenerationMessage): never {
  throw new DomainError(message, 502, 'INVALID_GENERATION_OUTPUT');
}

// Recover presentation-only differences, never missing values or answer keys.
function parseDocument(input: string): unknown {
  let cleaned = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (inString) {
      if (escaped) {
        cleaned += char;
        escaped = false;
      } else if (char === '\\') {
        cleaned += char;
        escaped = true;
      } else if (char === '"') {
        cleaned += char;
        inString = false;
      } else if (char.charCodeAt(0) < 32) {
        cleaned += JSON.stringify(char).slice(1, -1);
      } else cleaned += char;
    } else {
      if (char === '"') inString = true;
      // A trailing comma is formatting, not an omitted array entry.
      if (char === ',') {
        let next = i + 1;
        while (/\s/.test(input[next] ?? '') && next < input.length) next++;
        if (input[next] === '}' || input[next] === ']') continue;
      }
      cleaned += char;
    }
  }
  return JSON.parse(cleaned);
}

function readPayload(output: string): unknown {
  const trimmed = output.trim();
  try {
    return parseDocument(trimmed);
  } catch {
    // Models sometimes wrap a complete JSON document in prose or markdown.
    // Scan balanced roots with string awareness; reject ambiguous/multiple roots.
  }
  const documents: string[] = [];
  let start = -1;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (start === -1) {
      if (char !== '{' && char !== '[') continue;
      start = i;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') {
      if (stack.pop() !== (char === '}' ? '{' : '[')) malformed();
      if (!stack.length) {
        documents.push(trimmed.slice(start, i + 1));
        if (documents.length > 1) malformed();
        start = -1;
      }
    }
  }
  if (start !== -1 || documents.length !== 1) malformed();
  try {
    return parseDocument(documents[0]);
  } catch {
    malformed();
  }
}

export function parseGeneratedQuestions(
  output: string,
  expected: {
    count: number;
    course: string;
    topic: string;
    type: string;
    difficulty: string;
  },
) {
  if (output.length > 200000)
    malformed(
      'The generated response was too large. Try fewer questions. Your material is unchanged.',
    );
  const payload = readPayload(output);
  const entries = Array.isArray(payload)
    ? payload
    : record(payload)
      ? payload.questions
      : undefined;
  if (!Array.isArray(entries)) malformed();
  if (entries.length !== expected.count)
    malformed(
      'The AI did not return the requested number of questions. Try a smaller batch. Your material is unchanged.',
    );
  const questions = entries.map((raw: unknown, index: number) => {
    const invalidQuestion = `Question ${index + 1} came back incomplete or with an invalid answer. Generate again, or try fewer questions. Your material is unchanged.`;
    if (!record(raw)) malformed(invalidQuestion);
    // A flat record with question text is an unambiguous alternative to a nested question object.
    // Do not guess answer keys, convert one-based indices or manufacture missing values.
    let question: Record<string, unknown>;
    if (record(raw.question)) question = raw.question;
    else if (typeof raw.question === 'string') {
      if (raw.prompt !== undefined && raw.prompt !== raw.question) malformed(invalidQuestion);
      question = { ...raw, prompt: raw.question };
    } else if (raw.question === undefined && typeof raw.prompt === 'string') question = raw;
    else malformed(invalidQuestion);
    let content;
    try {
      content = validateBankContent(
        {
          question,
          explanation: raw.explanation,
          course: expected.course,
          topic: expected.topic,
          difficulty: expected.difficulty,
          tags: [],
        },
        true,
      );
    } catch {
      malformed(invalidQuestion);
    }
    if (content.question.type !== expected.type)
      malformed(
        `Question ${index + 1} used a different question type. Please generate again. Your material is unchanged.`,
      );
    // Validate usable question structure only. Accuracy and source relevance are
    // reviewed by the lecturer, not inferred from an AI-provided quotation.
    return { content };
  });
  if (
    new Set(questions.map((q) => q.content.question.prompt.toLowerCase())).size !== questions.length
  )
    malformed('The AI repeated a question. Try a smaller batch. Your material is unchanged.');
  return questions;
}
