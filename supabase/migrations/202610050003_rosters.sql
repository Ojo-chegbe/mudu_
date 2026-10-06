-- Owner-private snapshots; candidate RPCs return only that candidate's membership.
create table public.mudu_rosters (
  id uuid primary key, owner_id uuid not null references auth.users(id),
  revision bigint not null check(revision>0), digest text not null,
  payload text not null check(octet_length(payload)<=2097152),
  document jsonb generated always as (payload::jsonb) stored,
  token text not null unique, updated_at timestamptz not null default now()
);
create index mudu_rosters_owner on public.mudu_rosters(owner_id,id);
create table public.mudu_roster_members (
  roster_id uuid not null references public.mudu_rosters(id) on delete cascade,
  owner_id uuid not null references auth.users(id), account_id uuid not null references auth.users(id),
  identifier text not null, status text not null check(status in ('pending','approved','rejected')),
  primary key(roster_id,account_id)
);
create unique index mudu_roster_member_number on public.mudu_roster_members(roster_id,identifier) where status='approved';
create index mudu_roster_candidate on public.mudu_roster_members(account_id,roster_id);
create table public.mudu_roster_invites (
  id uuid primary key, roster_id uuid not null references public.mudu_rosters(id) on delete cascade,
  owner_id uuid not null references auth.users(id), token text not null unique,
  email text not null, identifier text not null, unique(roster_id,email)
);
create table public.mudu_roster_join_limits (account_id uuid primary key references auth.users(id), window_start timestamptz not null, requests integer not null);
create table public.mudu_roster_claim_receipts (token text primary key,roster_id uuid not null references public.mudu_rosters(id),account_id uuid not null references auth.users(id));
create table public.mudu_roster_numbers (owner_id uuid not null references auth.users(id),identifier text not null,account_id uuid not null references auth.users(id),primary key(owner_id,identifier),unique(owner_id,account_id));
alter table public.mudu_rosters enable row level security;
alter table public.mudu_roster_members enable row level security;
alter table public.mudu_roster_invites enable row level security;
alter table public.mudu_roster_join_limits enable row level security;
alter table public.mudu_roster_claim_receipts enable row level security;
alter table public.mudu_roster_numbers enable row level security;
create policy mudu_roster_owner_read on public.mudu_rosters for select to authenticated using(owner_id=auth.uid());
create policy mudu_roster_members_owner_read on public.mudu_roster_members for select to authenticated using(owner_id=auth.uid());
create policy mudu_roster_invites_owner_read on public.mudu_roster_invites for select to authenticated using(owner_id=auth.uid());
revoke all on public.mudu_rosters,public.mudu_roster_members,public.mudu_roster_invites,public.mudu_roster_join_limits from public,anon,authenticated;
revoke all on public.mudu_roster_claim_receipts,public.mudu_roster_numbers from public,anon,authenticated;
grant select on public.mudu_rosters,public.mudu_roster_members,public.mudu_roster_invites to authenticated;

create function public.mudu_roster_index(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare r public.mudu_rosters; m jsonb; i jsonb; uid uuid; mail text; number text;
begin
  select * into strict r from public.mudu_rosters where id=p_id;
  delete from public.mudu_roster_members where roster_id=p_id;
  delete from public.mudu_roster_invites where roster_id=p_id;
  for m in select value from jsonb_array_elements(r.document->'members') loop
    uid:=(m->>'id')::uuid;
    select lower(email) into mail from auth.users where id=uid and email_confirmed_at is not null;
    if mail is null or mail<>m->>'email' then raise exception 'Unconfirmed candidate' using errcode='M0002'; end if;
    if m->>'status'='approved' then
      select identifier into number from public.mudu_roster_numbers where owner_id=r.owner_id and account_id=uid;
      if number is not null and number<>m->>'identifier' then
        if number not like 'ACCOUNT-%' then raise exception 'Assigned number cannot change' using errcode='M0002'; end if;
        update public.mudu_roster_numbers set identifier=m->>'identifier' where owner_id=r.owner_id and account_id=uid;
      elsif number is null then insert into public.mudu_roster_numbers values(r.owner_id,m->>'identifier',uid); end if;
    end if;
    if m->>'status'='approved' and exists(select 1 from public.mudu_roster_members where owner_id=r.owner_id and status='approved' and
      ((identifier=m->>'identifier' and account_id<>uid) or (account_id=uid and identifier<>m->>'identifier'))) then
      raise exception 'Candidate number conflict' using errcode='M0002';
    end if;
    insert into public.mudu_roster_members values(p_id,r.owner_id,uid,m->>'identifier',m->>'status');
  end loop;
  for i in select value from jsonb_array_elements(r.document->'invitations') loop
    if exists(select 1 from public.mudu_roster_claim_receipts where token=i->>'token') then raise exception 'Invitation already claimed' using errcode='M0002'; end if;
    if exists(select 1 from public.mudu_roster_invites where owner_id=r.owner_id and
      ((identifier=i->>'identifier' and email<>i->>'email') or (email=i->>'email' and identifier<>i->>'identifier'))) or
      exists(select 1 from public.mudu_roster_members m join auth.users a on a.id=m.account_id where m.owner_id=r.owner_id and m.status='approved' and m.identifier=i->>'identifier' and lower(a.email)<>i->>'email') then
      raise exception 'Reserved number conflict' using errcode='M0002';
    end if;
    insert into public.mudu_roster_invites values((i->>'id')::uuid,p_id,r.owner_id,i->>'token',i->>'email',i->>'identifier');
  end loop;
end $$;
create function public.mudu_roster_write(p_expected_revision bigint,p_payload text) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); d jsonb; r public.mudu_rosters; h text; v jsonb; target uuid;
begin
  if u is null or not exists(select 1 from auth.users where id=u and email_confirmed_at is not null) then raise exception 'Sign in' using errcode='42501'; end if;
  if p_payload is null or octet_length(p_payload)>2097152 or p_expected_revision is null or p_expected_revision<0 then raise exception 'Invalid payload' using errcode='M0002'; end if;
  d:=p_payload::jsonb; target:=(d->>'id')::uuid;
  if target is null or jsonb_typeof(d) is distinct from 'object' or d->>'version' is distinct from '1' or
    length(coalesce(d->>'name','')) not between 1 and 160 or coalesce(d->>'token','') !~ '^[A-Za-z0-9_-]{20,100}$' or
    jsonb_typeof(d->'open') is distinct from 'boolean' or jsonb_typeof(d->'restricted') is distinct from 'boolean' or jsonb_typeof(d->'archived') is distinct from 'boolean' or
    jsonb_typeof(d->'entries') is distinct from 'array' or jsonb_typeof(d->'members') is distinct from 'array' or jsonb_typeof(d->'invitations') is distinct from 'array' then raise exception 'Invalid roster' using errcode='M0002'; end if;
  if jsonb_array_length(d->'entries')>500 or jsonb_array_length(d->'members')>2000 or
    (select count(*) from jsonb_array_elements(d->'members') m where m->>'status'='approved')+jsonb_array_length(d->'invitations')>500 or
    ((d->>'restricted')::boolean and jsonb_array_length(d->'entries')=0) then raise exception 'Roster limit' using errcode='M0002'; end if;
  for v in select value from jsonb_array_elements(d->'entries') loop
    if length(coalesce(v->>'identifier','')) not between 1 and 80 or length(coalesce(v->>'name','')) not between 1 and 160 then raise exception 'Invalid entry' using errcode='M0002'; end if;
  end loop;
  if (select count(distinct value->>'identifier') from jsonb_array_elements(d->'entries'))<>jsonb_array_length(d->'entries') then raise exception 'Duplicate numbers' using errcode='M0002'; end if;
  for v in select value from jsonb_array_elements(d->'members') loop
    if coalesce(v->>'status','') not in ('pending','approved','rejected') or length(coalesce(v->>'identifier','')) not between 1 and 80 or
      length(coalesce(v->>'name','')) not between 1 and 160 or length(coalesce(v->>'email','')) not between 3 and 254 or
      coalesce(v->>'requestedAt','') !~ '^[0-9]{1,16}$' or not (v ? 'reviewedAt') or
      (v->'reviewedAt'<>'null'::jsonb and coalesce(v->>'reviewedAt','') !~ '^[0-9]{1,16}$') then raise exception 'Invalid member' using errcode='M0002'; end if;
  end loop;
  for v in select value from jsonb_array_elements(d->'invitations') loop
    if length(coalesce(v->>'identifier','')) not between 1 and 80 or length(coalesce(v->>'name','')) not between 1 and 160 or
      coalesce(v->>'token','') !~ '^[A-Za-z0-9_-]{20,100}$' or length(coalesce(v->>'email','')) not between 3 and 254 or
      lower(v->>'email') is distinct from v->>'email' or coalesce(v->>'createdAt','') !~ '^[0-9]{1,16}$' then raise exception 'Invalid invitation' using errcode='M0002'; end if;
  end loop;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text,72632));
  select * into r from public.mudu_rosters where id=target;
  if found and r.owner_id<>u then raise exception 'Not found' using errcode='M0004'; end if;
  h:=encode(sha256(convert_to(p_payload,'UTF8')),'hex');
  if r.digest=h then return jsonb_build_object('id',target,'revision',r.revision,'digest',h,'updatedAt',floor(extract(epoch from r.updated_at)*1000)::bigint); end if;
  if coalesce(r.revision,0)<>p_expected_revision then raise exception 'Revision conflict' using errcode='M0001'; end if;
  if r.id is null and (select count(*) from public.mudu_rosters where owner_id=u)>=100 then raise exception 'Roster limit' using errcode='M0002'; end if;
  if coalesce((select sum(octet_length(payload)) from public.mudu_rosters where owner_id=u and id<>target),0)+octet_length(p_payload)>16777216 then raise exception 'Workspace roster size limit' using errcode='M0002'; end if;
  insert into public.mudu_rosters(id,owner_id,revision,digest,payload,token) values(target,u,1,h,p_payload,d->>'token')
    on conflict(id) do update set revision=mudu_rosters.revision+1,digest=excluded.digest,payload=excluded.payload,token=excluded.token,updated_at=now();
  perform public.mudu_roster_index(target);
  select * into r from public.mudu_rosters where id=target;
  return jsonb_build_object('id',target,'revision',r.revision,'digest',r.digest,'updatedAt',floor(extract(epoch from r.updated_at)*1000)::bigint);
end $$;
revoke all on function public.mudu_roster_index(uuid) from public,anon,authenticated;
create function public.mudu_roster_list() returns jsonb language sql stable security invoker set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'revision',revision,'digest',digest,'updatedAt',floor(extract(epoch from updated_at)*1000)::bigint) order by id),'[]'::jsonb) from public.mudu_rosters where owner_id=auth.uid()
$$;
create function public.mudu_roster_read(p_id uuid) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare r public.mudu_rosters;
begin
  select * into r from public.mudu_rosters where id=p_id and owner_id=auth.uid();
  if not found then raise exception 'Not found' using errcode='M0004'; end if;
  return jsonb_build_object('id',r.id,'revision',r.revision,'digest',r.digest,'payload',r.payload,'updatedAt',floor(extract(epoch from r.updated_at)*1000)::bigint);
end $$;
create function public.mudu_roster_invitation(p_token text,p_personal boolean default false) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r public.mudu_rosters; s text;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{20,100}$' then raise exception 'Not found' using errcode='M0004'; end if;
  if p_personal then select a.* into r from public.mudu_rosters a join public.mudu_roster_invites i on i.roster_id=a.id where i.token=p_token;
  else select * into r from public.mudu_rosters where token=p_token; end if;
  if r.id is null and p_personal then
    select a.* into r from public.mudu_rosters a join public.mudu_roster_claim_receipts c on c.roster_id=a.id where c.token=p_token and c.account_id=auth.uid();
    if r.id is not null then
      select status into s from public.mudu_roster_members where roster_id=r.id and account_id=auth.uid();
      return jsonb_build_object('name',r.document->>'name','accepting',false,'restricted',false,'status',s,'claimed',true);
    end if;
  end if;
  if r.id is null then raise exception 'Not found' using errcode='M0004'; end if;
  select status into s from public.mudu_roster_members where roster_id=r.id and account_id=auth.uid();
  return jsonb_build_object('name',r.document->>'name','accepting',(r.document->>'open')::boolean and not (r.document->>'archived')::boolean,
    'restricted',(r.document->>'restricted')::boolean,'status',s,'claimed',false);
end $$;
create function public.mudu_roster_group(p_id uuid,p_account uuid) returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',r.id,'ownerId',r.owner_id,'name',r.document->>'name','token',r.token,'open',r.document->'open',
    'restricted',r.document->'restricted','archived',r.document->'archived','revision',r.revision,'member',m)
    from public.mudu_rosters r cross join lateral jsonb_array_elements(r.document->'members') m where r.id=p_id and m->>'id'=p_account::text
$$;
revoke all on function public.mudu_roster_group(uuid,uuid) from public,anon,authenticated;
create function public.mudu_roster_join(p_token text,p_identifier text,p_personal boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); r public.mudu_rosters; v jsonb; existing jsonb; member jsonb; d jsonb; mail text; candidate_name text; limits public.mudu_roster_join_limits; target uuid; assigned text;
begin
  select lower(email),coalesce(nullif(left(raw_user_meta_data->>'name',160),''),email) into mail,candidate_name from auth.users where id=u and email_confirmed_at is not null;
  if u is null or mail is null then raise exception 'Sign in' using errcode='42501'; end if;
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{20,100}$' then raise exception 'Not found' using errcode='M0004'; end if;
  if p_personal then select a.* into r from public.mudu_rosters a join public.mudu_roster_invites i on i.roster_id=a.id where i.token=p_token;
  else select * into r from public.mudu_rosters where token=p_token; end if;
  if r.id is null and p_personal then
    select a.* into r from public.mudu_rosters a join public.mudu_roster_claim_receipts c on c.roster_id=a.id where c.token=p_token and c.account_id=u;
    if r.id is not null then return public.mudu_roster_group(r.id,u); end if;
  end if;
  if r.id is null then raise exception 'Not found' using errcode='M0004'; end if;
  target:=r.id;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(r.owner_id::text,72632));
  select * into strict r from public.mudu_rosters where id=target;
  select value into existing from jsonb_array_elements(r.document->'members') where value->>'id'=u::text;
  if existing is not null and not p_personal then return public.mudu_roster_group(r.id,u); end if;
  if p_personal then
    select value into v from jsonb_array_elements(r.document->'invitations') where value->>'token'=p_token;
    if v is null or v->>'email'<>mail then raise exception 'Wrong invitation' using errcode='M0005'; end if;
    p_identifier:=v->>'identifier';
  end if;
  select identifier into assigned from public.mudu_roster_numbers where owner_id=r.owner_id and account_id=u;
  if not p_personal and assigned is not null then p_identifier:=assigned; end if;
  if not (r.document->>'open')::boolean or (r.document->>'archived')::boolean then raise exception 'Closed' using errcode='M0006'; end if;
  if p_identifier is null or length(p_identifier) not between 1 and 80 then raise exception 'Invalid number' using errcode='M0002'; end if;
  if (r.document->>'restricted')::boolean and not p_personal and not exists(select 1 from jsonb_array_elements(r.document->'entries') where value->>'identifier'=p_identifier) then raise exception 'Not eligible' using errcode='M0007'; end if;
  if jsonb_array_length(r.document->'members')>=2000 and existing is null then raise exception 'Queue full' using errcode='M0002'; end if;
  if existing is null and (select count(*) from public.mudu_roster_members where account_id=u)>=2000 then raise exception 'Group limit' using errcode='M0002'; end if;
  if p_personal and (select count(*) from public.mudu_roster_members where roster_id=r.id and status='approved' and account_id<>u)>=500 then raise exception 'Roster full' using errcode='M0002'; end if;
  insert into public.mudu_roster_join_limits values(u,now(),1) on conflict(account_id) do update set
    requests=case when mudu_roster_join_limits.window_start<now()-interval '1 minute' then 1 else mudu_roster_join_limits.requests+1 end,
    window_start=case when mudu_roster_join_limits.window_start<now()-interval '1 minute' then now() else mudu_roster_join_limits.window_start end returning * into limits;
  if limits.requests>30 then raise exception 'Too many requests' using errcode='M0008'; end if;
  member:=jsonb_build_object('id',u,'name',candidate_name,'email',mail,'identifier',p_identifier,'status',case when p_personal then 'approved' else 'pending' end,
    'requestedAt',coalesce(existing->'requestedAt',to_jsonb(floor(extract(epoch from now())*1000)::bigint)),
    'reviewedAt',case when p_personal then to_jsonb(floor(extract(epoch from now())*1000)::bigint) else 'null'::jsonb end);
  d:=jsonb_set(r.document,'{members}',(select coalesce(jsonb_agg(value),'[]'::jsonb) from jsonb_array_elements(r.document->'members') where value->>'id'<>u::text)||jsonb_build_array(member));
  if p_personal then
    d:=jsonb_set(d,'{invitations}',(select coalesce(jsonb_agg(value),'[]'::jsonb) from jsonb_array_elements(d->'invitations') where value->>'token'<>p_token));
    if not exists(select 1 from jsonb_array_elements(d->'entries') where value->>'identifier'=p_identifier) then
      if jsonb_array_length(d->'entries')>=500 then raise exception 'Expected list full' using errcode='M0002'; end if;
      d:=jsonb_set(d,'{entries}',d->'entries'||jsonb_build_array(jsonb_build_object('identifier',p_identifier,'name',candidate_name)));
    end if;
  end if;
  update public.mudu_rosters set payload=d::text,digest=encode(sha256(convert_to(d::text,'UTF8')),'hex'),revision=revision+1,updated_at=now() where id=r.id;
  perform public.mudu_roster_index(r.id);
  if p_personal then insert into public.mudu_roster_claim_receipts values(p_token,r.id,u); end if;
  return public.mudu_roster_group(r.id,u);
end $$;
create function public.mudu_candidate_rosters() returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(public.mudu_roster_group(roster_id,auth.uid()) order by roster_id),'[]'::jsonb)
    from public.mudu_roster_members where account_id=auth.uid()
$$;
revoke all on function public.mudu_roster_list(),public.mudu_roster_read(uuid),public.mudu_roster_write(bigint,text),public.mudu_roster_invitation(text,boolean),public.mudu_roster_join(text,text,boolean),public.mudu_candidate_rosters() from public,anon,authenticated;
grant execute on function public.mudu_roster_list(),public.mudu_roster_read(uuid),public.mudu_roster_write(bigint,text),public.mudu_roster_join(text,text,boolean),public.mudu_candidate_rosters() to authenticated;
grant execute on function public.mudu_roster_invitation(text,boolean) to anon,authenticated;
