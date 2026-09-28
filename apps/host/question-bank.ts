import { randomUUID } from 'node:crypto';
import { object, parseAssessment, text } from '../../packages/exam-core/engine.ts';
import { DomainError } from '../../packages/exam-core/model.ts';
import { assessmentInput } from '../../packages/contracts/assessment-authoring.ts';
import type {
  BankContent,
  BankItem,
  BankPage,
  BankStatus,
} from '../../packages/contracts/question-bank.ts';
import { transaction } from './database.ts';
import { digest } from './security.ts';
import type { ExamStore } from './store.ts';

export function bankId(value: unknown) {
  const id = text(value, 'Question identifier', 36);
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new DomainError('Invalid question identifier.');
  return id;
}
export function validateBankContent(input: unknown, approve = false): BankContent {
  const value = object(input);
  const q = object(value.question);
  if (!['single', 'multiple', 'short'].includes(String(q.type)))
    throw new DomainError('Choose a question type.');
  if (!Number.isInteger(q.marks) || Number(q.marks) < 1 || Number(q.marks) > 100)
    throw new DomainError('Marks must be between 1 and 100.');
  if (
    !Array.isArray(q.options) ||
    q.options.length > 8 ||
    !Array.isArray(q.correctIndices) ||
    q.correctIndices.length > 8 ||
    q.correctIndices.some(
      (i) => !Number.isInteger(i) || i < 0 || i >= (q.options as unknown[]).length,
    )
  )
    throw new DomainError('Check the options and correct answers.');
  if (!['easy', 'medium', 'hard'].includes(String(value.difficulty)))
    throw new DomainError('Choose a difficulty.');
  if (!Array.isArray(value.tags) || value.tags.length > 10)
    throw new DomainError('Use up to 10 tags.');
  const content: BankContent = {
    question: {
      type: q.type as BankItem['question']['type'],
      prompt: text(q.prompt, 'Question', 10000),
      marks: Number(q.marks),
      options: q.type === 'short' ? [] : q.options.map((o) => text(o, 'Option', 2000, 0)),
      correctIndices: q.type === 'short' ? [] : ([...new Set(q.correctIndices)] as number[]),
    },
    course: text(value.course, 'Course or subject', 100, 0),
    topic: text(value.topic, 'Topic', 100, 0),
    difficulty: value.difficulty as BankItem['difficulty'],
    tags: [...new Set(value.tags.map((t) => text(t, 'Tag', 40)))],
    explanation: text(value.explanation, 'Explanation', 10000, 0),
  };
  if (approve) {
    const parsed = parseAssessment(
      {
        title: 'Validation',
        course: 'Bank',
        instructions: '',
        durationMinutes: 1,
        passPercent: 0,
        shuffleQuestions: false,
        shuffleOptions: false,
        accessMode: 'accounts',
        candidates: [],
        questions: [content.question],
      },
      randomUUID,
    );
    content.question = assessmentInput(parsed.assessment).questions[0];
    const options = content.question.options.map((o) => o.normalize('NFKC').toLowerCase());
    if (new Set(options).size !== options.length)
      throw new DomainError('Each answer option must be different.');
  }
  return content;
}
export class QuestionBank {
  readonly store: ExamStore;
  constructor(store: ExamStore) {
    this.store = store;
  }
  private decode(row: Record<string, unknown>): BankItem {
    return {
      ...JSON.parse(String(row.content)),
      id: String(row.id),
      revision: Number(row.revision),
      status: row.status as BankStatus,
      updatedAt: Number(row.updated_at),
      origin: row.origin as BankItem['origin'],
      evidence: String(row.evidence),
      model: row.model == null ? null : String(row.model),
    };
  }
  get(id: string, owner: string) {
    const row = this.store.db
      .prepare('SELECT * FROM bank_questions WHERE id=? AND owner_id=?')
      .get(id, owner);
    if (!row) throw new DomainError('Question not found.', 404);
    return this.decode(row);
  }
  list(owner: string, params: URLSearchParams): BankPage {
    const status = params.get('status') ?? 'approved';
    if (!['draft', 'approved', 'archived', 'all'].includes(status))
      throw new DomainError('Unknown question filter.');
    const query = (params.get('q') ?? '').trim().slice(0, 200).toLowerCase();
    const type = params.get('type') ?? '';
    const difficulty = params.get('difficulty') ?? '';
    const offset = Math.max(0, Math.min(1000000, Number(params.get('offset')) || 0));
    const clauses = ['owner_id=?'];
    const values: string[] = [owner];
    if (status !== 'all') {
      clauses.push('status=?');
      values.push(status);
    }
    if (query) {
      clauses.push(
        "instr(lower(json_extract(content,'$.question.prompt') || ' ' || json_extract(content,'$.course') || ' ' || json_extract(content,'$.topic') || ' ' || json_extract(content,'$.tags')),?)>0",
      );
      values.push(query);
    }
    if (type) {
      clauses.push("json_extract(content,'$.question.type')=?");
      values.push(type);
    }
    if (difficulty) {
      clauses.push("json_extract(content,'$.difficulty')=?");
      values.push(difficulty);
    }
    const where = clauses.join(' AND ');
    const counts = { draft: 0, approved: 0, archived: 0 };
    for (const row of this.store.db
      .prepare('SELECT status,COUNT(*) n FROM bank_questions WHERE owner_id=? GROUP BY status')
      .all(owner))
      counts[row.status as BankStatus] = Number(row.n);
    return {
      items: this.store.db
        .prepare(
          `SELECT * FROM bank_questions WHERE ${where} ORDER BY updated_at DESC,id LIMIT 30 OFFSET ?`,
        )
        .all(...values, Math.floor(offset))
        .map((r) => this.decode(r)),
      total: Number(
        this.store.db
          .prepare(`SELECT COUNT(*) n FROM bank_questions WHERE ${where}`)
          .get(...values)!.n,
      ),
      counts,
    };
  }
  save(owner: string, input: Record<string, unknown>) {
    const id = bankId(input.id);
    const status = input.status as BankStatus;
    if (!['draft', 'approved', 'archived'].includes(status))
      throw new DomainError('Choose a question status.');
    const content = validateBankContent(input, status === 'approved');
    const serialized = JSON.stringify(content);
    const fingerprint = digest(JSON.stringify({ content, status }));
    return transaction(this.store.db, () => {
      const db = this.store.db;
      const row = db.prepare('SELECT * FROM bank_questions WHERE id=?').get(id);
      if (row) {
        if (row.owner_id !== owner) throw new DomainError('Question not found.', 404);
        if (input.expectedRevision === 0 && row.creation_fingerprint === fingerprint)
          return this.get(id, owner);
        if (input.expectedRevision !== row.revision) {
          if (row.content === serialized && row.status === status) return this.get(id, owner);
          throw new DomainError(
            'This question changed in another window. Your edits are kept; reopen the saved question to review the latest version.',
            409,
          );
        }
        if (row.content === serialized && row.status === status) return this.get(id, owner);
        db.prepare(
          'UPDATE bank_questions SET content=?,status=?,revision=revision+1,updated_at=? WHERE id=?',
        ).run(serialized, status, this.store.now(), id);
      } else {
        if (input.expectedRevision !== 0 || status === 'archived')
          throw new DomainError('Question not found.', 404);
        db.prepare('INSERT INTO bank_questions VALUES(?,?,?,?,1,?,?,?,?,?)').run(
          id,
          owner,
          serialized,
          status,
          this.store.now(),
          'manual',
          '',
          null,
          fingerprint,
        );
      }
      const item = this.get(id, owner);
      db.prepare('INSERT INTO bank_revisions VALUES(?,?,?,?,?)').run(
        id,
        item.revision,
        serialized,
        status,
        this.store.now(),
      );
      this.store.event(null, owner, 'bank_question_saved', {
        questionId: id,
        revision: item.revision,
        status,
      });
      return item;
    });
  }
  select(owner: string, input: unknown) {
    if (!Array.isArray(input) || !input.length || input.length > 200)
      throw new DomainError('Choose 1–200 questions.');
    const ids = new Set<string>();
    return input.map((raw) => {
      const selected = object(raw);
      const id = bankId(selected.id);
      if (ids.has(id)) throw new DomainError('A question was selected more than once.');
      ids.add(id);
      const item = this.get(id, owner);
      if (item.status !== 'approved' || item.revision !== selected.revision)
        throw new DomainError(
          'A selected question changed or is no longer approved. Refresh the bank and review your selection.',
          409,
        );
      return structuredClone(item.question);
    });
  }
}
