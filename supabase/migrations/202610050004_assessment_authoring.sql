begin;
create table public.mudu_authoring_documents (
  id uuid primary key,owner_id uuid not null references auth.users(id) on delete cascade,
  revision bigint not null check(revision>0),digest text not null check(digest ~ '^[a-f0-9]{64}$'),
  payload text not null check(octet_length(payload)<=1048576),
  document jsonb generated always as (payload::jsonb) stored,
  title text generated always as (coalesce(payload::jsonb->'input'->>'title',payload::jsonb->'draft'->'details'->>'title','')) stored,
  updated_at timestamptz not null default now()
);
create index mudu_authoring_owner on public.mudu_authoring_documents(owner_id,id);
alter table public.mudu_authoring_documents enable row level security;
create policy own_authoring on public.mudu_authoring_documents for select to authenticated using(owner_id=(select auth.uid()));
revoke all on public.mudu_authoring_documents from public,anon,authenticated;
grant select on public.mudu_authoring_documents to authenticated;

create function public.mudu_authoring_list() returns jsonb language sql stable security invoker set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'revision',revision,'digest',digest) order by id),'[]'::jsonb)
    from public.mudu_authoring_documents where owner_id=auth.uid();
$$;
create function public.mudu_authoring_read(p_id uuid) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare r public.mudu_authoring_documents;
begin
  select * into r from public.mudu_authoring_documents where id=p_id and owner_id=auth.uid();
  if not found then raise exception using errcode='P0002',message='Assessment not found'; end if;
  return jsonb_build_object('id',r.id,'revision',r.revision,'digest',r.digest,'payload',r.payload);
end $$;
create function public.mudu_authoring_write(p_expected_revision bigint,p_payload text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); d jsonb; target uuid; r public.mudu_authoring_documents; h text; a jsonb; q jsonb; c jsonb;
begin
  if u is null or not exists(select 1 from auth.users where id=u and email_confirmed_at is not null) then raise insufficient_privilege using message='Confirmed authentication required'; end if;
  if p_expected_revision is null or p_expected_revision<0 or p_payload is null or octet_length(p_payload)>1048576 then raise exception using errcode='22023',message='Invalid assessment'; end if;
  d:=p_payload::jsonb; target:=(d->>'id')::uuid;
  if target is null or d->>'version' is distinct from '1' or d->>'kind' is null or d->>'kind' not in ('draft','assessment') then raise exception using errcode='22023',message='Invalid assessment'; end if;
  if exists(select 1 from jsonb_object_keys(d) k where k not in ('version','id','kind','draft','input','executionHostId','registration','roster')) then raise exception using errcode='22023',message='Unsupported assessment fields'; end if;
  if d->>'kind'='draft' then
    if not d ? 'draft' then raise exception using errcode='22023',message='Missing draft'; end if;
    if d->'draft'<>'null'::jsonb then
      c:=d->'draft'; a:=c->'details';
      if c->>'requestId' is distinct from target::text or c->>'accessMode' is distinct from 'accounts' or c->'createdId' is distinct from 'null'::jsonb
        or jsonb_typeof(c->'step') is distinct from 'number' or (c->>'step')::numeric not between 0 and 3
        or jsonb_typeof(c->'candidates') is distinct from 'array' or jsonb_array_length(c->'candidates')>500
        or jsonb_typeof(c->'questions') is distinct from 'array' or jsonb_array_length(c->'questions') not between 1 and 200 then raise exception using errcode='22023',message='Invalid draft'; end if;
      if exists(select 1 from jsonb_object_keys(c) k where k not in ('requestId','createdId','step','useRoster','accessChoiceConfirmed','roster','details','questions','candidates','accessMode','registrationPolicy','registrationCloses','registrationCapacity','keysSaved')) then raise exception using errcode='22023',message='Unsupported draft fields'; end if;
      for q in select value from jsonb_array_elements(c->'candidates') loop
        if jsonb_typeof(q->'identifier') is distinct from 'string' or length(q->>'identifier')>80 or jsonb_typeof(q->'name') is distinct from 'string' or length(q->>'name')>100
          or q->>'credential' is distinct from '' or exists(select 1 from jsonb_object_keys(q) k where k not in ('identifier','name','credential')) then raise exception using errcode='22023',message='Credentials cannot be shared'; end if;
      end loop;
    end if;
  else
    a:=d->'input';
    if (d->>'executionHostId')::uuid is null or jsonb_typeof(d->'registration') is distinct from 'object'
      or d->'registration'->>'policy' is null or d->'registration'->>'policy' not in ('approval','roster')
      or d->'registration'->>'token' is null or (d->'registration'->>'token')!~'^[A-Za-z0-9_-]{32,128}$'
      or jsonb_typeof(d->'registration'->'open') is distinct from 'boolean'
      or jsonb_typeof(d->'registration'->'capacity') is distinct from 'number' or (d->'registration'->>'capacity')::numeric not between 1 and 500 then raise exception using errcode='22023',message='Invalid settings'; end if;
  end if;
  if a is not null then
    if jsonb_typeof(a) is distinct from 'object' or jsonb_typeof(a->'title') is distinct from 'string' or length(a->>'title')>180
      or jsonb_typeof(a->'course') is distinct from 'string' or length(a->>'course')>100 or jsonb_typeof(a->'instructions') is distinct from 'string' or length(a->>'instructions')>10000
      or jsonb_typeof(a->'durationMinutes') is distinct from 'number' or (a->>'durationMinutes')::numeric not between 1 and 480
      or jsonb_typeof(a->'passPercent') is distinct from 'number' or (a->>'passPercent')::numeric not between 0 and 100
      or jsonb_typeof(a->'shuffleQuestions') is distinct from 'boolean' or jsonb_typeof(a->'shuffleOptions') is distinct from 'boolean' then raise exception using errcode='22023',message='Invalid paper'; end if;
    if exists(select 1 from jsonb_object_keys(a) k where k not in ('title','course','instructions','durationMinutes','passPercent','shuffleQuestions','shuffleOptions','timing','allowLateAdmission','questions')) then raise exception using errcode='22023',message='Unsupported paper fields'; end if;
    c:=case when d->>'kind'='draft' then d->'draft' else a end;
    if jsonb_typeof(c->'questions') is distinct from 'array' or jsonb_array_length(c->'questions') not between 1 and 200 then raise exception using errcode='22023',message='Invalid questions'; end if;
    for q in select value from jsonb_array_elements(c->'questions') loop
      if q->>'type' is null or q->>'type' not in ('single','multiple','short') or jsonb_typeof(q->'prompt') is distinct from 'string' or length(q->>'prompt')>10000
        or jsonb_typeof(q->'marks') is distinct from 'number' or (q->>'marks')::numeric not between 1 and 100
        or jsonb_typeof(q->'options') is distinct from 'array' or jsonb_array_length(q->'options')>8
        or jsonb_typeof(q->'correctIndices') is distinct from 'array' or jsonb_array_length(q->'correctIndices')>8 then raise exception using errcode='22023',message='Invalid question'; end if;
      if exists(select 1 from jsonb_object_keys(q) k where k not in ('type','prompt','marks','options','correctIndices')) then raise exception using errcode='22023',message='Unsupported question fields'; end if;
    end loop;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text,72633));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target::text,72634));
  select * into r from public.mudu_authoring_documents where id=target for update;
  if found and r.owner_id<>u then raise insufficient_privilege using message='Assessment unavailable'; end if;
  if r.document->>'kind'='assessment' and (d->>'kind'<>'assessment' or d->>'executionHostId' is distinct from r.document->>'executionHostId') then raise exception using errcode='22023',message='Delivery authority cannot be reassigned by authoring'; end if;
  h:=encode(sha256(convert_to(p_payload,'UTF8')),'hex');
  if r.digest=h then return jsonb_build_object('id',target,'revision',r.revision,'digest',h); end if;
  if coalesce(r.revision,0)<>p_expected_revision then raise exception using errcode='M0001',message='Assessment changed'; end if;
  if r.id is null and (select count(*) from public.mudu_authoring_documents where owner_id=u)>=1000 then raise exception using errcode='22023',message='Assessment limit'; end if;
  if (select coalesce(sum(octet_length(payload)),0) from public.mudu_authoring_documents where owner_id=u and id<>target)+octet_length(p_payload)>33554432 then raise exception using errcode='22023',message='Workspace storage limit'; end if;
  insert into public.mudu_authoring_documents(id,owner_id,revision,digest,payload) values(target,u,coalesce(r.revision,0)+1,h,p_payload)
    on conflict(id) do update set revision=excluded.revision,digest=excluded.digest,payload=excluded.payload,updated_at=now();
  return jsonb_build_object('id',target,'revision',coalesce(r.revision,0)+1,'digest',h);
end $$;
revoke all on function public.mudu_authoring_list(),public.mudu_authoring_read(uuid),public.mudu_authoring_write(bigint,text) from public,anon;
grant execute on function public.mudu_authoring_list(),public.mudu_authoring_read(uuid),public.mudu_authoring_write(bigint,text) to authenticated;
commit;
