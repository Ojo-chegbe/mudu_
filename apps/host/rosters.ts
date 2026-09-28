import { randomUUID } from 'node:crypto';
import { identifier, object, text } from '../../packages/exam-core/engine.ts';
import { DomainError } from '../../packages/exam-core/model.ts';
import { transaction } from './database.ts';
import { token } from './security.ts';
import { IdentityService, emailAddress } from './identity.ts';
import type { ExamStore } from './store.ts';
import type { RosterDetail, RosterSummary } from '../../packages/contracts/rosters.ts';

export class Rosters {
  store: ExamStore;
  constructor(store: ExamStore) {
    this.store = store;
  }
  get db() {
    return this.store.db;
  }
  list(owner: string): RosterSummary[] {
    return this.db
      .prepare(
        `SELECT r.id,r.name,r.revision,r.archived,r.is_open,r.restricted,r.updated_at,
      (SELECT COUNT(*) FROM roster_members WHERE roster_id=r.id AND status='approved') approved,
      (SELECT COUNT(*) FROM roster_members WHERE roster_id=r.id AND status='pending') pending,
      (SELECT COUNT(*) FROM roster_entries WHERE roster_id=r.id) listed
      FROM rosters r WHERE owner_id=? ORDER BY r.archived,r.name`,
      )
      .all(owner) as unknown as RosterSummary[];
  }
  get(id: string, owner: string): RosterDetail {
    const row = this.list(owner).find((r) => r.id === id);
    if (!row) throw new DomainError('Roster not found.', 404);
    return {
      ...row,
      invitations: this.db
        .prepare(
          'SELECT id,email,name,identifier,token FROM roster_enrolment_invites WHERE roster_id=? AND claimed_account_id IS NULL ORDER BY created_at',
        )
        .all(id) as unknown as RosterDetail['invitations'],
      token: String(this.db.prepare('SELECT token FROM rosters WHERE id=?').get(id)!.token),
      entries: this.db
        .prepare('SELECT identifier,name FROM roster_entries WHERE roster_id=? ORDER BY identifier')
        .all(id) as unknown as RosterDetail['entries'],
      members: this.db
        .prepare(
          `SELECT a.id accountId,a.name,a.email,m.identifier,m.status identityStatus,r.status FROM roster_members r JOIN accounts a ON a.id=r.account_id JOIN memberships m ON m.account_id=a.id AND m.organization_id='default' WHERE r.roster_id=? ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,a.name,a.id`,
        )
        .all(id) as unknown as RosterDetail['members'],
    };
  }
  save(id: string, owner: string, input: Record<string, unknown>) {
    const name = text(input.name, 'Roster name', 160);
    if (!Array.isArray(input.entries) || input.entries.length > 500)
      throw new DomainError('Use at most 500 roster entries.');
    const entries = input.entries.map((value) => {
      const r = object(value);
      return { identifier: identifier(r.identifier), name: text(r.name, 'Candidate name', 160) };
    });
    if (new Set(entries.map((r) => r.identifier)).size !== entries.length)
      throw new DomainError('Candidate IDs must be unique.');
    if (
      typeof input.restricted !== 'boolean' ||
      typeof input.open !== 'boolean' ||
      typeof input.archived !== 'boolean'
    )
      throw new DomainError('Invalid roster settings.');
    if (input.restricted && !entries.length)
      throw new DomainError('Add an expected list before restricting membership.');
    transaction(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM rosters WHERE id=?').get(id);
      if (existing && existing.owner_id !== owner) throw new DomainError('Roster not found.', 404);
      if ((existing?.revision ?? 0) !== input.revision)
        throw new DomainError(
          'This roster changed. Reload before saving to avoid overwriting another change.',
          409,
        );
      if (existing)
        this.db
          .prepare(
            'UPDATE rosters SET name=?,restricted=?,is_open=?,archived=?,revision=revision+1,updated_at=? WHERE id=?',
          )
          .run(
            name,
            Number(input.restricted),
            Number(input.open),
            Number(input.archived),
            this.store.now(),
            id,
          );
      else
        this.db
          .prepare('INSERT INTO rosters VALUES(?,?,?,?,?,?,?,1,?)')
          .run(
            id,
            owner,
            name,
            token(),
            Number(input.restricted),
            Number(input.open),
            Number(input.archived),
            this.store.now(),
          );
      this.db.prepare('DELETE FROM roster_entries WHERE roster_id=?').run(id);
      for (const e of entries)
        this.db.prepare('INSERT INTO roster_entries VALUES(?,?,?)').run(id, e.identifier, e.name);
      this.store.event(null, owner, 'roster_saved', { rosterId: id, listed: entries.length });
    });
    return this.get(id, owner);
  }
  invitation(link: string, account?: string | null) {
    const r = this.db.prepare('SELECT * FROM rosters WHERE token=?').get(link);
    if (!r) throw new DomainError('Joining link not found.', 404);
    const member = account
      ? this.db
          .prepare('SELECT status FROM roster_members WHERE roster_id=? AND account_id=?')
          .get(r.id!, account)
      : null;
    return {
      name: String(r.name),
      accepting: Boolean(r.is_open && !r.archived),
      restricted: Boolean(r.restricted),
      status: member ? String(member.status) : null,
    };
  }
  join(link: string, account: string) {
    transaction(this.db, () => {
      const view = this.invitation(link, account);
      if (view.status) return;
      if (!view.accepting) throw new DomainError('This roster is closed to new requests.', 409);
      const r = this.db.prepare('SELECT id FROM rosters WHERE token=?').get(link)!;
      const profile = new IdentityService(this.store).profile(account);
      if (
        view.restricted &&
        !this.db
          .prepare('SELECT 1 FROM roster_entries WHERE roster_id=? AND identifier=?')
          .get(r.id!, profile.identifier)
      )
        throw new DomainError(
          'Your candidate number is not on this roster. Contact the assessment organiser.',
          403,
        );
      if (
        Number(
          this.db.prepare('SELECT COUNT(*) n FROM roster_members WHERE roster_id=?').get(r.id!)?.n,
        ) >= 2000
      )
        throw new DomainError('This roster’s request queue is full.', 409);
      this.db
        .prepare("INSERT INTO roster_members VALUES(?,?,'pending',?,NULL)")
        .run(r.id!, account, this.store.now());
      this.store.event(null, account, 'roster_join_requested', { rosterId: r.id });
    });
    return this.invitation(link, account);
  }
  review(id: string, owner: string, account: string, input: Record<string, unknown>) {
    transaction(this.db, () => {
      const roster = this.get(id, owner);
      if (roster.archived)
        throw new DomainError('Restore this roster before reviewing requests.', 409);
      const member = roster.members.find((m) => m.accountId === account);
      if (!member) throw new DomainError('Membership request not found.', 404);
      const decision = input.decision;
      if (!['approved', 'rejected', 'removed'].includes(String(decision)))
        throw new DomainError('Invalid membership decision.');
      if (member.status === decision) return;
      if (decision === 'approved') {
        if (roster.approved >= 500)
          throw new DomainError('A roster supports up to 500 approved members.', 409);
        if (roster.restricted && !roster.entries.some((e) => e.identifier === member.identifier))
          throw new DomainError('This candidate is not on the expected list.', 403);
        if (member.identityStatus !== 'verified') {
          if (
            this.db
              .prepare(
                'SELECT 1 FROM roster_enrolment_invites WHERE identifier=? AND email<>? LIMIT 1',
              )
              .get(member.identifier, member.email)
          )
            throw new DomainError(
              'This student number is reserved for another email address.',
              409,
            );
          if (
            this.db
              .prepare(
                "SELECT 1 FROM memberships WHERE organization_id='default' AND identifier=? AND status='verified' AND account_id<>?",
              )
              .get(member.identifier, account)
          )
            throw new DomainError(
              'This candidate number belongs to another verified account.',
              409,
            );
          this.db
            .prepare(
              "UPDATE memberships SET status='verified',verified_at=? WHERE account_id=? AND organization_id='default'",
            )
            .run(this.store.now(), account);
        }
      }
      this.db
        .prepare(
          'UPDATE roster_members SET status=?,reviewed_at=? WHERE roster_id=? AND account_id=?',
        )
        .run(decision === 'removed' ? 'rejected' : String(decision), this.store.now(), id, account);
      this.db
        .prepare('UPDATE rosters SET revision=revision+1,updated_at=? WHERE id=?')
        .run(this.store.now(), id);
      this.store.event(null, owner, 'roster_membership_reviewed', {
        rosterId: id,
        accountId: account,
        decision,
      });
    });
    return this.get(id, owner);
  }
  private bindNumber(accountId: string, number: string) {
    const account = new IdentityService(this.store).profile(accountId);
    if (
      this.db
        .prepare('SELECT 1 FROM roster_enrolment_invites WHERE email=? AND identifier<>? LIMIT 1')
        .get(account.email, number)
    )
      throw new DomainError(
        'An invitation for this email has a different student number. Use that number or cancel the unused invitation first.',
        409,
      );
    if (
      account.identityStatus === 'verified' &&
      !account.identifier.startsWith('ACCOUNT-') &&
      account.identifier !== number
    )
      throw new DomainError(
        'This account already has a different student number in this workspace. Use its existing number.',
        409,
      );
    const assigned = this.db
      .prepare(
        "SELECT account_id FROM memberships WHERE organization_id='default' AND identifier=? AND status='verified' AND account_id<>?",
      )
      .get(number, accountId);
    if (assigned)
      throw new DomainError(
        'This student number already belongs to another account in this workspace.',
        409,
      );
    const reserved = this.db
      .prepare('SELECT 1 FROM roster_enrolment_invites WHERE identifier=? AND email<>? LIMIT 1')
      .get(number, account.email);
    if (reserved)
      throw new DomainError('This student number is reserved for another email address.', 409);
    this.db
      .prepare(
        "UPDATE memberships SET identifier=?,status='verified',verified_at=? WHERE account_id=? AND organization_id='default'",
      )
      .run(number, this.store.now(), accountId);
  }
  private enrolAccount(id: string, accountId: string, number: string, actor: string) {
    const current = this.db
      .prepare('SELECT status FROM roster_members WHERE roster_id=? AND account_id=?')
      .get(id, accountId);
    const count = Number(
      this.db
        .prepare("SELECT COUNT(*) n FROM roster_members WHERE roster_id=? AND status='approved'")
        .get(id)?.n,
    );
    if (current?.status !== 'approved' && count >= 500)
      throw new DomainError('A roster supports up to 500 members.', 409);
    this.bindNumber(accountId, number);
    const profile = new IdentityService(this.store).profile(accountId);
    // Explicit organiser enrolment also places the member on any restricted eligibility list.
    this.db
      .prepare('INSERT OR IGNORE INTO roster_entries VALUES(?,?,?)')
      .run(id, number, profile.name);
    this.db
      .prepare(
        "INSERT INTO roster_members VALUES(?,?,'approved',?,?) ON CONFLICT(roster_id,account_id) DO UPDATE SET status='approved',reviewed_at=CASE WHEN roster_members.status='approved' THEN roster_members.reviewed_at ELSE excluded.reviewed_at END",
      )
      .run(id, accountId, this.store.now(), this.store.now());
    this.db
      .prepare('UPDATE rosters SET revision=revision+1,updated_at=? WHERE id=?')
      .run(this.store.now(), id);
    this.store.event(null, actor, 'candidate_enrolled', { rosterId: id, accountId });
  }
  enrol(id: string, owner: string, input: Record<string, unknown>) {
    transaction(this.db, () => {
      const roster = this.get(id, owner);
      if (roster.archived)
        throw new DomainError('Restore this roster before adding candidates.', 409);
      if (roster.revision !== input.revision)
        throw new DomainError('The roster changed. Refresh and try again.', 409);
      const email = emailAddress(input.email);
      const account = this.db.prepare('SELECT id,name FROM accounts WHERE email=?').get(email);
      const existing = this.db
        .prepare('SELECT * FROM roster_enrolment_invites WHERE roster_id=? AND email=?')
        .get(id, email);
      const profile = account ? new IdentityService(this.store).profile(String(account.id)) : null;
      const reservedForEmail = this.db
        .prepare('SELECT identifier FROM roster_enrolment_invites WHERE email=? LIMIT 1')
        .get(email);
      const number = input.identifier
        ? identifier(input.identifier)
        : String(
            reservedForEmail?.identifier ??
              profile?.identifier ??
              existing?.identifier ??
              `ACCOUNT-${randomUUID().toUpperCase()}`,
          );
      if (reservedForEmail && reservedForEmail.identifier !== number)
        throw new DomainError(
          'This email already has a reserved student number. Use it or cancel the unused invitation first.',
          409,
        );
      if (account) {
        if (input.accountId !== account.id)
          throw new DomainError('Select the existing account before enrolling it.', 409);
        this.enrolAccount(id, String(account.id), number, owner);
        this.db
          .prepare(
            'UPDATE roster_enrolment_invites SET claimed_account_id=? WHERE roster_id=? AND email=?',
          )
          .run(account.id!, id, email);
      } else {
        const name = text(input.name, 'Candidate name', 160);
        const assigned = this.db
          .prepare(
            "SELECT 1 FROM memberships WHERE organization_id='default' AND identifier=? AND status='verified'",
          )
          .get(number);
        const reserved = this.db
          .prepare('SELECT 1 FROM roster_enrolment_invites WHERE identifier=? AND email<>?')
          .get(number, email);
        if (assigned || reserved)
          throw new DomainError(
            'This student number is already assigned or reserved for another person.',
            409,
          );
        if (existing) {
          if (existing.identifier !== number || existing.name !== name)
            throw new DomainError(
              'An invitation already exists for this email. Share its existing link.',
              409,
            );
          return;
        }
        if (roster.approved + roster.invitations.length >= 500)
          throw new DomainError('A roster supports up to 500 members and invitations.', 409);
        this.db
          .prepare('INSERT INTO roster_enrolment_invites VALUES(?,?,?,?,?,?,?,NULL)')
          .run(randomUUID(), id, email, name, number, token(), this.store.now());
        this.db
          .prepare('UPDATE rosters SET revision=revision+1,updated_at=? WHERE id=?')
          .run(this.store.now(), id);
        this.store.event(null, owner, 'candidate_invited', { rosterId: id });
      }
    });
    return this.get(id, owner);
  }
  enrolmentInvitation(link: string) {
    const row = this.db
      .prepare(
        'SELECT i.*,r.name AS roster_name,r.is_open,r.archived FROM roster_enrolment_invites i JOIN rosters r ON r.id=i.roster_id WHERE i.token=?',
      )
      .get(link);
    if (!row) throw new DomainError('Invitation not found.', 404);
    return {
      name: String(row.roster_name),
      accepting: Boolean(row.is_open && !row.archived),
      claimed: Boolean(row.claimed_account_id),
    };
  }
  cancelInvitation(id: string, owner: string, invitationId: string, revision: unknown) {
    transaction(this.db, () => {
      const roster = this.get(id, owner);
      if (roster.revision !== revision)
        throw new DomainError('The roster changed. Refresh and try again.', 409);
      const invite = this.db
        .prepare(
          'SELECT claimed_account_id FROM roster_enrolment_invites WHERE id=? AND roster_id=?',
        )
        .get(invitationId, id);
      if (!invite) throw new DomainError('Invitation not found.', 404);
      if (invite.claimed_account_id)
        throw new DomainError(
          'This invitation was accepted. Manage the member in the roster.',
          409,
        );
      this.db
        .prepare('DELETE FROM roster_enrolment_invites WHERE id=? AND roster_id=?')
        .run(invitationId, id);
      this.db
        .prepare('UPDATE rosters SET revision=revision+1,updated_at=? WHERE id=?')
        .run(this.store.now(), id);
      this.store.event(null, owner, 'roster_invitation_cancelled', { rosterId: id, invitationId });
    });
    return this.get(id, owner);
  }
  claimEnrolment(link: string, accountId: string) {
    return transaction(this.db, () => {
      const invitation = this.enrolmentInvitation(link);
      const row = this.db
        .prepare('SELECT * FROM roster_enrolment_invites WHERE token=?')
        .get(link)!;
      const account = new IdentityService(this.store).profile(accountId);
      if (account.email !== row.email)
        throw new DomainError('Sign in with the email address the organiser invited.', 403);
      if (row.claimed_account_id && row.claimed_account_id !== accountId)
        throw new DomainError('This invitation has already been used.', 409);
      if (!row.claimed_account_id) {
        if (!invitation.accepting)
          throw new DomainError('Joining is closed. Contact the organiser.', 409);
        this.enrolAccount(String(row.roster_id), accountId, String(row.identifier), accountId);
        this.db
          .prepare('UPDATE roster_enrolment_invites SET claimed_account_id=? WHERE id=?')
          .run(accountId, row.id!);
      }
      return { enrolled: true };
    });
  }
  snapshot(id: string, owner: string, revision: unknown) {
    const r = this.get(id, owner);
    if (r.archived) throw new DomainError('Choose an active roster.', 409);
    if (r.revision !== revision)
      throw new DomainError(
        'Roster membership changed. Select the roster again to review the latest members.',
        409,
      );
    const members = r.members.filter(
      (m) => m.status === 'approved' && m.identityStatus === 'verified',
    );
    if (!members.length)
      throw new DomainError('Approve at least one roster member before creating this assessment.');
    return {
      roster: { id, name: r.name, revision: r.revision },
      candidates: members.map((m) => ({ name: m.name, identifier: m.identifier, credential: '' })),
    };
  }
  additions(assessmentId: string, owner: string, apply = false, revision?: unknown) {
    const link = this.db
      .prepare('SELECT * FROM assessment_rosters WHERE assessment_id=?')
      .get(assessmentId);
    if (!link) throw new DomainError('No roster is attached.', 404);
    const roster = this.get(String(link.roster_id), owner);
    const started = Boolean(
      this.db.prepare('SELECT id FROM sittings WHERE assessment_id=?').get(assessmentId),
    );
    const additions = roster.members.filter(
      (m) =>
        m.status === 'approved' &&
        m.identityStatus === 'verified' &&
        !this.db
          .prepare('SELECT 1 FROM registrations WHERE assessment_id=? AND account_id=?')
          .get(assessmentId, m.accountId),
    );
    if (apply)
      transaction(this.db, () => {
        if (revision !== roster.revision)
          throw new DomainError(
            'Roster membership changed. Refresh and review the new members again.',
            409,
          );
        if (started || roster.archived)
          throw new DomainError(
            'Candidates can only be added from an active roster before the examination starts.',
            409,
          );
        const count = Number(
          this.db
            .prepare('SELECT COUNT(*) n FROM registrations WHERE assessment_id=?')
            .get(assessmentId)?.n,
        );
        if (count + additions.length > 500)
          throw new DomainError('This assessment supports at most 500 candidates.', 409);
        for (const m of additions) {
          const candidateId = randomUUID();
          this.db
            .prepare('INSERT INTO candidates VALUES(?,?,?,?,?)')
            .run(candidateId, assessmentId, m.identifier, m.name, 'account-managed');
          this.db
            .prepare("INSERT INTO registrations VALUES(?,?,?,?,'approved',?,?)")
            .run(
              randomUUID(),
              assessmentId,
              m.accountId,
              candidateId,
              this.store.now(),
              this.store.now(),
            );
        }
        this.store.event(null, owner, 'roster_members_added_to_assessment', {
          assessmentId,
          rosterId: roster.id,
          count: additions.length,
        });
      });
    return {
      name: String(link.name),
      rosterId: roster.id,
      revision: Number(link.revision),
      currentRevision: roster.revision,
      started,
      additions: apply ? [] : additions,
    };
  }
}
