-- Optional persistence for Cheerful GPT.
-- Run this in Supabase SQL Editor, then configure SUPABASE_URL and
-- SUPABASE_SERVICE_ROLE_KEY only in Vercel server environment variables.

create table if not exists public.gpt_chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id text not null,
  actor_id text not null,
  actor_name text not null,
  actor_role text not null check (actor_role in ('admin', 'finance', 'ceo', 'member', 'viewer')),
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  sources jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists gpt_chat_messages_actor_created_idx
  on public.gpt_chat_messages (actor_id, created_at desc);
create index if not exists gpt_chat_messages_conversation_idx
  on public.gpt_chat_messages (conversation_id, created_at asc);

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

create index if not exists gpt_audit_logs_created_idx
  on public.gpt_audit_logs (created_at desc);
create index if not exists gpt_audit_logs_actor_idx
  on public.gpt_audit_logs (actor_id, created_at desc);

alter table public.gpt_chat_messages enable row level security;
alter table public.gpt_audit_logs enable row level security;

-- No browser policy is created intentionally. The browser cannot read these
-- tables directly. Only the server route using the Supabase service role can
-- read or write them after verifying the HttpOnly Cheerful GPT session.
