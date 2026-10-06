import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ExamStore, Session } from './store.ts';
import type { CloudAdministrators } from './cloud-administrators.ts';
import type { CloudAuthoring } from './cloud-authoring.ts';
import type { OnlineExecution, OnlineActor, OnlineCommand } from './online-execution.ts';
import type { OnlineMember } from './online-runtime.ts';
import { DomainError } from '../../packages/exam-core/model.ts';
import { digest } from './security.ts';
import { randomUUID } from 'node:crypto';
import { resultsDisposition } from './export-filename.ts';
import type { AssessmentDetail } from '../../packages/contracts/http.ts';
import type { Assessment } from '../../packages/exam-core/model.ts';
import { AssessmentEditing } from './assessment-editing.ts';
import type { CloudRosters } from './cloud-rosters.ts';

export async function onlineHttp(context: {
  request: IncomingMessage;
  response: ServerResponse;
  path: string;
  method: string;
  store: ExamStore;
  cloud: CloudAdministrators | null;
  authoring: CloudAuthoring;
  rosters?: CloudRosters | null;
  online?: OnlineExecution;
  candidateListener?: boolean;
  raw: string;
  requireSession: (role?: 'admin' | 'candidate') => Session;
  body: () => Promise<Record<string, unknown>>;
  send: (status: number, value: unknown) => void;
}): Promise<boolean> {
  const c = context;
  const publish = c.path.match(/^\/api\/assessments\/([a-f0-9-]{36})\/online$/);
  if (!publish && !c.path.startsWith('/api/online/')) return false;
  const role = publish || c.path.startsWith('/api/online/assessments') ? 'admin' : 'candidate';
  const session = c.requireSession(role);
  if (publish && c.method === 'GET') {
    c.store.assertOwner(publish[1], session.principal_id);
    c.send(200, {
      enabled: Boolean(c.online && c.cloud && !c.candidateListener),
      published: Boolean(
        c.store.db
          .prepare(
            "SELECT 1 FROM events WHERE kind='online_exam_published' AND json_extract(detail,'$.assessmentId')=?",
          )
          .get(publish[1]),
      ),
    });
    return true;
  }
  if (!c.online || !c.cloud || c.candidateListener)
    throw new DomainError(
      'Online delivery is not configured on this server.',
      503,
      'ONLINE_SETUP_REQUIRED',
    );
  const provider = c.store.db
    .prepare('SELECT provider_user_id FROM provider_sessions WHERE token_hash=?')
    .get(digest(c.raw));
  if (!provider)
    throw new DomainError(
      'Sign in to your cloud account to use online examinations.',
      401,
      'UNAUTHENTICATED',
    );
  const actor: OnlineActor = { id: String(provider.provider_user_id), role, device: digest(c.raw) };
  const authorize = () => {
    const current = c.requireSession(role);
    if (
      current.principal_id !== session.principal_id ||
      !c.store.db
        .prepare('SELECT 1 FROM provider_sessions WHERE token_hash=? AND provider_user_id=?')
        .get(digest(c.raw), actor.id)
    )
      throw new DomainError('Please sign in again.', 401, 'UNAUTHENTICATED');
  };
  if (publish && c.method === 'POST') {
    await c.body();
    c.store.assertOwner(publish[1], session.principal_id);
    await c.authoring.ensure(session.principal_id, true, publish[1]);
    authorize();
    const source = c.authoring.preparedSource(session.principal_id, publish[1]);
    const approved = c.store.db
      .prepare(
        "SELECT c.identifier,a.name,a.email,b.provider_user_id FROM registrations r JOIN accounts a ON a.id=r.account_id JOIN candidates c ON c.id=r.candidate_id LEFT JOIN candidate_provider_identities b ON b.account_id=a.id WHERE r.assessment_id=? AND r.status='approved'",
      )
      .all(publish[1]);
    if (approved.some((m) => !m.provider_user_id))
      throw new DomainError(
        'All admitted candidates must connect their cloud accounts before online delivery.',
        409,
      );
    const members: OnlineMember[] = approved.map((m) => ({
      exam_id: publish[1],
      owner_id: actor.id,
      account_id: String(m.provider_user_id),
      candidate_id: randomUUID(),
      registration_id: randomUUID(),
      identifier: String(m.identifier),
      name: String(m.name),
      email: String(m.email),
      status: 'approved',
      requested_at: c.store.now(),
      reviewed_at: c.store.now(),
    }));
    const result = await c.online.publish(
      actor,
      c.store.assessment(publish[1]),
      source.revision,
      source.digest,
      members,
      authorize,
    );
    c.store.event(null, session.principal_id, 'online_exam_published', {
      assessmentId: publish[1],
    });
    c.send(200, result);
    return true;
  }
  if (
    c.method === 'GET' &&
    ['/api/online/assessments', '/api/online/candidate/examinations'].includes(c.path)
  ) {
    const examinations = await c.online.directory(actor);
    authorize();
    c.send(200, { examinations });
    return true;
  }
  const match = c.path.match(
    /^\/api\/online\/(assessments|candidate\/examinations)\/([a-f0-9-]{36})(?:\/(.*))?$/,
  );
  if (!match) throw new DomainError('Online examination route not found.', 404);
  const id = match[2],
    action = match[3] ?? '';
  let command: OnlineCommand | undefined;
  if (role === 'admin') {
    if (c.method === 'POST' && action === 'rerun') {
      const input = await c.body();
      const source = (await c.online.command(actor, id, { kind: 'rerun_source' }, authorize)) as {
        paper: Assessment;
        members: OnlineMember[];
      };
      await c.authoring.ensure(session.principal_id, true, id);
      await c.rosters?.ensure(session.principal_id, true);
      authorize();
      c.store.assertOwner(id, session.principal_id);
      const value = new AssessmentEditing(c.store).rerun(id, session.principal_id, input, {
        paper: source.paper,
        candidates: () =>
          input.includeCandidates === true
            ? source.members
                .filter((m) => m.status === 'approved')
                .map((m) => {
                  const binding = c.store.db
                    .prepare(
                      'SELECT account_id FROM candidate_provider_identities WHERE provider_user_id=?',
                    )
                    .get(m.account_id);
                  let accountId = binding ? String(binding.account_id) : m.account_id;
                  if (!binding) {
                    if (
                      c.store.db
                        .prepare('SELECT 1 FROM accounts WHERE id=? OR email=?')
                        .get(accountId, m.email)
                    )
                      throw new DomainError(
                        'A candidate already has a local account. Connect it to their cloud account before reusing this list, or choose a roster.',
                        409,
                      );
                    c.store.db
                      .prepare('INSERT INTO accounts VALUES(?,?,?,?,?)')
                      .run(accountId, m.email, m.name, 'supabase-managed', c.store.now());
                    c.store.db
                      .prepare('INSERT INTO memberships VALUES(?,?,?,?,?,NULL)')
                      .run(randomUUID(), accountId, 'default', 'ACCOUNT-' + accountId, 'pending');
                    c.store.db
                      .prepare('INSERT INTO candidate_provider_identities VALUES(?,?)')
                      .run(accountId, m.account_id);
                  }
                  return {
                    account_id: accountId,
                    identifier: m.identifier,
                    name: m.name,
                    serial: /^APP-\d+$/.test(m.identifier) ? Number(m.identifier.slice(4)) : 0,
                  };
                })
            : [],
      });
      c.authoring.changed(session.principal_id);
      c.send(200, value);
      return true;
    }
    if (c.method === 'GET' && action === 'results.csv') {
      const detail = (await c.online.command(
        actor,
        id,
        { kind: 'detail' },
        authorize,
      )) as AssessmentDetail;
      const cell = (value: unknown) => {
        let v = String(value ?? '');
        if (/^[\s]*[=+\-@]|^[\t\r\n]/.test(v)) v = "'" + v;
        return '"' + v.replaceAll('"', '""') + '"';
      };
      const rows: unknown[][] = [
        [
          'Candidate ID',
          'Name',
          'Status',
          'Objective score',
          'Manual score',
          'Total score',
          'Maximum score',
          'Pending manual',
          'Percentage',
          'Pass',
          'Submitted at',
        ],
      ];
      for (const candidate of detail.candidates)
        rows.push([
          candidate.identifier,
          candidate.name,
          candidate.status,
          candidate.grade?.objectiveScore,
          candidate.grade?.manualScore,
          candidate.grade?.totalScore,
          candidate.grade?.maximumScore,
          candidate.grade?.pendingManual,
          candidate.grade?.percentage,
          candidate.grade?.passed == null ? '' : candidate.grade.passed ? 'Yes' : 'No',
          candidate.submittedAt ? new Date(candidate.submittedAt).toISOString() : '',
        ]);
      c.response.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': resultsDisposition(detail.assessment.title),
      });
      c.response.end('\uFEFF' + rows.map((row) => row.map(cell).join(',')).join('\r\n'));
      return true;
    }
    if (c.method === 'GET' && !action) command = { kind: 'detail' };
    if (c.method === 'GET' && action === 'monitor') command = { kind: 'monitor' };
    if (c.method === 'POST' && action === 'end') {
      await c.body();
      command = { kind: 'end' };
    }
    if (c.method === 'POST' && action === 'controls')
      command = { kind: 'control', input: await c.body() };
    if (c.method === 'POST' && action === 'admission')
      command = { kind: 'admission', input: await c.body() };
    const review = action.match(/^review\/([a-f0-9-]{36})$/);
    if (review && c.method === 'GET') command = { kind: 'review', candidateId: review[1] };
    if (review && c.method === 'POST')
      command = { kind: 'mark', candidateId: review[1], input: await c.body() };
  } else {
    if (c.method === 'GET' && action === 'state') command = { kind: 'state' };
    if (c.method === 'POST' && ['start', 'submit', 'heartbeat', 'claim'].includes(action)) {
      await c.body();
      command = { kind: action as 'start' | 'submit' | 'heartbeat' | 'claim' };
    }
    if (c.method === 'POST' && action === 'announcements/read')
      command = { kind: 'acknowledge', input: await c.body() };
    const answer = action.match(/^answers\/([a-f0-9-]{36})$/);
    if (answer && c.method === 'PUT') {
      const input = await c.body();
      command = {
        kind: 'save',
        questionId: answer[1],
        input: {
          value: input.value,
          expectedRevision: input.expectedRevision,
          operationId: input.operationId,
        },
      };
    }
  }
  if (!command) throw new DomainError('Online examination operation not found.', 404);
  const value = await c.online.command(actor, id, command, authorize);
  c.send(200, command.kind === 'detail' ? { ...(value as object), delivery: 'online' } : value);
  return true;
}
