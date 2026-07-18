-- Cheerful Music AI OS database + RBAC foundation.
-- Run once in Supabase SQL Editor. Safe to run again while the schema evolves.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  display_name text not null default '',
  role text not null default 'viewer' check (role in (
    'ceo', 'finance', 'ar', 'hr', 'marketing', 'legal',
    'copyright', 'distribution', 'admin', 'member', 'viewer'
  )),
  department text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.songs (
  id uuid primary key default gen_random_uuid(),
  work_id text not null unique,
  title text not null,
  alternative_titles text[] not null default '{}',
  iswc text,
  language text,
  label text,
  copyright_owner text,
  status text not null default 'released' check (status in ('released', 'unreleased', 'takedown', 'archived')),
  notes text,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.recordings (
  id uuid primary key default gen_random_uuid(),
  recording_id text not null unique,
  song_id uuid not null references public.songs(id) on delete cascade,
  isrc text,
  version_name text not null default '原版',
  version_type text not null default 'Original',
  artist_name text not null,
  upc text,
  release_date date,
  label text,
  recording_owner text,
  status text not null default 'released' check (status in ('released', 'unreleased', 'takedown', 'archived')),
  notes text,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payees (
  id uuid primary key default gen_random_uuid(),
  payee_code text unique,
  name text not null,
  payee_type text not null default 'individual',
  country text,
  default_currency text,
  email text,
  tax_status text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.royalty_imports (
  id uuid primary key default gen_random_uuid(),
  batch_no text not null unique,
  platform text not null,
  period_start date,
  period_end date,
  original_filename text not null,
  storage_path text,
  currency text,
  status text not null default 'uploaded' check (status in ('uploaded', 'parsing', 'review', 'ready', 'completed', 'failed')),
  total_rows integer not null default 0,
  imported_rows integer not null default 0,
  updated_rows integer not null default 0,
  skipped_rows integer not null default 0,
  failed_rows integer not null default 0,
  review_rows integer not null default 0,
  total_amount numeric(20, 6),
  metadata jsonb not null default '{}'::jsonb,
  uploaded_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.royalty_rules (
  id uuid primary key default gen_random_uuid(),
  rule_code text unique,
  song_id uuid not null references public.songs(id) on delete restrict,
  recording_id uuid references public.recordings(id) on delete restrict,
  payee_id uuid references public.payees(id) on delete restrict,
  artist_name text,
  payee_name text not null,
  role text not null check (role in (
    'Artist', 'Featured Artist', 'Lyricist', 'Composer', 'Producer',
    'Publisher', 'Label', 'Recording Owner', 'Copyright Owner', 'Other'
  )),
  royalty_type text not null check (royalty_type in (
    'Recording Royalty', 'Publishing Royalty', 'Artist Royalty',
    'Producer Royalty', 'Platform Revenue Share', 'Other'
  )),
  share_percentage numeric(9, 6) not null check (share_percentage >= 0 and share_percentage <= 100),
  calculation_basis text not null default 'Net Receipts',
  effective_date date not null,
  end_date date,
  territory text not null default 'Worldwide',
  platform text not null default 'All',
  currency text,
  contract_no text,
  status text not null default 'active' check (status in ('draft', 'active', 'expired', 'suspended', 'review')),
  notes text,
  source_import_id uuid references public.royalty_imports(id) on delete set null,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date is null or effective_date <= end_date)
);

create table if not exists public.royalty_import_rows (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.royalty_imports(id) on delete cascade,
  source_row_number integer not null,
  raw_data jsonb not null default '{}'::jsonb,
  song_id uuid references public.songs(id),
  recording_id uuid references public.recordings(id),
  match_status text not null default 'pending' check (match_status in ('pending', 'matched', 'review', 'unmatched', 'rejected')),
  match_method text,
  confidence numeric(6, 5),
  platform text,
  territory text,
  usage_date date,
  currency text,
  gross_amount numeric(20, 6),
  fees numeric(20, 6),
  tax_amount numeric(20, 6),
  net_amount numeric(20, 6),
  error_reason text,
  created_at timestamptz not null default now(),
  unique (import_id, source_row_number)
);

create table if not exists public.hr_records (
  id uuid primary key default gen_random_uuid(),
  employee_user_id uuid references public.users(id),
  employee_name text not null,
  department text,
  job_title text,
  employment_status text,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.recruitment_records (
  id uuid primary key default gen_random_uuid(),
  candidate_name text not null,
  position text,
  status text,
  owner_user_id uuid references public.users(id),
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.contracts (
  id uuid primary key default gen_random_uuid(),
  contract_no text not null unique,
  title text not null,
  counterparty text,
  contract_type text,
  effective_date date,
  end_date date,
  status text,
  storage_path text,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.legal_records (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  record_type text,
  status text,
  owner_user_id uuid references public.users(id),
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.gpt_chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id text not null,
  actor_id text not null,
  actor_name text not null,
  actor_role text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  sources jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.gpt_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id text not null,
  actor_name text not null,
  actor_role text not null,
  action text not null,
  conversation_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Existing Cheerful GPT installations used a narrower role check.
alter table public.gpt_chat_messages drop constraint if exists gpt_chat_messages_actor_role_check;
alter table public.gpt_chat_messages add constraint gpt_chat_messages_actor_role_check
  check (actor_role in ('ceo', 'finance', 'ar', 'hr', 'marketing', 'legal', 'copyright', 'distribution', 'admin', 'member', 'viewer'));

create unique index if not exists recordings_isrc_unique_idx on public.recordings (upper(isrc))
  where isrc is not null and btrim(isrc) <> '';
create index if not exists songs_title_trgm_idx on public.songs using gin (title gin_trgm_ops);
create index if not exists songs_alternative_titles_idx on public.songs using gin (alternative_titles);
create index if not exists recordings_artist_trgm_idx on public.recordings using gin (artist_name gin_trgm_ops);
create index if not exists recordings_song_idx on public.recordings (song_id);
create index if not exists royalty_rules_recording_dates_idx on public.royalty_rules (recording_id, effective_date, end_date);
create index if not exists royalty_rules_song_type_idx on public.royalty_rules (song_id, royalty_type);
create index if not exists royalty_imports_platform_period_idx on public.royalty_imports (platform, period_start, period_end);
create index if not exists royalty_import_rows_import_idx on public.royalty_import_rows (import_id, match_status);
create index if not exists gpt_chat_messages_actor_created_idx on public.gpt_chat_messages (actor_id, created_at desc);
create index if not exists gpt_chat_messages_conversation_idx on public.gpt_chat_messages (conversation_id, created_at asc);
create index if not exists gpt_audit_logs_created_idx on public.gpt_audit_logs (created_at desc);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array['users','songs','recordings','payees','royalty_imports','royalty_rules','hr_records','recruitment_records','contracts','legal_records']
  loop
    execute format('drop trigger if exists set_%I_updated_at on public.%I', table_name, table_name);
    execute format('create trigger set_%I_updated_at before update on public.%I for each row execute function public.set_updated_at()', table_name, table_name);
  end loop;
end $$;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.users (id, email, display_name, role, department)
  values (
    new.id,
    lower(coalesce(new.email, new.id::text || '@pending.local')),
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(coalesce(new.email, 'User'), '@', 1)),
    'viewer',
    null
  )
  on conflict (id) do update set email = excluded.email, updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update of email on auth.users
  for each row execute function public.handle_new_auth_user();

insert into public.users (id, email, display_name, role)
select id, lower(email), coalesce(raw_user_meta_data ->> 'display_name', split_part(email, '@', 1)), 'viewer'
from auth.users
where email is not null
on conflict (id) do nothing;

create or replace function public.current_app_role()
returns text
language sql
stable
security definer set search_path = public
as $$
  select role from public.users where id = (select auth.uid()) and active = true;
$$;

revoke all on function public.current_app_role() from public;
grant execute on function public.current_app_role() to authenticated, service_role;

create or replace function public.search_music_catalog(search_text text, result_limit integer default 60)
returns table (
  song_id uuid,
  recording_uuid uuid,
  work_id text,
  recording_id text,
  title text,
  alternative_titles text[],
  artist_name text,
  version_name text,
  version_type text,
  isrc text,
  iswc text,
  upc text,
  release_date date,
  label text,
  copyright_owner text,
  recording_owner text,
  status text
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    s.id,
    r.id,
    s.work_id,
    r.recording_id,
    s.title,
    s.alternative_titles,
    r.artist_name,
    r.version_name,
    r.version_type,
    r.isrc,
    s.iswc,
    r.upc,
    r.release_date,
    coalesce(r.label, s.label),
    s.copyright_owner,
    r.recording_owner,
    r.status
  from public.songs s
  join public.recordings r on r.song_id = s.id
  where btrim(coalesce(search_text, '')) = ''
     or lower(search_text) like '%' || lower(s.title) || '%'
     or lower(search_text) like '%' || lower(coalesce(r.artist_name, '')) || '%'
     or lower(search_text) like '%' || lower(coalesce(r.isrc, '')) || '%'
     or lower(search_text) like '%' || lower(coalesce(s.work_id, '')) || '%'
     or lower(search_text) like '%' || lower(coalesce(r.recording_id, '')) || '%'
     or s.title % search_text
     or r.artist_name % search_text
  order by
    case when lower(search_text) like '%' || lower(s.title) || '%' then 0 else 1 end,
    greatest(similarity(s.title, search_text), similarity(r.artist_name, search_text)) desc,
    r.updated_at desc
  limit least(greatest(coalesce(result_limit, 60), 1), 100);
$$;

revoke all on function public.search_music_catalog(text, integer) from public, anon;
grant execute on function public.search_music_catalog(text, integer) to authenticated, service_role;

-- RLS protects every request made with an authenticated user token. Vercel
-- routes that use the server-only secret/service key bypass RLS by design, so
-- those routes separately enforce the same permission map before every query.
alter table public.users enable row level security;
alter table public.songs enable row level security;
alter table public.recordings enable row level security;
alter table public.payees enable row level security;
alter table public.royalty_rules enable row level security;
alter table public.royalty_imports enable row level security;
alter table public.royalty_import_rows enable row level security;
alter table public.hr_records enable row level security;
alter table public.recruitment_records enable row level security;
alter table public.contracts enable row level security;
alter table public.legal_records enable row level security;
alter table public.gpt_chat_messages enable row level security;
alter table public.gpt_audit_logs enable row level security;

do $$
declare policy_record record;
begin
  for policy_record in select schemaname, tablename, policyname from pg_policies where schemaname = 'public' and tablename in (
    'users','songs','recordings','payees','royalty_rules','royalty_imports','royalty_import_rows',
    'hr_records','recruitment_records','contracts','legal_records'
  ) loop
    execute format('drop policy if exists %I on %I.%I', policy_record.policyname, policy_record.schemaname, policy_record.tablename);
  end loop;
end $$;

create policy users_select on public.users for select to authenticated
  using (id = (select auth.uid()) or (select public.current_app_role()) in ('ceo', 'hr'));
create policy users_ceo_write on public.users for all to authenticated
  using ((select public.current_app_role()) = 'ceo')
  with check ((select public.current_app_role()) = 'ceo');

create policy songs_department_select on public.songs for select to authenticated
  using ((select public.current_app_role()) in ('ceo', 'finance', 'ar'));
create policy songs_department_write on public.songs for all to authenticated
  using ((select public.current_app_role()) in ('ceo', 'finance', 'ar'))
  with check ((select public.current_app_role()) in ('ceo', 'finance', 'ar'));
create policy recordings_department_select on public.recordings for select to authenticated
  using ((select public.current_app_role()) in ('ceo', 'finance', 'ar'));
create policy recordings_department_write on public.recordings for all to authenticated
  using ((select public.current_app_role()) in ('ceo', 'finance', 'ar'))
  with check ((select public.current_app_role()) in ('ceo', 'finance', 'ar'));

create policy payees_finance_select on public.payees for select to authenticated
  using ((select public.current_app_role()) in ('ceo', 'finance'));
create policy payees_finance_write on public.payees for all to authenticated
  using ((select public.current_app_role()) in ('ceo', 'finance'))
  with check ((select public.current_app_role()) in ('ceo', 'finance'));
create policy royalty_rules_finance_select on public.royalty_rules for select to authenticated
  using ((select public.current_app_role()) in ('ceo', 'finance'));
create policy royalty_rules_finance_write on public.royalty_rules for all to authenticated
  using ((select public.current_app_role()) in ('ceo', 'finance'))
  with check ((select public.current_app_role()) in ('ceo', 'finance'));
create policy royalty_imports_finance_select on public.royalty_imports for select to authenticated
  using ((select public.current_app_role()) in ('ceo', 'finance'));
create policy royalty_imports_finance_write on public.royalty_imports for all to authenticated
  using ((select public.current_app_role()) in ('ceo', 'finance'))
  with check ((select public.current_app_role()) in ('ceo', 'finance'));
create policy royalty_import_rows_finance_select on public.royalty_import_rows for select to authenticated
  using ((select public.current_app_role()) in ('ceo', 'finance'));
create policy royalty_import_rows_finance_write on public.royalty_import_rows for all to authenticated
  using ((select public.current_app_role()) in ('ceo', 'finance'))
  with check ((select public.current_app_role()) in ('ceo', 'finance'));

create policy hr_records_hr_select on public.hr_records for select to authenticated
  using ((select public.current_app_role()) in ('ceo', 'hr'));
create policy hr_records_hr_write on public.hr_records for all to authenticated
  using ((select public.current_app_role()) in ('ceo', 'hr'))
  with check ((select public.current_app_role()) in ('ceo', 'hr'));
create policy recruitment_hr_select on public.recruitment_records for select to authenticated
  using ((select public.current_app_role()) in ('ceo', 'hr'));
create policy recruitment_hr_write on public.recruitment_records for all to authenticated
  using ((select public.current_app_role()) in ('ceo', 'hr'))
  with check ((select public.current_app_role()) in ('ceo', 'hr'));

create policy contracts_legal_select on public.contracts for select to authenticated
  using ((select public.current_app_role()) in ('ceo', 'legal'));
create policy contracts_legal_write on public.contracts for all to authenticated
  using ((select public.current_app_role()) in ('ceo', 'legal'))
  with check ((select public.current_app_role()) in ('ceo', 'legal'));
create policy legal_records_legal_select on public.legal_records for select to authenticated
  using ((select public.current_app_role()) in ('ceo', 'legal'));
create policy legal_records_legal_write on public.legal_records for all to authenticated
  using ((select public.current_app_role()) in ('ceo', 'legal'))
  with check ((select public.current_app_role()) in ('ceo', 'legal'));

revoke all on public.users, public.songs, public.recordings, public.payees,
  public.royalty_rules, public.royalty_imports, public.royalty_import_rows,
  public.hr_records, public.recruitment_records, public.contracts, public.legal_records,
  public.gpt_chat_messages, public.gpt_audit_logs from anon;
revoke all on public.gpt_chat_messages, public.gpt_audit_logs from authenticated;
grant select, insert, update, delete on public.users, public.songs, public.recordings, public.payees,
  public.royalty_rules, public.royalty_imports, public.royalty_import_rows,
  public.hr_records, public.recruitment_records, public.contracts, public.legal_records to authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;

insert into storage.buckets (id, name, public, file_size_limit)
values
  ('royalty-imports', 'royalty-imports', false, 52428800),
  ('legal-contracts', 'legal-contracts', false, 52428800),
  ('hr-documents', 'hr-documents', false, 20971520)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists royalty_import_files on storage.objects;
create policy royalty_import_files on storage.objects for all to authenticated
  using (bucket_id = 'royalty-imports' and (select public.current_app_role()) in ('ceo', 'finance'))
  with check (bucket_id = 'royalty-imports' and (select public.current_app_role()) in ('ceo', 'finance'));
drop policy if exists legal_contract_files on storage.objects;
create policy legal_contract_files on storage.objects for all to authenticated
  using (bucket_id = 'legal-contracts' and (select public.current_app_role()) in ('ceo', 'legal'))
  with check (bucket_id = 'legal-contracts' and (select public.current_app_role()) in ('ceo', 'legal'));
drop policy if exists hr_document_files on storage.objects;
create policy hr_document_files on storage.objects for all to authenticated
  using (bucket_id = 'hr-documents' and (select public.current_app_role()) in ('ceo', 'hr'))
  with check (bucket_id = 'hr-documents' and (select public.current_app_role()) in ('ceo', 'hr'));
