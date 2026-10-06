begin;
create table public.mudu_bank_workspaces (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null check(revision>0), digest text not null check(digest ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz not null default now()
);
create table public.mudu_bank_projects (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null, document jsonb not null,
  name text generated always as (document->>'name') stored,
  course text generated always as (document->>'course') stored,
  primary key(owner_id,id)
);
create table public.mudu_bank_questions (
  owner_id uuid not null, id uuid not null, project_id uuid not null, document jsonb not null,
  status text generated always as (document->>'status') stored,
  topic text generated always as (document->>'topic') stored,
  prompt text generated always as (document->'question'->>'prompt') stored,
  primary key(owner_id,id),
  foreign key(owner_id,project_id) references public.mudu_bank_projects(owner_id,id) on delete cascade
);
create index mudu_bank_project_questions on public.mudu_bank_questions(owner_id,project_id,status);
alter table public.mudu_bank_workspaces enable row level security;
alter table public.mudu_bank_projects enable row level security;
alter table public.mudu_bank_questions enable row level security;
create policy own_bank_workspace on public.mudu_bank_workspaces for select to authenticated using(owner_id=(select auth.uid()));
create policy own_bank_projects on public.mudu_bank_projects for select to authenticated using(owner_id=(select auth.uid()));
create policy own_bank_questions on public.mudu_bank_questions for select to authenticated using(owner_id=(select auth.uid()));
revoke all on public.mudu_bank_workspaces,public.mudu_bank_projects,public.mudu_bank_questions from public,anon,authenticated;
grant select on public.mudu_bank_workspaces,public.mudu_bank_projects,public.mudu_bank_questions to authenticated;

create function public.mudu_bank_metadata() returns jsonb language sql stable security invoker set search_path='' as $$
  select coalesce((select jsonb_build_object('revision',revision,'digest',digest) from public.mudu_bank_workspaces where owner_id=auth.uid()),jsonb_build_object('revision',0,'digest',''));
$$;
create function public.mudu_read_bank() returns jsonb language sql stable security invoker set search_path='' as $$
  select public.mudu_bank_metadata() || jsonb_build_object('snapshot',jsonb_build_object('version',1,
    'projects',coalesce((select jsonb_agg(document order by id) from public.mudu_bank_projects where owner_id=auth.uid()),'[]'::jsonb),
    'questions',coalesce((select jsonb_agg(document order by id) from public.mudu_bank_questions where owner_id=auth.uid()),'[]'::jsonb)));
$$;
create function public.mudu_write_bank(p_expected_revision bigint,p_payload text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); snapshot jsonb; current_revision bigint; current_digest text;
  next_revision bigint; new_digest text; p jsonb; q jsonb;
begin
  if u is null then raise insufficient_privilege using message='Authentication required'; end if;
  if p_expected_revision is null or p_expected_revision<0 or p_payload is null or octet_length(p_payload)>8388608 then
    raise exception using errcode='22023',message='Invalid question bank'; end if;
  snapshot:=p_payload::jsonb;
  if snapshot->>'version' is distinct from '1' or jsonb_typeof(snapshot->'projects') is distinct from 'array'
    or jsonb_typeof(snapshot->'questions') is distinct from 'array' then
    raise exception using errcode='22023',message='Invalid question bank'; end if;
  if jsonb_array_length(snapshot->'projects')>500 or jsonb_array_length(snapshot->'questions')>10000 then
    raise exception using errcode='22023',message='Question bank too large'; end if;
  for p in select value from jsonb_array_elements(snapshot->'projects') loop
    if jsonb_typeof(p) is distinct from 'object' or (p->>'id')::uuid is null
      or jsonb_typeof(p->'name') is distinct from 'string' or length(p->>'name') not between 1 and 120
      or jsonb_typeof(p->'archived') is distinct from 'boolean'
      or jsonb_typeof(p->'course') is distinct from 'string' or length(p->>'course')>100
      or jsonb_typeof(p->'description') is distinct from 'string' or length(p->>'description')>1000
      or jsonb_typeof(p->'updatedAt') is distinct from 'number' or (p->>'updatedAt')::bigint<0
      or jsonb_typeof(p->'revision') is distinct from 'number' or (p->>'revision')::bigint not between 1 and 9007199254740991 then
      raise exception using errcode='22023',message='Invalid project'; end if;
  end loop;
  for q in select value from jsonb_array_elements(snapshot->'questions') loop
    if jsonb_typeof(q) is distinct from 'object' or (q->>'id')::uuid is null or (q->>'projectId')::uuid is null
      or q->>'status' is null or q->>'status' not in ('draft','approved','archived')
      or q->>'origin' is null or q->>'origin' not in ('manual','ai')
      or q->'question'->>'type' is null or q->'question'->>'type' not in ('single','multiple','short')
      or jsonb_typeof(q->'question'->'prompt') is distinct from 'string'
      or length(q->'question'->>'prompt') not between 1 and 10000
      or jsonb_typeof(q->'revision') is distinct from 'number' or (q->>'revision')::bigint not between 1 and 9007199254740991
      or jsonb_typeof(q->'updatedAt') is distinct from 'number' or (q->>'updatedAt')::bigint<0
      or jsonb_typeof(q->'tags') is distinct from 'array' or jsonb_array_length(q->'tags')>10
      or jsonb_typeof(q->'question'->'options') is distinct from 'array' or jsonb_array_length(q->'question'->'options')>8
      or jsonb_typeof(q->'question'->'correctIndices') is distinct from 'array' or jsonb_array_length(q->'question'->'correctIndices')>8
      or jsonb_typeof(q->'question'->'marks') is distinct from 'number' or (q->'question'->>'marks')::integer not between 1 and 100
      or jsonb_typeof(q->'course') is distinct from 'string' or length(q->>'course')>100
      or jsonb_typeof(q->'topic') is distinct from 'string' or length(q->>'topic')>100
      or q->>'difficulty' is null or q->>'difficulty' not in ('easy','medium','hard')
      or jsonb_typeof(q->'evidence') is distinct from 'string' or length(q->>'evidence')>10000
      or jsonb_typeof(q->'explanation') is distinct from 'string' or length(q->>'explanation')>10000
      or jsonb_typeof(q->'creationFingerprint') is distinct from 'string' or (q->>'creationFingerprint')!~'^[a-f0-9]{64}$'
      or coalesce(jsonb_typeof(q->'model'),'missing') not in ('null','string') or length(q->>'model')>200
      or coalesce(jsonb_typeof(q->'deletedAt'),'missing') not in ('null','number') or (q->>'deletedAt')::bigint<0 then
      raise exception using errcode='22023',message='Invalid question'; end if;
  end loop;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text,72631));
  select revision,digest into current_revision,current_digest from public.mudu_bank_workspaces where owner_id=u for update;
  new_digest:=encode(sha256(convert_to(p_payload,'UTF8')),'hex');
  if current_digest=new_digest then return jsonb_build_object('revision',current_revision,'digest',current_digest); end if;
  if coalesce(current_revision,0)<>p_expected_revision then
    raise exception using errcode='M0001',message='Question bank changed'; end if;
  next_revision:=coalesce(current_revision,0)+1;
  delete from public.mudu_bank_questions where owner_id=u;
  delete from public.mudu_bank_projects where owner_id=u;
  insert into public.mudu_bank_projects(owner_id,id,document) select u,(value->>'id')::uuid,value from jsonb_array_elements(snapshot->'projects');
  insert into public.mudu_bank_questions(owner_id,id,project_id,document)
    select u,(value->>'id')::uuid,(value->>'projectId')::uuid,value from jsonb_array_elements(snapshot->'questions');
  insert into public.mudu_bank_workspaces(owner_id,revision,digest) values(u,next_revision,new_digest)
    on conflict(owner_id) do update set revision=excluded.revision,digest=excluded.digest,updated_at=now();
  return jsonb_build_object('revision',next_revision,'digest',new_digest);
end $$;
revoke all on function public.mudu_bank_metadata(),public.mudu_read_bank(),public.mudu_write_bank(bigint,text) from public,anon;
grant execute on function public.mudu_bank_metadata(),public.mudu_read_bank(),public.mudu_write_bank(bigint,text) to authenticated;
commit;
