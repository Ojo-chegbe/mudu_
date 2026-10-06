-- Server-only online execution. Apply after assessment authoring.
-- The backend authenticates the actor before setting transaction-local identity.
begin;
do $$ begin
  if not exists(select 1 from pg_roles where rolname = 'mudu_execution') then
    create role mudu_execution nologin;
  end if;
end $$;
grant mudu_execution to postgres;

create table public.mudu_online_exams (
  id uuid primary key references public.mudu_authoring_documents(id),
  owner_id uuid not null references auth.users(id),
  definition jsonb not null check (jsonb_typeof(definition)='object' and octet_length(definition::text)<=1048576),
  source_revision bigint not null check(source_revision>0),
  source_digest text not null,
  roster_id uuid,
  created_at bigint not null,
  unique(id,owner_id)
);
create table public.mudu_online_members (
  exam_id uuid not null,
  owner_id uuid not null,
  account_id uuid not null references auth.users(id),
  candidate_id uuid not null unique,
  registration_id uuid not null unique,
  identifier text not null check(length(identifier) between 1 and 80),
  name text not null check(length(name) between 1 and 100),
  email text not null,
  status text not null check(status in ('pending','approved','rejected')),
  requested_at bigint not null,
  reviewed_at bigint,
  primary key(exam_id,account_id),
  unique(exam_id,identifier),
  foreign key(exam_id,owner_id) references public.mudu_online_exams(id,owner_id)
);
create table public.mudu_online_rows (
  exam_id uuid not null,
  owner_id uuid not null,
  table_name text not null check(table_name in (
    'registration_settings','sittings','attempts','responses','operations','manual_marks',
    'candidate_presence','exam_controls','exam_announcements','announcement_reads','exam_control_receipts','device_leases'
  )),
  row_key text not null check(length(row_key) between 1 and 240),
  candidate_id uuid references public.mudu_online_members(candidate_id),
  payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=1048576),
  primary key(exam_id,table_name,row_key),
  foreign key(exam_id,owner_id) references public.mudu_online_exams(id,owner_id)
);
create index mudu_online_rows_candidate on public.mudu_online_rows(exam_id,candidate_id,table_name);
create table public.mudu_online_events (
  id bigint generated always as identity primary key,
  exam_id uuid not null,
  owner_id uuid not null,
  sitting_id uuid,
  actor_id uuid not null,
  kind text not null check(length(kind) between 1 and 100),
  detail jsonb not null check(octet_length(detail::text)<=65536),
  created_at bigint not null,
  foreign key(exam_id,owner_id) references public.mudu_online_exams(id,owner_id)
);
create index mudu_online_events_recent on public.mudu_online_events(exam_id,id desc);

alter table public.mudu_online_exams enable row level security;
alter table public.mudu_online_members enable row level security;
alter table public.mudu_online_rows enable row level security;
alter table public.mudu_online_events enable row level security;
revoke all on public.mudu_online_exams,public.mudu_online_members,public.mudu_online_rows,public.mudu_online_events from public,anon,authenticated;
grant usage on schema public,auth to mudu_execution;
grant select,insert,update on public.mudu_online_exams,public.mudu_online_members,public.mudu_online_rows to mudu_execution;
grant select,insert on public.mudu_online_events to mudu_execution;
grant usage,select on sequence public.mudu_online_events_id_seq to mudu_execution;

create policy online_members_read on public.mudu_online_members for select to mudu_execution
  using(owner_id=auth.uid() or account_id=auth.uid());
create policy online_members_write on public.mudu_online_members for all to mudu_execution
  using(owner_id=auth.uid()) with check(owner_id=auth.uid());
create policy online_exams_read on public.mudu_online_exams for select to mudu_execution
  using(owner_id=auth.uid() or exists(select 1 from public.mudu_online_members m where m.exam_id=mudu_online_exams.id and m.account_id=auth.uid()));
create policy online_exams_write on public.mudu_online_exams for all to mudu_execution
  using(owner_id=auth.uid()) with check(owner_id=auth.uid());
create policy online_rows_read on public.mudu_online_rows for select to mudu_execution
  using(exam_id::text=current_setting('mudu.exam_id',true) and (
    owner_id=auth.uid() or exists(select 1 from public.mudu_online_members m where m.exam_id=mudu_online_rows.exam_id and m.account_id=auth.uid() and m.status='approved' and (mudu_online_rows.candidate_id is null or mudu_online_rows.candidate_id=m.candidate_id))
  ));
create policy online_rows_write on public.mudu_online_rows for all to mudu_execution
  using(exam_id::text=current_setting('mudu.exam_id',true) and (
    owner_id=auth.uid() or (table_name in ('attempts','responses','operations','candidate_presence','announcement_reads','device_leases') and exists(select 1 from public.mudu_online_members m where m.exam_id=mudu_online_rows.exam_id and m.account_id=auth.uid() and m.status='approved' and mudu_online_rows.candidate_id=m.candidate_id))
  )) with check(exam_id::text=current_setting('mudu.exam_id',true) and (
    owner_id=auth.uid() or (table_name in ('attempts','responses','operations','candidate_presence','announcement_reads','device_leases') and exists(select 1 from public.mudu_online_members m where m.exam_id=mudu_online_rows.exam_id and m.account_id=auth.uid() and m.status='approved' and mudu_online_rows.candidate_id=m.candidate_id))
  ));
create policy online_events_read on public.mudu_online_events for select to mudu_execution using(owner_id=auth.uid());
create policy online_events_insert on public.mudu_online_events for insert to mudu_execution
  with check(exam_id::text=current_setting('mudu.exam_id',true) and (
    owner_id=auth.uid() or exists(select 1 from public.mudu_online_members m where m.exam_id=mudu_online_events.exam_id and m.account_id=auth.uid() and m.status='approved' and m.candidate_id=mudu_online_events.actor_id)
  ));

-- Narrow functions expose no authoring documents, roster lists or auth records.
create function public.mudu_online_source(p_id uuid,p_revision bigint,p_digest text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d jsonb;
begin
  select document into d from public.mudu_authoring_documents
    where id=p_id and owner_id=auth.uid() and revision=p_revision and digest=p_digest for share;
  if not found then raise exception 'Source assessment changed. Refresh before publishing.' using errcode='M0004'; end if;
  return jsonb_build_object('rosterId',d->'roster'->>'id');
end $$;
create function public.mudu_online_admit(p_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare e public.mudu_online_exams; m public.mudu_roster_members; u uuid:=auth.uid(); n text; mail text; stamp bigint; s jsonb; c jsonb;
begin
  if u is null then return false; end if;
  if exists(select 1 from public.mudu_online_members where exam_id=p_id and account_id=u) then return true; end if;
  if not exists(select 1 from public.mudu_online_exams eligible_exam join public.mudu_roster_members r on r.roster_id=eligible_exam.roster_id and r.owner_id=eligible_exam.owner_id
    where eligible_exam.id=p_id and r.account_id=u and r.status='approved' and eligible_exam.definition->>'allowLateAdmission'='true') then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
  select * into e from public.mudu_online_exams where id=p_id;
  if not found or e.roster_id is null or e.definition->>'allowLateAdmission' is distinct from 'true' then return false; end if;
  if exists(select 1 from public.mudu_online_members where exam_id=p_id and account_id=u) then return true; end if;
  stamp:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  select payload into s from public.mudu_online_rows where exam_id=p_id and table_name='sittings';
  select payload into c from public.mudu_online_rows where exam_id=p_id and table_name='exam_controls';
  if s is null or c->>'paused_at' is not null or (s->>'deadline')::bigint<=stamp then return false; end if;
  if e.definition->'timing'->>'mode'='individual' and (e.definition->'timing'->>'lastStartAt')::bigint+coalesce((c->>'pause_total_ms')::bigint,0)<=stamp then return false; end if;
  select * into m from public.mudu_roster_members where roster_id=e.roster_id and owner_id=e.owner_id and account_id=u and status='approved';
  if not found then return false; end if;
  select email,coalesce(nullif(raw_user_meta_data->>'name',''),email) into mail,n from auth.users where id=u and email_confirmed_at is not null;
  if not found then return false; end if;
  if (select count(*) from public.mudu_online_members where exam_id=p_id)>=500 then return false; end if;
  insert into public.mudu_online_members values(p_id,e.owner_id,u,gen_random_uuid(),gen_random_uuid(),m.identifier,left(n,100),mail,'approved',stamp,stamp);
  insert into public.mudu_online_events(exam_id,owner_id,actor_id,kind,detail,created_at)
    values(p_id,e.owner_id,u,'roster_candidate_admitted',jsonb_build_object('accountId',u),stamp);
  return true;
end $$;
create function public.mudu_online_discover() returns setof uuid
language sql security definer set search_path='' as $$
  select e.id from public.mudu_online_exams e join public.mudu_roster_members m on m.roster_id=e.roster_id and m.owner_id=e.owner_id
  where m.account_id=auth.uid() and m.status='approved' and e.definition->>'allowLateAdmission'='true'
    and not exists(select 1 from public.mudu_online_members a where a.exam_id=e.id and a.account_id=auth.uid()) limit 500;
$$;
revoke all on function public.mudu_online_source(uuid,bigint,text),public.mudu_online_admit(uuid),public.mudu_online_discover() from public,anon,authenticated;
grant execute on function public.mudu_online_source(uuid,bigint,text),public.mudu_online_admit(uuid),public.mudu_online_discover() to mudu_execution;
commit;
