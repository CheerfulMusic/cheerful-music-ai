-- Cheerful Music AI Finance: durable import, calculation and exception workflow.
-- Safe to run more than once in the Supabase SQL Editor.

create table if not exists public.royalty_calculation_runs (
  id uuid primary key default gen_random_uuid(),
  run_no text not null unique,
  import_id uuid not null references public.royalty_imports(id) on delete cascade,
  status text not null default 'processing' check (status in ('processing', 'completed', 'review', 'failed', 'superseded')),
  calculation_date date not null default current_date,
  base_currency text,
  input_rows integer not null default 0,
  calculated_rows integer not null default 0,
  exception_rows integer not null default 0,
  total_source_amount numeric(20, 6) not null default 0,
  total_royalty_amount numeric(20, 6) not null default 0,
  rules_snapshot jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.users(id),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.royalty_calculation_lines (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.royalty_calculation_runs(id) on delete cascade,
  import_row_id uuid not null references public.royalty_import_rows(id) on delete cascade,
  rule_id uuid not null references public.royalty_rules(id) on delete restrict,
  recording_id uuid references public.recordings(id) on delete restrict,
  payee_id uuid references public.payees(id) on delete set null,
  payee_name text not null,
  royalty_type text not null,
  calculation_basis text not null,
  share_percentage numeric(9, 6) not null check (share_percentage >= 0 and share_percentage <= 100),
  source_amount numeric(20, 6) not null default 0,
  eligible_amount numeric(20, 6) not null default 0,
  royalty_amount numeric(20, 6) not null default 0,
  currency text,
  status text not null default 'calculated' check (status in ('calculated', 'review', 'excluded', 'failed')),
  calculation_trace jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, import_row_id, rule_id)
);

create table if not exists public.finance_exceptions (
  id uuid primary key default gen_random_uuid(),
  exception_key text not null unique,
  import_id uuid not null references public.royalty_imports(id) on delete cascade,
  import_row_id uuid references public.royalty_import_rows(id) on delete cascade,
  calculation_run_id uuid references public.royalty_calculation_runs(id) on delete cascade,
  calculation_line_id uuid references public.royalty_calculation_lines(id) on delete cascade,
  exception_type text not null,
  risk_level text not null check (risk_level in ('high', 'medium', 'low')),
  subject text not null,
  description text not null,
  suggestion text,
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed', 'reopened')),
  resolution_notes text,
  resolved_by uuid references public.users(id),
  resolved_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists royalty_calculation_runs_import_idx
  on public.royalty_calculation_runs (import_id, created_at desc);
create index if not exists royalty_calculation_lines_run_idx
  on public.royalty_calculation_lines (run_id, status);
create index if not exists royalty_calculation_lines_payee_idx
  on public.royalty_calculation_lines (payee_name, currency);
create index if not exists finance_exceptions_import_status_idx
  on public.finance_exceptions (import_id, status, risk_level);

drop trigger if exists set_royalty_calculation_runs_updated_at on public.royalty_calculation_runs;
create trigger set_royalty_calculation_runs_updated_at
  before update on public.royalty_calculation_runs
  for each row execute function public.set_updated_at();
drop trigger if exists set_finance_exceptions_updated_at on public.finance_exceptions;
create trigger set_finance_exceptions_updated_at
  before update on public.finance_exceptions
  for each row execute function public.set_updated_at();

alter table public.royalty_calculation_runs enable row level security;
alter table public.royalty_calculation_lines enable row level security;
alter table public.finance_exceptions enable row level security;

drop policy if exists royalty_calculation_runs_finance_select on public.royalty_calculation_runs;
drop policy if exists royalty_calculation_runs_finance_write on public.royalty_calculation_runs;
drop policy if exists royalty_calculation_lines_finance_select on public.royalty_calculation_lines;
drop policy if exists royalty_calculation_lines_finance_write on public.royalty_calculation_lines;
drop policy if exists finance_exceptions_finance_select on public.finance_exceptions;
drop policy if exists finance_exceptions_finance_write on public.finance_exceptions;

create policy royalty_calculation_runs_finance_select on public.royalty_calculation_runs
  for select to authenticated using ((select public.current_app_role()) in ('ceo', 'finance'));
create policy royalty_calculation_runs_finance_write on public.royalty_calculation_runs
  for all to authenticated
  using ((select public.current_app_role()) in ('ceo', 'finance'))
  with check ((select public.current_app_role()) in ('ceo', 'finance'));
create policy royalty_calculation_lines_finance_select on public.royalty_calculation_lines
  for select to authenticated using ((select public.current_app_role()) in ('ceo', 'finance'));
create policy royalty_calculation_lines_finance_write on public.royalty_calculation_lines
  for all to authenticated
  using ((select public.current_app_role()) in ('ceo', 'finance'))
  with check ((select public.current_app_role()) in ('ceo', 'finance'));
create policy finance_exceptions_finance_select on public.finance_exceptions
  for select to authenticated using ((select public.current_app_role()) in ('ceo', 'finance'));
create policy finance_exceptions_finance_write on public.finance_exceptions
  for all to authenticated
  using ((select public.current_app_role()) in ('ceo', 'finance'))
  with check ((select public.current_app_role()) in ('ceo', 'finance'));

revoke all on public.royalty_calculation_runs, public.royalty_calculation_lines, public.finance_exceptions from anon;
grant select, insert, update, delete on public.royalty_calculation_runs, public.royalty_calculation_lines, public.finance_exceptions to authenticated;
grant select, insert, update, delete on public.royalty_calculation_runs, public.royalty_calculation_lines, public.finance_exceptions to service_role;
