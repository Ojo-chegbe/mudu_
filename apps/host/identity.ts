import { randomUUID } from 'node:crypto';
import { DomainError } from '../../packages/exam-core/model.ts';
import { text } from '../../packages/exam-core/engine.ts';
import type {
  CandidateProfile,
  ExamRegistration,
  Invitation,
  RegistrationRequest,
  RegistrationSettings,
} from '../../packages/contracts/registration.ts';
import { transaction } from './database.ts';
import { ExamStore } from './store.ts';
import { token } from './security.ts';
import { admissionWindow } from '../../packages/exam-core/timing.ts';
import { execution } from './exam-controls.ts';

export function emailAddress(value: unknown) {
  const email = text(value, 'Email address', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new DomainError('Enter a valid email address.');
  return email;
}
export function accountPassword(value: unknown, creating = false) {
  if (
    typeof value !== 'string' ||
    value.length < (creating ? 8 : 1) ||
    value.length > 128 ||
    (creating && !value.trim())
  ) {
    throw new DomainError(
      creating ? 'Choose a password or passphrase of 8–128 characters.' : 'Enter your password.',
    );
  }
  // Passwords are exact secrets: never trim, normalize, or change their casing.
  return value;
}
export function registrationConfig(
  input: Record<string, unknown>,
  rosterCount: number,
  now: number,
) {
  const mode = input.accessMode === 'accounts' ? 'accounts' : 'legacy';
  const policy = input.registrationPolicy ?? 'approval';
  if (policy !== 'approval' && policy !== 'roster')
    throw new DomainError('Choose a registration policy.');
  if (mode === 'accounts' && policy === 'roster' && !rosterCount)
    throw new DomainError('Add a roster before choosing roster-restricted registration.');
  const capacity = input.registrationCapacity ?? 500;
  if (
    typeof capacity !== 'number' ||
    !Number.isInteger(capacity) ||
    capacity < Math.max(1, rosterCount) ||
    capacity > 500
  )
    throw new DomainError('Candidate capacity must cover the roster and be between 1 and 500.');
  const closesAt = input.registrationClosesAt ?? null;
  if (
    closesAt !== null &&
    (typeof closesAt !== 'number' || !Number.isSafeInteger(closesAt) || closesAt <= now)
  )
    throw new DomainError('Choose a registration closing time in the future.');
  return { mode, policy, closesAt, capacity } as {
    mode: 'accounts' | 'legacy';
    policy: 'approval' | 'roster';
    closesAt: number | null;
    capacity: number;
  };
}

// This module owns canonical identities and registrations. The first deployment
// hosts it beside the engine; future offline Hosts receive scoped identity
// snapshots/admission proofs, never a second account or these password verifiers.
export class IdentityService {
  store: ExamStore;
  constructor(store: ExamStore) {
    this.store = store;
  }
  get db() {
    return this.store.db;
  }

  createAccount(input: { email: string; name: string; identifier?: string; hash: string }) {
    return transaction(this.db, () => {
      if (this.db.prepare('SELECT id FROM accounts WHERE email=?').get(input.email))
        throw new DomainError('An account already uses this email. Sign in instead.', 409);
      if (input.identifier?.includes('@'))
        throw new DomainError('Candidate numbers cannot contain @.');
      const id = randomUUID();
      this.db
        .prepare('INSERT INTO accounts VALUES(?,?,?,?,?)')
        .run(id, input.email, input.name, input.hash, this.store.now());
      this.db
        .prepare('INSERT INTO memberships VALUES(?,?,?,?,?,NULL)')
        .run(
          randomUUID(),
          id,
          'default',
          input.identifier ?? `ACCOUNT-${id.toUpperCase()}`,
          'pending',
        );
      this.store.event(null, id, 'account_created');
      return this.store.createSession('candidate', id, null, id);
    });
  }
  findLogin(login: string) {
    return this.db
      .prepare(`SELECT id,password_hash FROM accounts WHERE email=?`)
      .get(login.toLowerCase());
  }
  profile(accountId: string): CandidateProfile {
    const row = this.db
      .prepare(
        `SELECT a.id,a.name,a.email,m.identifier,m.status AS identityStatus,o.name AS organization
      FROM accounts a JOIN memberships m ON m.account_id=a.id JOIN organizations o ON o.id=m.organization_id
      WHERE a.id=? AND m.organization_id='default'`,
      )
      .get(accountId);
    if (!row) throw new DomainError('Account not found.', 404);
    return row as unknown as CandidateProfile;
  }
  settings(assessmentId: string): RegistrationSettings {
    const row = this.db
      .prepare('SELECT * FROM registration_settings WHERE assessment_id=?')
      .get(assessmentId);
    if (!row) throw new DomainError('Assessment not found.', 404);
    const launched = Boolean(
      this.db.prepare('SELECT id FROM sittings WHERE assessment_id=?').get(assessmentId),
    );
    return {
      assessmentId,
      mode: row.mode as 'accounts' | 'legacy',
      policy: row.policy as 'approval' | 'roster',
      token: String(row.link_token),
      open: row.is_open === 1,
      accepting:
        row.is_open === 1 &&
        !launched &&
        (row.closes_at === null || Number(row.closes_at) > this.store.now()),
      closesAt: row.closes_at === null ? null : Number(row.closes_at),
      capacity: Number(row.capacity),
      launched,
    };
  }
  invitation(link: string, accountId?: string | null): Invitation {
    const row = this.db
      .prepare(
        "SELECT assessment_id FROM registration_settings WHERE link_token=? AND mode='accounts'",
      )
      .get(link);
    if (!row)
      throw new DomainError(
        'This registration link is no longer available. Ask the assessment organiser for the current link.',
        404,
      );
    const id = String(row.assessment_id);
    const assessment = this.store.assessment(id);
    const settings = this.settings(id);
    const registration = accountId
      ? this.db
          .prepare('SELECT status FROM registrations WHERE assessment_id=? AND account_id=?')
          .get(id, accountId)
      : null;
    return {
      assessmentId: id,
      title: assessment.title,
      course: assessment.course,
      organization: 'MUDU workspace',
      durationMinutes: assessment.durationMinutes,
      questionCount: assessment.questions.length,
      policy: settings.policy,
      accepting: settings.accepting,
      closesAt: settings.closesAt,
      registration: registration
        ? { status: registration.status as 'pending' | 'approved' | 'rejected' }
        : null,
    };
  }
  updateSettings(assessmentId: string, input: Record<string, unknown>, actor: string) {
    return transaction(this.db, () => {
      const settings = this.settings(assessmentId);
      if (settings.mode !== 'accounts')
        throw new DomainError('This assessment uses legacy invitations.', 409);
      if (settings.launched)
        throw new DomainError('Registration cannot change after the examination starts.', 409);
      if (typeof input.open !== 'boolean')
        throw new DomainError('Choose whether registration is open.');
      if (input.open && settings.closesAt !== null && settings.closesAt <= this.store.now())
        throw new DomainError('The configured registration deadline has passed.', 409);
      if (input.rotate !== undefined && typeof input.rotate !== 'boolean')
        throw new DomainError('Invalid link rotation.');
      this.db
        .prepare('UPDATE registration_settings SET is_open=?,link_token=? WHERE assessment_id=?')
        .run(input.open ? 1 : 0, input.rotate ? token() : settings.token, assessmentId);
      this.store.event(
        null,
        actor,
        input.rotate
          ? 'registration_link_rotated'
          : input.open
            ? 'registration_opened'
            : 'registration_closed',
        { assessmentId },
      );
      return this.settings(assessmentId);
    });
  }
  private ensureCapacity(assessmentId: string, settings: RegistrationSettings) {
    const count = Number(
      this.db
        .prepare(
          "SELECT COUNT(*) AS total FROM registrations WHERE assessment_id=? AND status='approved'",
        )
        .get(assessmentId)?.total,
    );
    if (count >= settings.capacity)
      throw new DomainError('This examination has reached its candidate limit.', 409);
  }
  private approve(registrationId: string, accountId: string, assessmentId: string, actor: string) {
    const profile = this.profile(accountId);
    const settings = this.settings(assessmentId);
    this.ensureCapacity(assessmentId, settings);
    const candidateNumber =
      settings.policy === 'roster' ? profile.identifier : this.applicationNumber(registrationId)!;
    const existing = this.db
      .prepare('SELECT id,name FROM candidates WHERE assessment_id=? AND identifier=?')
      .get(assessmentId, candidateNumber);
    if (settings.policy === 'roster' && !existing)
      throw new DomainError('This candidate number is not on the permitted roster.', 403);
    const candidateId = existing ? String(existing.id) : randomUUID();
    const bound = this.db
      .prepare('SELECT account_id FROM registrations WHERE candidate_id=?')
      .get(candidateId);
    if (bound && bound.account_id !== accountId)
      throw new DomainError('This roster entry already belongs to a different account.', 409);
    if (!existing)
      this.db
        .prepare('INSERT INTO candidates VALUES(?,?,?,?,?)')
        .run(candidateId, assessmentId, candidateNumber, profile.name, 'account-managed');
    else {
      this.db
        .prepare("UPDATE candidates SET credential_hash='account-managed' WHERE id=?")
        .run(candidateId);
      this.db
        .prepare(
          "DELETE FROM sessions WHERE role='candidate' AND principal_id=? AND account_id IS NULL",
        )
        .run(candidateId);
    }
    this.db
      .prepare("UPDATE registrations SET status='approved',candidate_id=?,reviewed_at=? WHERE id=?")
      .run(candidateId, this.store.now(), registrationId);
    this.store.event(null, actor, 'registration_approved', {
      assessmentId,
      registrationId,
      accountId,
    });
  }
  register(link: string, accountId: string) {
    return transaction(this.db, () => {
      const invitation = this.invitation(link, accountId);
      if (invitation.registration) return invitation.registration;
      if (!invitation.accepting)
        throw new DomainError(
          'Registration is closed. Existing registrations are unaffected.',
          409,
        );
      const profile = this.profile(accountId);
      const settings = this.settings(invitation.assessmentId);
      this.ensureCapacity(invitation.assessmentId, settings);
      const rosterEntry = this.db
        .prepare('SELECT id FROM candidates WHERE assessment_id=? AND identifier=?')
        .get(invitation.assessmentId, profile.identifier);
      if (settings.policy === 'roster' && !rosterEntry)
        throw new DomainError(
          'This examination is restricted to its roster. Contact the assessment organiser.',
          403,
        );
      const count = Number(
        this.db
          .prepare('SELECT COUNT(*) AS total FROM registrations WHERE assessment_id=?')
          .get(invitation.assessmentId)?.total,
      );
      if (count >= 2000)
        throw new DomainError(
          'The registration queue is full. Contact the assessment organiser.',
          409,
        );
      const id = randomUUID();
      this.db
        .prepare('INSERT INTO registrations VALUES(?,?,?,NULL,?,?,NULL)')
        .run(id, invitation.assessmentId, accountId, 'pending', this.store.now());
      this.store.event(null, accountId, 'registration_requested', {
        assessmentId: invitation.assessmentId,
        registrationId: id,
      });
      if (settings.policy === 'roster' && profile.identityStatus === 'verified')
        this.approve(id, accountId, invitation.assessmentId, accountId);
      return this.invitation(link, accountId).registration!;
    });
  }
  review(
    assessmentId: string,
    registrationId: string,
    decision: unknown,
    _identityVerified: unknown,
    actor: string,
  ) {
    return transaction(this.db, () => {
      const settings = this.settings(assessmentId);
      if (settings.launched)
        throw new DomainError('Review registrations before starting the examination.', 409);
      if (decision !== 'approved' && decision !== 'rejected')
        throw new DomainError('Choose approve or reject.');
      const row = this.db
        .prepare('SELECT * FROM registrations WHERE id=? AND assessment_id=?')
        .get(registrationId, assessmentId);
      if (!row) throw new DomainError('Registration not found.', 404);
      if (row.status === decision) return { status: decision };
      if (row.status === 'approved')
        throw new DomainError(
          'An approved registration cannot be reassigned or rejected through this action.',
          409,
        );
      if (decision === 'rejected') {
        this.db
          .prepare("UPDATE registrations SET status='rejected',reviewed_at=? WHERE id=?")
          .run(this.store.now(), registrationId);
        this.store.event(null, actor, 'registration_rejected', { assessmentId, registrationId });
      } else {
        const accountId = String(row.account_id);
        const profile = this.profile(accountId);
        if (profile.identityStatus !== 'verified') {
          if (
            this.db
              .prepare(
                'SELECT 1 FROM roster_enrolment_invites WHERE identifier=? AND email<>? LIMIT 1',
              )
              .get(profile.identifier, profile.email)
          )
            throw new DomainError(
              'This student number is reserved for another email address.',
              409,
            );
          if (
            this.db
              .prepare(
                "SELECT account_id FROM memberships WHERE organization_id='default' AND identifier=? AND status='verified' AND account_id<>?",
              )
              .get(profile.identifier, accountId)
          )
            throw new DomainError(
              'This candidate number is already verified for another account. Investigate the identity conflict.',
              409,
            );
          this.db
            .prepare(
              "UPDATE memberships SET status='verified',verified_at=? WHERE account_id=? AND organization_id='default'",
            )
            .run(this.store.now(), accountId);
          this.store.event(null, actor, 'candidate_identity_verified', {
            accountId,
            identifier: profile.identifier,
          });
        }
        this.approve(registrationId, accountId, assessmentId, actor);
      }
      return { status: decision };
    });
  }
  requests(assessmentId: string): RegistrationRequest[] {
    this.settings(assessmentId);
    return this.db
      .prepare(
        `SELECT r.id,a.name,a.email,m.identifier,m.status AS identityStatus,r.status,c.name AS rosterName,
        'APP-' || printf('%06d', n.serial) AS applicationNumber
      FROM registrations r JOIN accounts a ON a.id=r.account_id JOIN memberships m ON m.account_id=a.id AND m.organization_id='default'
      JOIN application_numbers n ON n.registration_id=r.id
      LEFT JOIN candidates c ON c.assessment_id=r.assessment_id AND c.identifier=m.identifier
      WHERE r.assessment_id=? ORDER BY r.requested_at,r.id`,
      )
      .all(assessmentId) as unknown as RegistrationRequest[];
  }
  directory(includeUnassigned = false, owner?: string) {
    return this.db
      .prepare(
        `SELECT a.id AS accountId,a.email,a.name,m.identifier FROM memberships m JOIN accounts a ON a.id=m.account_id
      WHERE m.organization_id='default' AND (? OR m.status='verified') AND (? IS NULL OR
        EXISTS (SELECT 1 FROM registrations r JOIN assessment_owners o ON o.assessment_id=r.assessment_id WHERE r.account_id=a.id AND o.owner_id=?) OR
        EXISTS (SELECT 1 FROM roster_members m2 JOIN rosters r2 ON r2.id=m2.roster_id WHERE m2.account_id=a.id AND r2.owner_id=?)) ORDER BY a.name`,
      )
      .all(Number(includeUnassigned), owner ?? null, owner ?? null, owner ?? null);
  }
  examinations(accountId: string): ExamRegistration[] {
    this.store.reconcile();
    const rows = this.db
      .prepare('SELECT * FROM registrations WHERE account_id=? ORDER BY requested_at DESC')
      .all(accountId);
    return rows.map((r) => {
      const assessment = this.store.assessment(String(r.assessment_id));
      const sitting = this.db
        .prepare('SELECT id,deadline,started_at,snapshot FROM sittings WHERE assessment_id=?')
        .get(assessment.id);
      const attempt =
        sitting && r.candidate_id
          ? this.store.findAttempt(String(sitting.id), String(r.candidate_id))
          : null;
      const control = sitting
        ? execution(this.db, this.store.sitting(String(sitting.id)), this.store.now())
        : null;
      const window = sitting
        ? admissionWindow(
            control!.assessment,
            Number(sitting.started_at),
            control!.admissionDeadline,
            control!.now,
          )
        : null;
      return {
        assessmentId: assessment.id,
        applicationNumber: this.applicationNumber(String(r.id)),
        title: assessment.title,
        course: assessment.course,
        durationMinutes: control?.assessment.durationMinutes ?? assessment.durationMinutes,
        questionCount: assessment.questions.length,
        timingMode: assessment.timing?.mode ?? 'shared',
        opensAt: window?.opensAt ?? assessment.timing?.opensAt ?? null,
        lastStartAt: window?.lastStartAt ?? assessment.timing?.lastStartAt ?? null,
        finishBy: control?.assessment.timing?.finishBy ?? assessment.timing?.finishBy ?? null,
        registrationStatus: r.status as ExamRegistration['registrationStatus'],
        examStatus:
          attempt?.status ??
          (!sitting
            ? 'upcoming'
            : window?.startRestriction === 'closed'
              ? 'ended'
              : window?.startRestriction === 'not_open'
                ? 'upcoming'
                : 'available'),
      };
    });
  }
  authorizeExam(accountId: string, assessmentId: string) {
    const row = this.db
      .prepare(
        `SELECT r.candidate_id,s.id AS sitting_id FROM registrations r
      JOIN memberships m ON m.account_id=r.account_id AND m.organization_id='default' AND m.status='verified'
      LEFT JOIN sittings s ON s.assessment_id=r.assessment_id
      WHERE r.account_id=? AND r.assessment_id=? AND r.status='approved'`,
      )
      .get(accountId, assessmentId);
    if (!row?.candidate_id)
      throw new DomainError('You are not approved for this examination.', 403);
    if (!row.sitting_id) throw new DomainError('This examination has not started yet.', 409);
    return { sittingId: String(row.sitting_id), candidateId: String(row.candidate_id) };
  }
  applicationNumber(registrationId: string) {
    const row = this.db
      .prepare('SELECT serial FROM application_numbers WHERE registration_id=?')
      .get(registrationId);
    return row ? `APP-${String(row.serial).padStart(6, '0')}` : null;
  }
}
