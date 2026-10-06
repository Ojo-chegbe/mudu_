import { randomUUID } from 'node:crypto';
import { parseAssessment, text } from '../../packages/exam-core/engine.ts';
import { DomainError } from '../../packages/exam-core/model.ts';
import { assessmentInput } from '../../packages/contracts/assessment-authoring.ts';
import { transaction } from './database.ts';
import { digest, token } from './security.ts';
import type { ExamStore } from './store.ts';
import { Rosters } from './rosters.ts';
import type { Assessment } from '../../packages/exam-core/model.ts';
type RerunCandidate = { account_id: string; identifier: string; name: string; serial: number };

export class AssessmentEditing {
  store: ExamStore;
  constructor(store: ExamStore) {
    this.store = store;
  }
  private editable(id: string) {
    if (this.store.db.prepare('SELECT 1 FROM local_preparations WHERE run_id=?').get(id))
      throw new DomainError(
        'This local paper is pinned for delivery. Change the source assessment and prepare a new run instead.',
        409,
      );
    const assessment = this.store.assessment(id);
    if (this.store.db.prepare('SELECT 1 FROM sittings WHERE assessment_id=?').get(id))
      throw new DomainError(
        'This assessment has already started. Prepare a new run to change it without affecting results.',
        409,
      );
    return assessment;
  }
  editView(id: string) {
    const assessment = this.editable(id);
    return { input: assessmentInput(assessment), version: digest(JSON.stringify(assessment)) };
  }
  update(id: string, actor: string, input: Record<string, unknown>) {
    this.store.assertOwner(id, actor);
    const parsed = parseAssessment(
      { ...input, accessMode: 'accounts', candidates: [] },
      randomUUID,
    ).assessment;
    parsed.id = id;
    return transaction(this.store.db, () => {
      const current = this.editable(id);
      const same =
        JSON.stringify(assessmentInput(current)) === JSON.stringify(assessmentInput(parsed));
      if (input.expectedVersion !== digest(JSON.stringify(current)) && !same)
        throw new DomainError(
          'This assessment changed in another window. Your draft is kept; reload the saved version before editing again.',
          409,
        );
      if (!same) {
        this.store.db
          .prepare('UPDATE assessments SET definition=? WHERE id=?')
          .run(JSON.stringify(parsed), id);
        this.store.event(null, actor, 'assessment_updated', { assessmentId: id });
      }
      return this.editView(id);
    });
  }
  rerun(
    id: string,
    actor: string,
    input: Record<string, unknown>,
    completedOnline?: {
      paper: Assessment;
      candidates: RerunCandidate[] | (() => RerunCandidate[]);
    },
  ) {
    this.store.assertOwner(id, actor);
    if (completedOnline && completedOnline.paper.id !== id)
      throw new DomainError('Assessment not found.', 404);
    const requestId = text(input.requestId, 'Request identifier', 36);
    if (!/^[a-f0-9-]{36}$/.test(requestId)) throw new DomainError('Invalid request identifier.');
    const title = text(input.title, 'Assessment title', 180);
    if (typeof input.includeCandidates !== 'boolean')
      throw new DomainError('Choose whether to reuse candidates.');
    const rosterId = input.rosterId == null ? null : text(input.rosterId, 'Roster', 36);
    if (rosterId && input.includeCandidates)
      throw new DomainError('Choose a roster or previous candidates, not both.');
    return transaction(this.store.db, () => {
      const db = this.store.db;
      const previous = db
        .prepare('SELECT assessment_id FROM assessment_creations WHERE admin_id=? AND request_id=?')
        .get(actor, requestId);
      if (previous) {
        const event = db
          .prepare(
            "SELECT detail FROM events WHERE kind='assessment_rerun_prepared' AND json_extract(detail,'$.assessmentId')=?",
          )
          .get(previous.assessment_id!);
        const detail = event ? JSON.parse(String(event.detail)) : null;
        if (
          !detail ||
          detail.sourceId !== id ||
          detail.title !== title ||
          detail.includeCandidates !== input.includeCandidates ||
          (detail.rosterId ?? null) !== rosterId ||
          (rosterId && detail.rosterRevision !== input.rosterRevision)
        )
          throw new DomainError('This request was already used for different settings.', 409);
        return { id: String(previous.assessment_id), recovered: true };
      }
      const source = completedOnline?.paper ?? this.store.assessment(id);
      const rosters = new Rosters(this.store);
      const snapshot = rosterId ? rosters.snapshot(rosterId, actor, input.rosterRevision) : null;
      const sitting = db
        .prepare('SELECT id,deadline,snapshot FROM sittings WHERE assessment_id=?')
        .get(id);
      if (
        !completedOnline &&
        (!sitting ||
          Number(sitting.deadline) > this.store.now() ||
          db
            .prepare('SELECT 1 FROM exam_controls WHERE sitting_id=? AND paused_at IS NOT NULL')
            .get(sitting.id!) ||
          db
            .prepare(
              "SELECT 1 FROM attempts WHERE sitting_id=? AND status='active' AND deadline>? LIMIT 1",
            )
            .get(sitting.id!, this.store.now()))
      )
        throw new DomainError('Finish this assessment before preparing another run.', 409);
      const settings = db
        .prepare('SELECT mode,capacity FROM registration_settings WHERE assessment_id=?')
        .get(id)!;
      if (settings.mode === 'legacy' && input.includeCandidates)
        throw new DomainError(
          'Old access keys are not reused. Prepare the new run without candidates and invite their accounts.',
          409,
        );
      const definition = parseAssessment(
        {
          ...assessmentInput(
            completedOnline?.paper ?? (sitting ? JSON.parse(String(sitting.snapshot)) : source),
          ),
          allowLateAdmission: source.allowLateAdmission ?? false,
          title,
          accessMode: 'accounts',
          candidates: [],
        },
        randomUUID,
      ).assessment;
      db.prepare('INSERT INTO assessments VALUES(?,?,?)').run(
        definition.id,
        JSON.stringify(definition),
        this.store.now(),
      );
      db.prepare('INSERT INTO assessment_creations VALUES(?,?,?)').run(
        actor,
        requestId,
        definition.id,
      );
      db.prepare('INSERT INTO assessment_owners VALUES(?,?)').run(definition.id, actor);
      // Every run gets a fresh link, application references and timing state. No answers or keys are copied.
      db.prepare(
        "INSERT INTO registration_settings(assessment_id,mode,policy,link_token,is_open,closes_at,capacity) VALUES(?,'accounts','approval',?,0,NULL,?)",
      ).run(definition.id, token(), settings.capacity!);
      if (snapshot) {
        db.prepare('INSERT INTO assessment_rosters VALUES(?,?,?,?)').run(
          definition.id,
          snapshot.roster.id,
          snapshot.roster.name,
          snapshot.roster.revision,
        );
        db.prepare(
          "UPDATE registration_settings SET policy='roster',capacity=500 WHERE assessment_id=?",
        ).run(definition.id);
        const members = rosters
          .get(snapshot.roster.id, actor)
          .members.filter((m) => m.status === 'approved' && m.identityStatus === 'verified');
        if (members.length > 500)
          throw new DomainError('This assessment supports at most 500 candidates.');
        for (const member of members) {
          const candidateId = randomUUID();
          db.prepare('INSERT INTO candidates VALUES(?,?,?,?,?)').run(
            candidateId,
            definition.id,
            member.identifier,
            member.name,
            'account-managed',
          );
          db.prepare("INSERT INTO registrations VALUES(?,?,?,?,'approved',?,?)").run(
            randomUUID(),
            definition.id,
            member.accountId,
            candidateId,
            this.store.now(),
            this.store.now(),
          );
        }
      }
      if (input.includeCandidates) {
        const candidates =
          (completedOnline
            ? typeof completedOnline.candidates === 'function'
              ? completedOnline.candidates()
              : completedOnline.candidates
            : undefined) ??
          db
            .prepare(
              "SELECT r.account_id,c.identifier,c.name,n.serial FROM registrations r JOIN candidates c ON c.id=r.candidate_id JOIN application_numbers n ON n.registration_id=r.id WHERE r.assessment_id=? AND r.status='approved' ORDER BY n.serial",
            )
            .all(id);
        for (const candidate of candidates) {
          const candidateId = randomUUID();
          const registrationId = randomUUID();
          db.prepare("INSERT INTO registrations VALUES(?,?,?,NULL,'approved',?,?)").run(
            registrationId,
            definition.id,
            candidate.account_id!,
            this.store.now(),
            this.store.now(),
          );
          const application = db
            .prepare('SELECT serial FROM application_numbers WHERE registration_id=?')
            .get(registrationId)!;
          const previousReference = `APP-${String(candidate.serial).padStart(6, '0')}`;
          const identifier =
            candidate.identifier === previousReference ||
            String(candidate.identifier).startsWith('ACCOUNT-')
              ? `APP-${String(application.serial).padStart(6, '0')}`
              : String(candidate.identifier);
          db.prepare('INSERT INTO candidates VALUES(?,?,?,?,?)').run(
            candidateId,
            definition.id,
            identifier,
            candidate.name!,
            'account-managed',
          );
          db.prepare('UPDATE registrations SET candidate_id=? WHERE id=?').run(
            candidateId,
            registrationId,
          );
        }
      }
      this.store.event(null, actor, 'assessment_rerun_prepared', {
        assessmentId: definition.id,
        sourceId: id,
        title,
        includeCandidates: input.includeCandidates,
        rosterId,
        rosterRevision: snapshot?.roster.revision ?? null,
      });
      return { id: definition.id, recovered: false };
    });
  }
}
