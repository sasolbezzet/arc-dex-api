-- ARCOX DEX initial low-risk persistence schema
--
-- This migration deliberately excludes active session keys, OAuth tokens,
-- auto-mint jobs, vault credentials, and blockchain execution state.
-- Those domains require a separate cutover after adapter and locking tests.
--
-- The backend is the only intended client in this phase. Tables remain in the
-- public schema for the existing Supabase Data API, but anon/authenticated
-- access is revoked and RLS is enabled on every table.

create table if not exists public.transaction_history (
  id text primary key,
  owner_address text not null,
  action text not null check (action in ('bridge', 'swap', 'send')),
  source text not null default 'web-ui',
  wallet_source text not null default '',
  from_chain text not null default '',
  to_chain text not null default '',
  amount text not null default '',
  token text not null default 'USDC',
  status text not null check (status in ('pending', 'success', 'error')),
  tx_hash text not null default '',
  explorer_url text not null default '',
  approve_tx_hash text not null default '',
  burn_tx_hash text not null default '',
  burn_explorer_url text not null default '',
  mint_tx_hash text not null default '',
  mint_explorer_url text not null default '',
  source_domain integer,
  destination_domain integer,
  note text not null default '',
  error text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payment_invoices (
  invoice_id text primary key,
  order_id text not null default '',
  merchant_address text not null,
  amount text not null,
  token text not null default 'USDC',
  network text not null default 'arc-testnet',
  memo text not null default '',
  status text not null check (status in ('unpaid', 'pending', 'paid', 'expired', 'failed', 'cancelled')),
  payment_url text not null default '',
  payer_address text not null default '',
  tx_hash text not null default '',
  paid_at timestamptz,
  expires_at timestamptz not null,
  timeline jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.invoice_events (
  id uuid primary key,
  invoice_id text not null references public.payment_invoices(invoice_id) on delete cascade,
  event_type text not null,
  message text not null default '',
  tx_hash text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.webhook_events (
  id uuid primary key,
  provider text not null,
  notification_id text not null,
  event_type text not null default '',
  raw_payload jsonb not null default '{}'::jsonb,
  processed boolean not null default false,
  matched boolean not null default false,
  related_invoice_id text,
  related_tx_hash text not null default '',
  related_user_operation_hash text not null default '',
  wallet_address text not null default '',
  status text not null default '',
  error text not null default '',
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, notification_id)
);

create table if not exists public.ai_router_usage (
  request_id text primary key,
  owner_address text not null,
  agent_id text not null default '',
  api_key_id_hash text not null default '',
  sbt_token_id text not null default '',
  payment_id text not null default '',
  tx_hash text not null default '',
  memo_id text not null default '',
  job_id text not null default '',
  model text not null default '',
  provider_used text not null default '',
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cost_usdc text not null default '0.000000',
  fallback_count integer not null default 0 check (fallback_count >= 0),
  status text not null default 'created',
  latency_ms integer not null default 0 check (latency_ms >= 0),
  error text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Shared timestamp maintenance. This is a normal trigger function, not a
-- SECURITY DEFINER function, and it is not exposed as a client RPC endpoint.
create or replace function public.arcox_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists transaction_history_set_updated_at on public.transaction_history;
create trigger transaction_history_set_updated_at
before update on public.transaction_history
for each row execute function public.arcox_set_updated_at();

drop trigger if exists payment_invoices_set_updated_at on public.payment_invoices;
create trigger payment_invoices_set_updated_at
before update on public.payment_invoices
for each row execute function public.arcox_set_updated_at();

drop trigger if exists webhook_events_set_updated_at on public.webhook_events;
create trigger webhook_events_set_updated_at
before update on public.webhook_events
for each row execute function public.arcox_set_updated_at();

drop trigger if exists ai_router_usage_set_updated_at on public.ai_router_usage;
create trigger ai_router_usage_set_updated_at
before update on public.ai_router_usage
for each row execute function public.arcox_set_updated_at();

create index if not exists transaction_history_owner_occurred_idx
  on public.transaction_history (owner_address, occurred_at desc);
create index if not exists transaction_history_owner_status_idx
  on public.transaction_history (owner_address, status);
create index if not exists transaction_history_burn_tx_idx
  on public.transaction_history (burn_tx_hash)
  where burn_tx_hash <> '';

create index if not exists payment_invoices_merchant_created_idx
  on public.payment_invoices (merchant_address, created_at desc);
create index if not exists payment_invoices_status_expiry_idx
  on public.payment_invoices (status, expires_at);
create index if not exists payment_invoices_tx_hash_idx
  on public.payment_invoices (tx_hash)
  where tx_hash <> '';

create index if not exists invoice_events_invoice_created_idx
  on public.invoice_events (invoice_id, created_at desc);

create index if not exists webhook_events_status_received_idx
  on public.webhook_events (processed, received_at desc);
create index if not exists webhook_events_related_tx_idx
  on public.webhook_events (related_tx_hash)
  where related_tx_hash <> '';
create index if not exists webhook_events_related_user_op_idx
  on public.webhook_events (related_user_operation_hash)
  where related_user_operation_hash <> '';

create index if not exists ai_router_usage_owner_created_idx
  on public.ai_router_usage (owner_address, created_at desc);
create index if not exists ai_router_usage_payment_idx
  on public.ai_router_usage (payment_id)
  where payment_id <> '';

-- Explicitly keep the first migration backend-only. service_role bypasses RLS,
-- but the grant makes the intended access contract explicit and reviewable.
revoke all on table
  public.transaction_history,
  public.payment_invoices,
  public.invoice_events,
  public.webhook_events,
  public.ai_router_usage
from anon, authenticated;

grant select, insert, update, delete on table
  public.transaction_history,
  public.payment_invoices,
  public.invoice_events,
  public.webhook_events,
  public.ai_router_usage
to service_role;

alter table public.transaction_history enable row level security;
alter table public.payment_invoices enable row level security;
alter table public.invoice_events enable row level security;
alter table public.webhook_events enable row level security;
alter table public.ai_router_usage enable row level security;

-- No anon/authenticated policies are intentionally created in this phase.
-- Frontend access remains through the existing backend API until the identity
-- binding model for EOA -> MSCA and MCP OAuth is migrated and tested.

revoke execute on function public.arcox_set_updated_at() from public, anon, authenticated;
grant execute on function public.arcox_set_updated_at() to service_role;
