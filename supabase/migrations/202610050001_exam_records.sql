-- Apply once in the project's SQL Editor. No service-role key is needed by MUDU.
-- Authenticated users own their records; all writes use bounded transactional RPCs.
begin;

create table public.mudu_exam_records (
  owner_id uuid not null references auth.users(id), record_id uuid not null,
  sitting_id uuid not null, host_id uuid not null, revision bigint not null check (revision > 0),
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  payload jsonb not null, synced_at timestamptz not null default now(),
  title text generated always as (payload#>>'{assessment,title}') stored,
  course text generated always as (payload#>>'{assessment,course}') stored,
  candidate_count integer generated always as (jsonb_array_length(payload->'candidates')) stored,
  primary key (owner_id,record_id)
);
create table public.mudu_exam_uploads (
  owner_id uuid not null references auth.users(id), upload_id uuid not null,
  record_id uuid not null, sitting_id uuid not null, host_id uuid not null,
  expected_revision bigint not null check (expected_revision >= 0),
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  byte_length integer not null check (byte_length between 1 and 16777216),
  part_count integer not null check (part_count between 1 and 256),
  committed_revision bigint, expires_at timestamptz not null default now()+interval '7 days',
  primary key(owner_id,upload_id)
);
create table public.mudu_exam_parts (
  owner_id uuid not null, upload_id uuid not null, part_index integer not null check (part_index between 0 and 255),
  body bytea not null check (octet_length(body) between 1 and 65536),
  primary key(owner_id,upload_id,part_index),
  foreign key(owner_id,upload_id) references public.mudu_exam_uploads(owner_id,upload_id) on delete cascade
);
alter table public.mudu_exam_records enable row level security;
alter table public.mudu_exam_uploads enable row level security;
alter table public.mudu_exam_parts enable row level security;
create policy own_exam_records on public.mudu_exam_records for select to authenticated
  using (owner_id=(select auth.uid()));
revoke all on public.mudu_exam_records,public.mudu_exam_uploads,public.mudu_exam_parts from public,anon,authenticated;
grant select on public.mudu_exam_records to authenticated;

create function public.mudu_cloud_version() returns integer language sql stable
  security invoker set search_path='' as $$ select 1 $$;

create function public.mudu_begin_exam_upload(
  p_upload_id uuid,p_record_id uuid,p_sitting_id uuid,p_host_id uuid,
  p_expected_revision bigint,p_digest text,p_byte_length integer,p_part_count integer
) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); existing public.mudu_exam_uploads; received jsonb;
begin
  if u is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_upload_id is null or p_record_id is null or p_sitting_id is null or p_host_id is null
    or p_expected_revision is null or p_expected_revision<0 or p_digest is null or p_digest !~ '^[a-f0-9]{64}$'
    or p_byte_length is null or p_byte_length not between 1 and 16777216
    or p_part_count is null or p_part_count not between 1 and 256
    or p_part_count != ceil(p_byte_length/65536.0)::integer then
    raise exception 'Invalid upload' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text||'mudu_upload_budget',0));
  delete from public.mudu_exam_uploads where owner_id=u and committed_revision is null and expires_at<now();
  select * into existing from public.mudu_exam_uploads where owner_id=u and upload_id=p_upload_id for update;
  if found then
    if existing.record_id!=p_record_id or existing.sitting_id!=p_sitting_id or existing.host_id!=p_host_id
      or existing.expected_revision!=p_expected_revision or existing.digest!=p_digest
      or existing.byte_length!=p_byte_length or existing.part_count!=p_part_count then
      raise exception 'Upload conflict' using errcode='M0001';
    end if;
  else
    if (select count(*) from public.mudu_exam_uploads where owner_id=u and committed_revision is null)>=32 then
      raise exception 'Too many unfinished uploads' using errcode='54000';
    end if;
    insert into public.mudu_exam_uploads(owner_id,upload_id,record_id,sitting_id,host_id,expected_revision,digest,byte_length,part_count)
      values(u,p_upload_id,p_record_id,p_sitting_id,p_host_id,p_expected_revision,p_digest,p_byte_length,p_part_count);
  end if;
  select coalesce(jsonb_agg(part_index order by part_index),'[]'::jsonb) into received
    from public.mudu_exam_parts where owner_id=u and upload_id=p_upload_id;
  return jsonb_build_object('received',received,'revision',existing.committed_revision,'digest',p_digest);
end $$;

create function public.mudu_put_exam_part(p_upload_id uuid,p_index integer,p_data text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); upload public.mudu_exam_uploads; decoded bytea; previous bytea;
begin
  if u is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select * into upload from public.mudu_exam_uploads where owner_id=u and upload_id=p_upload_id for update;
  if not found or upload.expires_at<now() then raise exception 'Upload missing' using errcode='M0002'; end if;
  if p_index is null or p_index<0 or p_index>=upload.part_count or p_data is null or length(p_data)>87384 then
    raise exception 'Invalid part' using errcode='22023'; end if;
  if upload.committed_revision is not null then
    return jsonb_build_object('index',p_index,'digest',upload.digest);
  end if;
  decoded:=pg_catalog.decode(p_data,'base64');
  if octet_length(decoded)!=least(65536,upload.byte_length-p_index*65536) then
    raise exception 'Invalid part length' using errcode='22023'; end if;
  select body into previous from public.mudu_exam_parts where owner_id=u and upload_id=p_upload_id and part_index=p_index;
  if found and previous!=decoded then raise exception 'Part conflict' using errcode='M0001'; end if;
  insert into public.mudu_exam_parts values(u,p_upload_id,p_index,decoded) on conflict do nothing;
  return jsonb_build_object('index',p_index,'digest',upload.digest);
end $$;

create function public.mudu_finish_exam_upload(p_upload_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); upload public.mudu_exam_uploads; current_record public.mudu_exam_records;
  content bytea:=''::bytea; part record; document jsonb; next_revision bigint;
begin
  if u is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select * into upload from public.mudu_exam_uploads where owner_id=u and upload_id=p_upload_id for update;
  if not found then raise exception 'Upload missing' using errcode='M0002'; end if;
  if upload.committed_revision is not null then
    return jsonb_build_object('id',upload.record_id,'revision',upload.committed_revision,'digest',upload.digest);
  end if;
  if upload.expires_at<now() then raise exception 'Upload expired' using errcode='M0002'; end if;
  if (select count(*) from public.mudu_exam_parts where owner_id=u and upload_id=p_upload_id)!=upload.part_count then
    raise exception 'Upload incomplete' using errcode='M0002'; end if;
  for part in select body from public.mudu_exam_parts where owner_id=u and upload_id=p_upload_id order by part_index loop
    content:=content||part.body;
  end loop;
  if octet_length(content)!=upload.byte_length or pg_catalog.encode(pg_catalog.sha256(content),'hex')!=upload.digest then
    raise exception 'Upload checksum mismatch' using errcode='22023'; end if;
  document:=pg_catalog.convert_from(content,'UTF8')::jsonb;
  if document->>'version' is distinct from '1' or document#>>'{assessment,id}' is distinct from upload.record_id::text
    or document#>>'{sitting,id}' is distinct from upload.sitting_id::text
    or jsonb_typeof(document->'candidates') is distinct from 'array'
    or jsonb_typeof(document#>'{assessment,questions}') is distinct from 'array'
    or jsonb_typeof(document->'events') is distinct from 'array'
    or length(document#>>'{assessment,title}') not between 1 and 200 then
    raise exception 'Invalid examination record' using errcode='22023'; end if;
  if jsonb_array_length(document->'candidates')>500
    or exists(select 1 from jsonb_array_elements(document->'candidates') c where c->>'status'='active') then
    raise exception 'Examination is not complete' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text||upload.record_id::text,0));
  select * into current_record from public.mudu_exam_records where owner_id=u and record_id=upload.record_id for update;
  if found then
    if current_record.host_id!=upload.host_id or current_record.sitting_id!=upload.sitting_id then
      raise exception 'Execution authority conflict' using errcode='M0001'; end if;
    if current_record.digest=upload.digest then next_revision:=current_record.revision;
    else
      if current_record.revision!=upload.expected_revision then raise exception 'Revision conflict' using errcode='M0001'; end if;
      next_revision:=current_record.revision+1;
      update public.mudu_exam_records set payload=document,digest=upload.digest,revision=next_revision,synced_at=now()
        where owner_id=u and record_id=upload.record_id;
    end if;
  else
    if upload.expected_revision!=0 then raise exception 'Revision conflict' using errcode='M0001'; end if;
    next_revision:=1;
    insert into public.mudu_exam_records(owner_id,record_id,sitting_id,host_id,revision,digest,payload,synced_at)
      values(u,upload.record_id,upload.sitting_id,upload.host_id,next_revision,upload.digest,document,now());
  end if;
  update public.mudu_exam_uploads set committed_revision=next_revision where owner_id=u and upload_id=p_upload_id;
  delete from public.mudu_exam_parts where owner_id=u and upload_id=p_upload_id;
  return jsonb_build_object('id',upload.record_id,'revision',next_revision,'digest',upload.digest);
end $$;

revoke all on function public.mudu_cloud_version(),
  public.mudu_begin_exam_upload(uuid,uuid,uuid,uuid,bigint,text,integer,integer),
  public.mudu_put_exam_part(uuid,integer,text),public.mudu_finish_exam_upload(uuid) from public,anon;
grant execute on function public.mudu_cloud_version(),
  public.mudu_begin_exam_upload(uuid,uuid,uuid,uuid,bigint,text,integer,integer),
  public.mudu_put_exam_part(uuid,integer,text),public.mudu_finish_exam_upload(uuid) to authenticated;
commit;
