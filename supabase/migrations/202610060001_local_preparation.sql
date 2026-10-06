begin;
create table public.mudu_local_preparations (
  id uuid primary key, owner_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null references public.mudu_authoring_documents(id),
  source_revision bigint not null, source_digest text not null,
  host_id uuid not null, run_id uuid not null unique,
  title text not null, course text not null, expires_at bigint not null,
  sealed text not null check(octet_length(sealed)<=4194304),
  digest text not null check(digest ~ '^[a-f0-9]{64}$'),
  state text not null default 'prepared' check(state in ('prepared','completed','cancelled')),
  created_at timestamptz not null default now()
);
create unique index mudu_local_open_source on public.mudu_local_preparations(source_id) where state='prepared';
create table public.mudu_local_admission (
  preparation_id uuid not null references public.mudu_local_preparations(id) on delete cascade,
  account_id uuid not null references auth.users(id) on delete cascade,
  candidate_id uuid not null, registration_id uuid not null,
  identifier text not null, pass jsonb not null,
  downloaded_at bigint,
  primary key(preparation_id,account_id), unique(preparation_id,identifier), unique(candidate_id), unique(registration_id)
);
alter table public.mudu_local_preparations enable row level security;
alter table public.mudu_local_admission enable row level security;
-- Access is only through scoped functions. Neither candidates nor owners can read
-- another candidate's credentials or the sealed package through REST tables.
revoke all on public.mudu_local_preparations,public.mudu_local_admission from public,anon,authenticated;

create function public.mudu_prepare_local(p_document jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); target uuid; source uuid; r public.mudu_local_preparations;
  a public.mudu_authoring_documents; m jsonb; ticket jsonb; expiry bigint; h text;
begin
  if u is null or not exists(select 1 from auth.users where id=u and email_confirmed_at is not null) then raise insufficient_privilege using message='Confirmed authentication required'; end if;
  if jsonb_typeof(p_document) is distinct from 'object' or octet_length(p_document::text)>8388608 then raise exception using errcode='22023',message='Invalid package'; end if;
  if exists(select 1 from jsonb_object_keys(p_document) k where k not in ('id','sourceId','sourceRevision','sourceDigest','hostId','runId','expiresAt','title','course','sealed','digest','members')) then raise exception using errcode='22023',message='Unsupported package fields'; end if;
  target:=(p_document->>'id')::uuid; source:=(p_document->>'sourceId')::uuid;
  expiry:=(p_document->>'expiresAt')::bigint;
  if target is null or source is null or (p_document->>'hostId')::uuid is null or (p_document->>'runId')::uuid is null
    or jsonb_typeof(p_document->'sealed') is distinct from 'string' or octet_length(p_document->>'sealed')>4194304
    or jsonb_typeof(p_document->'title') is distinct from 'string' or length(p_document->>'title') not between 1 and 180
    or jsonb_typeof(p_document->'course') is distinct from 'string' or length(p_document->>'course')>100
    or jsonb_typeof(p_document->'members') is distinct from 'array' or jsonb_array_length(p_document->'members') not between 1 and 500 then raise exception using errcode='22023',message='Invalid package'; end if;
  h:=encode(sha256(convert_to(p_document->>'sealed','UTF8')),'hex');
  if h is distinct from p_document->>'digest' then raise exception using errcode='22023',message='Package digest mismatch'; end if;
  -- Same source lock as authoring CAS prevents a paper update racing preparation.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text,72633));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(source::text,72634));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target::text,72635));
  select * into r from public.mudu_local_preparations where id=target for update;
  if found then
    if r.owner_id<>u then raise insufficient_privilege using message='Package unavailable'; end if;
    if r.digest<>h or r.source_id<>source or r.host_id is distinct from (p_document->>'hostId')::uuid or r.run_id is distinct from (p_document->>'runId')::uuid or r.state<>'prepared' then raise exception using errcode='M0001',message='Package changed'; end if;
    -- A retry acknowledges the immutable original, even after source authoring changes.
    return jsonb_build_object('id',target,'digest',h);
  end if;
  if expiry is null or expiry<=extract(epoch from now())*1000 or expiry>extract(epoch from now())*1000+2592000000 then raise exception using errcode='22023',message='Invalid access expiry'; end if;
  select * into a from public.mudu_authoring_documents where id=source and owner_id=u for update;
  if not found then raise insufficient_privilege using message='Assessment unavailable'; end if;
  if a.document->>'kind'<>'assessment' or a.revision is distinct from (p_document->>'sourceRevision')::bigint or a.digest is distinct from p_document->>'sourceDigest'
    or exists(select 1 from public.mudu_local_preparations where source_id=source and state='prepared') then raise exception using errcode='M0001',message='Assessment changed or reserved'; end if;
  if (select count(*) from public.mudu_local_preparations where owner_id=u)>=100
    or (select coalesce(sum(octet_length(sealed)),0) from public.mudu_local_preparations where owner_id=u)+octet_length(p_document->>'sealed')>33554432 then raise exception using errcode='22023',message='Preparation storage limit'; end if;
  for m in select value from jsonb_array_elements(p_document->'members') loop
    ticket:=m->'pass';
    if jsonb_typeof(m) is distinct from 'object' or exists(select 1 from jsonb_object_keys(m) k where k not in ('accountId','name','email','identifier','candidateId','registrationId','pass'))
      or jsonb_typeof(m->'name') is distinct from 'string' or length(m->>'name') not between 1 and 100
      or jsonb_typeof(m->'identifier') is distinct from 'string' or length(m->>'identifier') not between 1 and 80
      or (m->>'candidateId')::uuid is null or (m->>'registrationId')::uuid is null
      or not exists(select 1 from auth.users where id=(m->>'accountId')::uuid and lower(email)=lower(m->>'email') and email_confirmed_at is not null)
      or jsonb_typeof(ticket) is distinct from 'object' then raise exception using errcode='22023',message='Invalid candidate identity'; end if;
    if exists(select 1 from jsonb_object_keys(ticket) k where k not in ('version','preparationId','runId','hostId','accountId','candidateId','credential','expiresAt','title'))
      or ticket->>'version' is distinct from '1' or ticket->>'preparationId' is distinct from target::text
      or ticket->>'runId' is distinct from p_document->>'runId' or ticket->>'hostId' is distinct from p_document->>'hostId'
      or ticket->>'accountId' is distinct from m->>'accountId' or ticket->>'candidateId' is distinct from m->>'candidateId'
      or (ticket->>'expiresAt')::bigint is distinct from expiry or ticket->>'title' is distinct from p_document->>'title'
      or ticket->>'credential' is null or (ticket->>'credential')!~'^[A-Za-z0-9_-]{43}$' then raise exception using errcode='22023',message='Invalid admission proof'; end if;
  end loop;
  insert into public.mudu_local_preparations(id,owner_id,source_id,source_revision,source_digest,host_id,run_id,title,course,expires_at,sealed,digest)
    values(target,u,source,a.revision,a.digest,(p_document->>'hostId')::uuid,(p_document->>'runId')::uuid,p_document->>'title',p_document->>'course',expiry,p_document->>'sealed',h);
  insert into public.mudu_local_admission(preparation_id,account_id,candidate_id,registration_id,identifier,pass)
    select target,(value->>'accountId')::uuid,(value->>'candidateId')::uuid,(value->>'registrationId')::uuid,value->>'identifier',value->'pass' from jsonb_array_elements(p_document->'members');
  return jsonb_build_object('id',target,'digest',h);
exception when invalid_text_representation or numeric_value_out_of_range or unique_violation then raise exception using errcode='22023',message='Invalid package identities';
end $$;

create function public.mudu_close_local(p_id uuid,p_state text) returns void
language plpgsql security definer set search_path='' as $$
declare r public.mudu_local_preparations;
begin
  if p_state is null or p_state not in ('completed','cancelled') then raise exception using errcode='22023',message='Invalid state'; end if;
  select * into r from public.mudu_local_preparations where id=p_id and owner_id=auth.uid() for update;
  if not found then raise exception using errcode='P0002',message='Preparation unavailable'; end if;
  if r.state<>'prepared' and r.state<>p_state then raise exception using errcode='M0001',message='Preparation already closed'; end if;
  update public.mudu_local_preparations set state=p_state where id=p_id;
end $$;
create function public.mudu_local_status(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from public.mudu_local_preparations where id=p_id and owner_id=auth.uid()) then raise exception using errcode='P0002',message='Preparation unavailable'; end if;
  return jsonb_build_object('downloaded',(select count(*) from public.mudu_local_admission where preparation_id=p_id and downloaded_at is not null));
end $$;
create function public.mudu_candidate_local_passes() returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('preparationId',p.id,'runId',p.run_id,'title',p.title,'course',p.course,'expiresAt',p.expires_at,'downloadedAt',a.downloaded_at) order by p.created_at desc),'[]'::jsonb)
  from public.mudu_local_preparations p join public.mudu_local_admission a on a.preparation_id=p.id
  where a.account_id=auth.uid() and p.state='prepared' and p.expires_at>extract(epoch from now())*1000;
$$;
create function public.mudu_candidate_local_pass(p_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  update public.mudu_local_admission a set downloaded_at=coalesce(downloaded_at,(extract(epoch from now())*1000)::bigint)
  where a.preparation_id=p_id and a.account_id=auth.uid() and exists(select 1 from public.mudu_local_preparations p where p.id=p_id and p.state='prepared' and p.expires_at>extract(epoch from now())*1000)
    and exists(select 1 from auth.users where id=auth.uid() and email_confirmed_at is not null)
  returning pass into result;
  if not found then raise exception using errcode='P0002',message='Admission unavailable'; end if;
  return result;
end $$;
revoke all on function public.mudu_prepare_local(jsonb),public.mudu_close_local(uuid,text),public.mudu_local_status(uuid),public.mudu_candidate_local_passes(),public.mudu_candidate_local_pass(uuid) from public,anon;
grant execute on function public.mudu_prepare_local(jsonb),public.mudu_close_local(uuid,text),public.mudu_local_status(uuid),public.mudu_candidate_local_passes(),public.mudu_candidate_local_pass(uuid) to authenticated;
commit;
