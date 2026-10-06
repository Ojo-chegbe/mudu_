import type { Assessment } from '../../packages/exam-core/model.ts';
import { DomainError } from '../../packages/exam-core/model.ts';
import { onlineTransaction } from './online-postgres.ts';
import type { OnlineDatabase } from './online-postgres.ts';
import { onlineRuntime } from './online-runtime.ts';
import type { ExecutionRow, OnlineMember } from './online-runtime.ts';
import { canonicalBank } from './cloud-question-bank.ts';

export type OnlineActor = { id: string; role: 'admin' | 'candidate'; device: string };
export type OnlineCommand =
  | {
      kind:
        | 'detail'
        | 'monitor'
        | 'end'
        | 'state'
        | 'start'
        | 'submit'
        | 'heartbeat'
        | 'claim'
        | 'rerun_source';
    }
  | { kind: 'control' | 'acknowledge' | 'admission'; input: Record<string, unknown> }
  | {
      kind: 'save';
      questionId: string;
      input: { value: unknown; expectedRevision: unknown; operationId: unknown };
    }
  | { kind: 'review'; candidateId: string }
  | { kind: 'mark'; candidateId: string; input: Record<string, unknown> };

export class OnlineExecution {
  readonly database: OnlineDatabase;
  constructor(database: OnlineDatabase) {
    this.database = database;
  }

  /** Publication pins both the paper and admitted identities in one transaction. */
  async publish(
    actor: OnlineActor,
    definition: Assessment,
    revision: number,
    digest: string,
    members: OnlineMember[],
    authorize: () => void = () => {},
  ) {
    if (actor.role !== 'admin') throw new DomainError('Administrator access required.', 403);
    return onlineTransaction(this.database, actor.id, definition.id, async (client) => {
      const source = (
        await client.query('SELECT public.mudu_online_source($1,$2,$3) AS metadata', [
          definition.id,
          revision,
          digest,
        ])
      ).rows[0].metadata;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [definition.id]);
      const existing = (
        await client.query(
          'SELECT id,source_revision,source_digest FROM mudu_online_exams WHERE id=$1',
          [definition.id],
        )
      ).rows[0];
      if (existing) {
        if (Number(existing.source_revision) !== revision || existing.source_digest !== digest)
          throw new DomainError(
            'This online examination already uses a published question paper. Create a new run for changes.',
            409,
          );
        authorize();
        return { id: definition.id };
      }
      if (
        !members.length ||
        members.length > 500 ||
        members.some(
          (m) => m.exam_id !== definition.id || m.owner_id !== actor.id || m.status !== 'approved',
        )
      )
        throw new DomainError(
          'Add approved, cloud-connected candidates before publishing online.',
          409,
        );
      const now = Number(
        (
          await client.query(
            'SELECT floor(extract(epoch from clock_timestamp())*1000)::bigint AS now',
          )
        ).rows[0].now,
      );
      await client.query(
        'INSERT INTO mudu_online_exams(id,owner_id,definition,source_revision,source_digest,created_at,roster_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          definition.id,
          actor.id,
          JSON.stringify(definition),
          revision,
          digest,
          now,
          source.rosterId,
        ],
      );
      await client.query(
        'INSERT INTO public.mudu_online_members SELECT * FROM jsonb_populate_recordset(NULL::public.mudu_online_members,$1::jsonb)',
        [JSON.stringify(members)],
      );
      const runtime = onlineRuntime(definition, actor.id, members, [], now);
      try {
        const sitting = runtime.store.launch(definition.id, actor.id);
        await this.persist(client, definition.id, actor.id, runtime.snapshot());
        await this.events(client, definition.id, actor.id, runtime);
        authorize();
        return { id: definition.id, sittingId: sitting.id };
      } finally {
        runtime.db.close();
      }
    });
  }

  async directory(actor: OnlineActor) {
    if (actor.role === 'candidate') {
      const ids = await onlineTransaction(this.database, actor.id, '', async (client) =>
        (await client.query('SELECT public.mudu_online_discover() AS id')).rows.map((r) =>
          String(r.id),
        ),
      );
      for (const id of ids)
        await onlineTransaction(this.database, actor.id, id, async (client) => {
          await client.query('SELECT public.mudu_online_admit($1)', [id]);
        });
    }
    return onlineTransaction(this.database, actor.id, '', async (client) => {
      const rows = (
        await client.query(
          'SELECT id,owner_id,definition,created_at FROM mudu_online_exams ORDER BY created_at DESC LIMIT 500',
        )
      ).rows;
      const result: unknown[] = [];
      for (const exam of rows) {
        await client.query("SELECT set_config('mudu.exam_id',$1,true)", [exam.id]);
        const full = { owner_id: exam.owner_id };
        const members = (
          await client.query('SELECT * FROM mudu_online_members WHERE exam_id=$1', [exam.id])
        ).rows as OnlineMember[];
        const stored = (
          await client.query(
            "SELECT table_name,row_key,candidate_id,payload FROM mudu_online_rows WHERE exam_id=$1 AND table_name IN ('sittings','exam_controls','registration_settings','attempts')",
            [exam.id],
          )
        ).rows as ExecutionRow[];
        const now = Number(
          (
            await client.query(
              'SELECT floor(extract(epoch from clock_timestamp())*1000)::bigint AS now',
            )
          ).rows[0].now,
        );
        const runtime = onlineRuntime(
          exam.definition,
          full.owner_id,
          members,
          stored,
          now,
          Number(exam.created_at),
        );
        try {
          if (actor.role === 'admin') {
            if (full.owner_id !== actor.id) continue;
            result.push({ ...runtime.store.listAssessments(full.owner_id)[0], delivery: 'online' });
          } else {
            const member = members.find((m) => m.account_id === actor.id);
            if (!member) continue;
            const sitting = runtime.db
              .prepare('SELECT id FROM sittings WHERE assessment_id=?')
              .get(exam.id);
            const view =
              member.status === 'approved' && sitting
                ? runtime.store.candidateView(String(sitting.id), member.candidate_id)
                : null;
            result.push({
              assessmentId: exam.id,
              title: exam.definition.title,
              course: exam.definition.course,
              durationMinutes: exam.definition.durationMinutes,
              questionCount: exam.definition.questions.length,
              registrationStatus: member.status,
              applicationNumber: null,
              delivery: 'online',
              timingMode: exam.definition.timing?.mode ?? 'shared',
              opensAt: exam.definition.timing?.opensAt ?? null,
              lastStartAt: exam.definition.timing?.lastStartAt ?? null,
              finishBy: exam.definition.timing?.finishBy ?? null,
              examStatus:
                view?.attempt?.status ??
                (view?.sitting.startRestriction === 'closed'
                  ? 'ended'
                  : view?.sitting.startRestriction === 'not_open'
                    ? 'upcoming'
                    : 'available'),
            });
          }
        } finally {
          runtime.db.close();
        }
      }
      return result;
    });
  }

  async command(
    actor: OnlineActor,
    examId: string,
    command: OnlineCommand,
    authorize: () => void = () => {},
  ) {
    const admin = [
      'detail',
      'monitor',
      'end',
      'control',
      'review',
      'mark',
      'admission',
      'rerun_source',
    ].includes(command.kind);
    if (admin !== (actor.role === 'admin'))
      throw new DomainError('This operation is not permitted.', 403);
    return onlineTransaction(this.database, actor.id, examId, async (client) => {
      if (!admin) await client.query('SELECT public.mudu_online_admit($1)', [examId]);
      const access = (
        await client.query('SELECT owner_id FROM mudu_online_exams WHERE id=$1', [examId])
      ).rows[0];
      if (!access || (admin && access.owner_id !== actor.id))
        throw new DomainError('Examination not found.', 404);
      if (
        !admin &&
        (
          await client.query(
            'SELECT status FROM mudu_online_members WHERE exam_id=$1 AND account_id=$2',
            [examId, actor.id],
          )
        ).rows[0]?.status !== 'approved'
      )
        throw new DomainError('You are not admitted to this examination.', 403);
      // Admin-wide interventions exclude candidate commands; independent candidates run concurrently.
      await client.query(
        admin
          ? 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))'
          : 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
        [examId],
      );
      const exam = (await client.query('SELECT * FROM mudu_online_exams WHERE id=$1', [examId]))
        .rows[0];
      if (!exam || (admin && exam.owner_id !== actor.id))
        throw new DomainError('Examination not found.', 404);
      if (!admin)
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1))', [
          examId + ':' + actor.id,
        ]);
      const members = (
        await client.query(
          'SELECT * FROM mudu_online_members WHERE exam_id=$1 ORDER BY candidate_id' +
            (admin ? ' FOR UPDATE' : ''),
          [examId],
        )
      ).rows as OnlineMember[];
      const member = members.find((m) => m.account_id === actor.id);
      if (!admin && (!member || member.status !== 'approved'))
        throw new DomainError('You are not admitted to this examination.', 403);
      const persisted = (
        await client.query(
          'SELECT table_name,row_key,candidate_id,payload FROM mudu_online_rows WHERE exam_id=$1',
          [examId],
        )
      ).rows;
      const lease = persisted.find(
        (r) => r.table_name === 'device_leases' && r.candidate_id === member?.candidate_id,
      );
      if (!admin && command.kind !== 'claim' && lease && lease.payload.device !== actor.device)
        throw new DomainError(
          'This examination is open on another device. Continue here to recover your saved work.',
          409,
          'ONLINE_DEVICE_CHANGED',
        );
      const now = Number(
        (
          await client.query(
            'SELECT floor(extract(epoch from clock_timestamp())*1000)::bigint AS now',
          )
        ).rows[0].now,
      );
      const rows = persisted.filter((r) => r.table_name !== 'device_leases') as ExecutionRow[];
      const runtime = onlineRuntime(
        exam.definition as Assessment,
        exam.owner_id,
        members,
        rows,
        now,
        Number(exam.created_at),
      );
      try {
        const before = new Map(
          rows.map((r) => [r.table_name + ':' + r.row_key, canonicalBank(r.payload)]),
        );
        const sitting = runtime.db
          .prepare('SELECT id FROM sittings WHERE assessment_id=?')
          .get(examId);
        if (!sitting) throw new DomainError('This examination has not opened.', 409);
        const sid = String(sitting.id),
          cid = member?.candidate_id ?? '';
        let result: unknown;
        switch (command.kind) {
          case 'rerun_source':
            if (runtime.store.listAssessments(actor.id)[0].status !== 'completed')
              throw new DomainError('Finish this assessment before preparing another run.', 409);
            result = { paper: exam.definition, members };
            break;
          case 'detail':
            result = {
              lateRosterAvailable: Boolean(exam.roster_id),
              ...runtime.store.detail(examId),
              events: (
                await client.query(
                  'SELECT id,kind,created_at,detail FROM mudu_online_events WHERE exam_id=$1 ORDER BY id DESC LIMIT 50',
                  [examId],
                )
              ).rows.map((e) => ({
                id: Number(e.id),
                kind: e.kind,
                createdAt: Number(e.created_at),
                reason: e.detail.reason ?? null,
                minutes: e.detail.minutes ?? null,
                candidateName:
                  members.find((m) => m.candidate_id === e.detail.candidateId)?.name ?? null,
              })),
            };
            break;
          case 'monitor':
            result = runtime.monitor.snapshot(examId);
            break;
          case 'end':
            result = runtime.store.end(examId, actor.id);
            break;
          case 'control':
            result = runtime.controls.perform(examId, actor.id, command.input);
            break;
          case 'admission':
            if (!exam.roster_id)
              throw new DomainError('This examination does not use a roster.', 409);
            result = runtime.store.setAdmission(examId, actor.id, command.input);
            await client.query('UPDATE mudu_online_exams SET definition=$2 WHERE id=$1', [
              examId,
              JSON.stringify(runtime.store.assessment(examId)),
            ]);
            break;
          case 'review':
            result = runtime.store.review(examId, command.candidateId);
            break;
          case 'mark':
            result = runtime.store.mark(examId, command.candidateId, command.input, actor.id);
            break;
          case 'state':
            result = runtime.store.candidateView(sid, cid);
            break;
          case 'start':
            runtime.store.start(sid, cid);
            result = runtime.store.candidateView(sid, cid);
            break;
          case 'save':
            result = runtime.store.save(sid, cid, command.questionId, command.input);
            break;
          case 'submit':
            runtime.store.submit(sid, cid);
            result = runtime.store.candidateView(sid, cid);
            break;
          case 'heartbeat':
            result = runtime.monitor.heartbeat(sid, cid);
            break;
          case 'acknowledge':
            result = runtime.controls.acknowledge(sid, cid, command.input);
            break;
          case 'claim':
            runtime.store.event(sid, cid, 'device_recovered', {});
            result = { recovered: true };
            break;
        }
        const changed: ExecutionRow[] = [];
        for (const row of runtime.snapshot()) {
          // Candidate reads can reconcile their own attempt but never rewrite shared metadata.
          if (!admin && row.candidate_id !== cid) continue;
          if (before.get(row.table_name + ':' + row.row_key) !== canonicalBank(row.payload))
            changed.push(row);
        }
        await this.persist(client, examId, exam.owner_id, changed);
        if (!admin && (!lease || command.kind === 'claim'))
          await client.query(
            "INSERT INTO mudu_online_rows VALUES($1,$2,'device_leases',$3::text,$3::uuid,$4) ON CONFLICT(exam_id,table_name,row_key) DO UPDATE SET payload=excluded.payload",
            [examId, exam.owner_id, cid, JSON.stringify({ device: actor.device, claimedAt: now })],
          );
        await this.events(client, examId, exam.owner_id, runtime);
        authorize(); // Re-check session validity after awaits, before committing any changes.
        return result;
      } finally {
        runtime.db.close();
      }
    });
  }

  private async persist(
    client: import('./online-postgres.ts').OnlineClient,
    exam: string,
    owner: string,
    rows: ExecutionRow[],
  ) {
    if (!rows.length) return;
    await client.query(
      `INSERT INTO public.mudu_online_rows(exam_id,owner_id,table_name,row_key,candidate_id,payload)
       SELECT $1,$2,r.table_name,r.row_key,r.candidate_id::uuid,r.payload FROM jsonb_to_recordset($3::jsonb) AS r(table_name text,row_key text,candidate_id text,payload jsonb)
       ON CONFLICT(exam_id,table_name,row_key) DO UPDATE SET payload=excluded.payload`,
      [exam, owner, JSON.stringify(rows)],
    );
  }
  private async events(
    client: import('./online-postgres.ts').OnlineClient,
    exam: string,
    owner: string,
    runtime: ReturnType<typeof onlineRuntime>,
  ) {
    const events = runtime.db
      .prepare('SELECT * FROM events ORDER BY id')
      .all()
      .map((e) => ({ ...e, detail: JSON.parse(String(e.detail)) }));
    if (!events.length) return;
    await client.query(
      `INSERT INTO public.mudu_online_events(exam_id,owner_id,sitting_id,actor_id,kind,detail,created_at)
      SELECT $1,$2,e.sitting_id::uuid,e.actor_id::uuid,e.kind,e.detail,e.created_at
      FROM jsonb_to_recordset($3::jsonb) AS e(sitting_id text,actor_id text,kind text,detail jsonb,created_at bigint)`,
      [exam, owner, JSON.stringify(events)],
    );
  }
}
