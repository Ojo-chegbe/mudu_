import { randomUUID } from 'node:crypto';
import { object, parseAssessment, text } from '../../packages/exam-core/engine.ts';
import { DomainError } from '../../packages/exam-core/model.ts';
import { assessmentInput } from '../../packages/contracts/assessment-authoring.ts';
import type {
  BankContent,
  BankItem,
  BankPage,
  BankStatus,
  BankProject,
  BankProjectsPage,
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
  private decodeProject(row: Record<string, unknown>): BankProject {
    const counts = { draft: 0, approved: 0, archived: 0 };
    for (const count of this.store.db
      .prepare(
        `SELECT q.status,COUNT(*) n FROM bank_questions q
      JOIN bank_question_projects m ON m.question_id=q.id WHERE m.project_id=?
      AND q.id NOT IN (SELECT question_id FROM bank_deleted_questions) GROUP BY q.status`,
      )
      .all(String(row.id)))
      counts[count.status as BankStatus] = Number(count.n);
    return {
      id: String(row.id),
      name: String(row.name),
      course: String(row.course),
      description: String(row.description),
      archived: Boolean(row.archived),
      revision: Number(row.revision),
      updatedAt: Number(row.updated_at),
      counts,
    };
  }
  project(owner: string, id: unknown, writable = false) {
    const row = this.store.db
      .prepare('SELECT * FROM bank_projects WHERE id=? AND owner_id=?')
      .get(bankId(id), owner);
    if (!row) throw new DomainError('Project not found.', 404);
    if (writable && row.archived)
      throw new DomainError(
        'This project is archived. Restore it before adding or editing questions.',
        409,
      );
    return this.decodeProject(row);
  }
  projects(owner: string, params: URLSearchParams): BankProjectsPage {
    const status = params.get('status') ?? 'active';
    if (!['active', 'archived'].includes(status)) throw new DomainError('Unknown project filter.');
    const query = (params.get('q') ?? '').trim().slice(0, 200).toLowerCase();
    const offset = Math.max(0, Math.min(1000000, Math.floor(Number(params.get('offset')) || 0)));
    const where =
      "owner_id=? AND archived=? AND instr(lower(name || ' ' || course || ' ' || description),?)>0";
    const values = [owner, status === 'archived' ? 1 : 0, query] as const;
    const counts = { active: 0, archived: 0 };
    for (const row of this.store.db
      .prepare('SELECT archived,COUNT(*) n FROM bank_projects WHERE owner_id=? GROUP BY archived')
      .all(owner))
      counts[row.archived ? 'archived' : 'active'] = Number(row.n);
    return {
      items: this.store.db
        .prepare(
          `SELECT * FROM bank_projects WHERE ${where} ORDER BY updated_at DESC,id LIMIT 30 OFFSET ?`,
        )
        .all(...values, offset)
        .map((r) => this.decodeProject(r)),
      total: Number(
        this.store.db.prepare(`SELECT COUNT(*) n FROM bank_projects WHERE ${where}`).get(...values)!
          .n,
      ),
      counts,
    };
  }
  saveProject(owner: string, input: Record<string, unknown>) {
    const id = bankId(input.id);
    const name = text(input.name, 'Project name', 120);
    const course = text(input.course ?? '', 'Course or subject', 100, 0);
    const description = text(input.description ?? '', 'Description', 1000, 0);
    if (typeof input.archived !== 'boolean') throw new DomainError('Choose a project status.');
    const archived = input.archived ? 1 : 0;
    return transaction(this.store.db, () => {
      const db = this.store.db;
      const row = db.prepare('SELECT * FROM bank_projects WHERE id=?').get(id);
      if (row) {
        if (row.owner_id !== owner) throw new DomainError('Project not found.', 404);
        if (
          row.name === name &&
          row.course === course &&
          row.description === description &&
          row.archived === archived
        )
          return this.project(owner, id);
        if (row.revision !== input.expectedRevision)
          throw new DomainError(
            'This project changed in another window. Reopen its settings to see the latest version.',
            409,
          );
        db.prepare(
          'UPDATE bank_projects SET name=?,course=?,description=?,archived=?,revision=revision+1,updated_at=? WHERE id=?',
        ).run(name, course, description, archived, this.store.now(), id);
      } else {
        if (input.expectedRevision !== 0 || archived)
          throw new DomainError('Project not found.', 404);
        db.prepare('INSERT INTO bank_projects VALUES(?,?,?,?,?,0,1,?)').run(
          id,
          owner,
          name,
          course,
          description,
          this.store.now(),
        );
      }
      this.store.event(null, owner, 'bank_project_saved', {
        projectId: id,
        archived: Boolean(archived),
      });
      return this.project(owner, id);
    });
  }
  private decode(row: Record<string, unknown>): BankItem {
    return {
      ...JSON.parse(String(row.content)),
      id: String(row.id),
      projectId: String(row.project_id),
      revision: Number(row.revision),
      status: row.status as BankStatus,
      updatedAt: Number(row.updated_at),
      origin: row.origin as BankItem['origin'],
      evidence: String(row.evidence),
      model: row.model == null ? null : String(row.model),
    };
  }
  get(id: string, owner: string, includeDeleted = false) {
    const row = this.store.db
      .prepare(
        'SELECT q.*,m.project_id FROM bank_questions q JOIN bank_question_projects m ON m.question_id=q.id WHERE q.id=? AND q.owner_id=? AND (? OR q.id NOT IN (SELECT question_id FROM bank_deleted_questions))',
      )
      .get(id, owner, includeDeleted ? 1 : 0);
    if (!row) throw new DomainError('Question not found.', 404);
    return this.decode(row);
  }
  list(owner: string, params: URLSearchParams): BankPage {
    const project = this.project(owner, params.get('projectId'));
    const status = params.get('status') ?? 'approved';
    if (!['draft', 'approved', 'archived', 'all'].includes(status))
      throw new DomainError('Unknown question filter.');
    const query = (params.get('q') ?? '').trim().slice(0, 200).toLowerCase();
    const type = params.get('type') ?? '';
    const difficulty = params.get('difficulty') ?? '';
    const offset = Math.max(0, Math.min(1000000, Number(params.get('offset')) || 0));
    const clauses = [
      'owner_id=?',
      'id NOT IN (SELECT question_id FROM bank_deleted_questions)',
      'id IN (SELECT question_id FROM bank_question_projects WHERE project_id=?)',
    ];
    const values: string[] = [owner, project.id];
    if (status !== 'all') {
      clauses.push('status=?');
      values.push(status);
    } else if (params.get('activeOnly') === '1') clauses.push("status!='archived'");
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
      .prepare(
        'SELECT status,COUNT(*) n FROM bank_questions WHERE owner_id=? AND id NOT IN (SELECT question_id FROM bank_deleted_questions) AND id IN (SELECT question_id FROM bank_question_projects WHERE project_id=?) GROUP BY status',
      )
      .all(owner, project.id))
      counts[row.status as BankStatus] = Number(row.n);
    return {
      items: this.store.db
        .prepare(
          `SELECT * FROM bank_questions WHERE ${where} ORDER BY updated_at DESC,id LIMIT 30 OFFSET ?`,
        )
        .all(...values, Math.floor(offset))
        .map((r) => this.decode({ ...r, project_id: project.id })),
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
      if (row && row.owner_id !== owner) throw new DomainError('Question not found.', 404);
      const projectId = input.projectId ?? (row ? this.get(id, owner).projectId : undefined);
      this.project(owner, projectId, true);
      if (row && this.get(id, owner).projectId !== projectId)
        throw new DomainError(
          'A question cannot be moved through the editor. Reopen it from its project.',
          409,
        );
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
        db.prepare('INSERT INTO bank_question_projects VALUES(?,?)').run(id, String(projectId));
      }
      const item = this.get(id, owner);
      db.prepare('UPDATE bank_projects SET updated_at=? WHERE id=?').run(
        this.store.now(),
        item.projectId,
      );
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
  reviewSelection(owner: string, input: Record<string, unknown>) {
    if (!['approve', 'delete'].includes(String(input.action)))
      throw new DomainError('Choose an action.');
    if (!Array.isArray(input.selection) || !input.selection.length || input.selection.length > 200)
      throw new DomainError('Choose 1–200 questions.');
    const selection = input.selection.map((raw) => object(raw));
    if (new Set(selection.map((item) => bankId(item.id))).size !== selection.length)
      throw new DomainError('A question was selected more than once.');
    if (input.action === 'approve' && input.reviewed !== true)
      throw new DomainError('Confirm that you have reviewed the selected questions.');
    return transaction(this.store.db, () => {
      const items = selection.map((raw) => {
        const item = this.get(bankId(raw.id), owner, input.action === 'delete');
        this.project(owner, item.projectId, true);
        if (item.revision !== raw.revision)
          throw new DomainError(
            'A selected question changed. Refresh the project and review your selection.',
            409,
          );
        const reviewContent =
          input.action === 'approve' ? validateBankContent(raw.content ?? item, true) : null;
        return { ...item, reviewContent };
      });
      const db = this.store.db;
      for (const item of items) {
        if (input.action === 'delete') {
          const inserted = db
            .prepare('INSERT OR IGNORE INTO bank_deleted_questions VALUES(?,?,?)')
            .run(item.id, owner, this.store.now());
          if (!inserted.changes) continue;
          this.store.event(null, owner, 'bank_question_deleted', {
            questionId: item.id,
            projectId: item.projectId,
            revision: item.revision,
          });
        } else {
          const content = JSON.stringify(item.reviewContent);
          const previous = db
            .prepare('SELECT content FROM bank_questions WHERE id=?')
            .get(item.id)!.content;
          if (item.status === 'approved' && content === previous) continue;
          db.prepare(
            "UPDATE bank_questions SET content=?,status='approved',revision=revision+1,updated_at=? WHERE id=?",
          ).run(content, this.store.now(), item.id);
          db.prepare("INSERT INTO bank_revisions VALUES(?,?,?,'approved',?)").run(
            item.id,
            item.revision + 1,
            content,
            this.store.now(),
          );
          this.store.event(null, owner, 'bank_question_approved', {
            questionId: item.id,
            projectId: item.projectId,
            revision: item.revision + 1,
          });
        }
        db.prepare('UPDATE bank_projects SET updated_at=? WHERE id=?').run(
          this.store.now(),
          item.projectId,
        );
      }
      return {
        count: items.length,
        items: input.action === 'approve' ? items.map((item) => this.get(item.id, owner)) : [],
      };
    });
  }
  move(owner: string, input: Record<string, unknown>) {
    if (!Array.isArray(input.selection) || !input.selection.length || input.selection.length > 200)
      throw new DomainError('Choose 1–200 questions.');
    const selection = input.selection.map((raw) => object(raw));
    if (new Set(selection.map((item) => bankId(item.id))).size !== selection.length)
      throw new DomainError('A question was selected more than once.');
    return transaction(this.store.db, () => {
      const target = this.project(owner, input.projectId, true);
      const items = selection.map((item) => {
        const saved = this.get(bankId(item.id), owner);
        this.project(owner, saved.projectId, true);
        if (saved.revision !== item.revision)
          throw new DomainError(
            'A selected question changed. Refresh the project before moving it.',
            409,
          );
        return saved;
      });
      for (const item of items) {
        if (item.projectId === target.id) continue;
        this.store.db
          .prepare('UPDATE bank_question_projects SET project_id=? WHERE question_id=?')
          .run(target.id, item.id);
        this.store.db
          .prepare('UPDATE bank_questions SET revision=revision+1,updated_at=? WHERE id=?')
          .run(this.store.now(), item.id);
        this.store.db.prepare('INSERT INTO bank_revisions VALUES(?,?,?,?,?)').run(
          item.id,
          item.revision + 1,
          JSON.stringify({
            question: item.question,
            course: item.course,
            topic: item.topic,
            difficulty: item.difficulty,
            tags: item.tags,
            explanation: item.explanation,
          }),
          item.status,
          this.store.now(),
        );
        this.store.db
          .prepare('UPDATE bank_projects SET updated_at=? WHERE id IN (?,?)')
          .run(this.store.now(), item.projectId, target.id);
        this.store.event(null, owner, 'bank_question_moved', {
          questionId: item.id,
          fromProjectId: item.projectId,
          projectId: target.id,
        });
      }
      return { moved: items.filter((item) => item.projectId !== target.id).length };
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
      const project = this.project(owner, item.projectId);
      if (project.archived)
        throw new DomainError(
          'A selected project was archived. Choose questions from an active project.',
          409,
        );
      if (item.status !== 'approved' || item.revision !== selected.revision)
        throw new DomainError(
          'A selected question changed or is no longer approved. Refresh the bank and review your selection.',
          409,
        );
      return structuredClone(item.question);
    });
  }
}
