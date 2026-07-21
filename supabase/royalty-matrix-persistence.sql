-- Cheerful Music AI Finance: durable Royalty Matrix import history and review queue.
-- Safe to run more than once in the Supabase SQL Editor.

create table if not exists public.royalty_rule_imports (
  id uuid primary key default gen_random_uuid(),
  batch_no text not null unique,
  original_filename text not null,
  file_size bigint not null default 0 check (file_size >= 0),
  total_rows integer not null default 0 check (total_rows >= 0),
  imported_rows integer not null default 0 check (imported_rows >= 0),
  updated_rows integer not null default 0 check (updated_rows >= 0),
  skipped_rows integer not null default 0 check (skipped_rows >= 0),
  failed_rows integer not null default 0 check (failed_rows >= 0),
  review_rows integer not null default 0 check (review_rows >= 0),
  status text not null default 'completed' check (status in ('processing', 'completed', 'partial', 'failed')),
  schema_version text not null default 'royalty-rule-v1',
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.royalty_rule_review_queue (
  id uuid primary key default gen_random_uuid(),
  review_key text not null unique,
  import_id uuid not null references public.royalty_rule_imports(id) on delete cascade,
  source_row_number integer not null check (source_row_number > 0),
  status text not null default 'needs_review' check (status in ('needs_review', 'resolved', 'dismissed')),
  reason text not null,
  source_data jsonb not null default '{}'::jsonb,
  matched_recording_id uuid references public.recordings(id) on delete set null,
  match_method text,
  resolution_action text,
  resolution_notes text,
  resolved_by uuid references public.users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists royalty_rule_imports_created_idx
  on public.royalty_rule_imports (created_at desc);
create index if not exists royalty_rule_review_queue_import_status_idx
  on public.royalty_rule_review_queue (import_id, status, created_at desc);
create index if not exists royalty_rule_review_queue_recording_idx
  on public.royalty_rule_review_queue (matched_recording_id);

drop trigger if exists set_royalty_rule_imports_updated_at on public.royalty_rule_imports;
create trigger set_royalty_rule_imports_updated_at
  before update on public.royalty_rule_imports
  for each row execute function public.set_updated_at();

drop trigger if exists set_royalty_rule_review_queue_updated_at on public.royalty_rule_review_queue;
create trigger set_royalty_rule_review_queue_updated_at
  before update on public.royalty_rule_review_queue
  for each row execute function public.set_updated_at();

alter table public.royalty_rule_imports enable row level security;
alter table public.royalty_rule_review_queue enable row level security;

drop policy if exists royalty_rule_imports_finance_select on public.royalty_rule_imports;
drop policy if exists royalty_rule_imports_finance_write on public.royalty_rule_imports;
drop policy if exists royalty_rule_review_queue_finance_select on public.royalty_rule_review_queue;
drop policy if exists royalty_rule_review_queue_finance_write on public.royalty_rule_review_queue;

create policy royalty_rule_imports_finance_select on public.royalty_rule_imports
  for select to authenticated using ((select public.current_app_role()) in ('ceo', 'finance'));
create policy royalty_rule_imports_finance_write on public.royalty_rule_imports
  for all to authenticated
  using ((select public.current_app_role()) in ('ceo', 'finance'))
  with check ((select public.current_app_role()) in ('ceo', 'finance'));
create policy royalty_rule_review_queue_finance_select on public.royalty_rule_review_queue
  for select to authenticated using ((select public.current_app_role()) in ('ceo', 'finance'));
create policy royalty_rule_review_queue_finance_write on public.royalty_rule_review_queue
  for all to authenticated
  using ((select public.current_app_role()) in ('ceo', 'finance'))
  with check ((select public.current_app_role()) in ('ceo', 'finance'));

revoke all on public.royalty_rule_imports, public.royalty_rule_review_queue from anon;
grant select, insert, update, delete on public.royalty_rule_imports, public.royalty_rule_review_queue to authenticated;
grant select, insert, update, delete on public.royalty_rule_imports, public.royalty_rule_review_queue to service_role;
