-- ARCOX financial and Agent Activity persistence.
--
-- These tables are backend-only. No PAN, CVV, private key, passkey assertion,
-- or bearer token is stored here. Card records contain only masked metadata;
-- the local encrypted/provider store remains the authority for sensitive card
-- details and signing keys.

create table if not exists public.agent_activity (
  id uuid primary key,
  owner_address text not null,
  activity_type text not null,
  data jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists agent_activity_owner_occurred_idx
  on public.agent_activity (owner_address, occurred_at desc);

create table if not exists public.agent_approvals (
  id uuid primary key,
  owner_address text not null,
  agent text not null default '',
  action text not null,
  amount text not null default '',
  token text not null default 'USDC',
  source text not null default '',
  destination text not null default '',
  status text not null default 'pending',
  tx_hash text not null default '',
  explorer_url text not null default '',
  error text not null default '',
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists agent_approvals_owner_updated_idx
  on public.agent_approvals (owner_address, updated_at desc);
create index if not exists agent_approvals_status_idx
  on public.agent_approvals (status, updated_at desc);

create table if not exists public.card_accounts (
  owner_address text primary key,
  msca_address text not null default '',
  balance text not null default '0',
  source text not null default 'onchain',
  synced_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists card_accounts_msca_idx
  on public.card_accounts (msca_address);

create table if not exists public.card_records (
  card_id text primary key,
  owner_address text not null,
  label text not null default '',
  brand text not null default 'Visa Test',
  network text not null default 'visa',
  provider text not null default 'simulator',
  provider_card_id text,
  last4 text not null default '',
  status text not null default 'active',
  blocked_categories text[] not null default '{}',
  limits jsonb not null default '{}'::jsonb,
  usage jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists card_records_owner_created_idx
  on public.card_records (owner_address, created_at desc);

create table if not exists public.card_transactions (
  transaction_id text primary key,
  card_id text not null,
  owner_address text not null,
  merchant_id text not null default '',
  merchant_name text not null default '',
  category text not null default '',
  description text not null default '',
  amount text not null default '0',
  status text not null default 'authorized',
  auth_code text not null default '',
  onchain boolean not null default false,
  provider text not null default '',
  tx_hash text not null default '',
  explorer_url text not null default '',
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  refunded_at timestamptz,
  decline_reason text not null default '',
  metadata jsonb not null default '{}'
);

create index if not exists card_transactions_owner_created_idx
  on public.card_transactions (owner_address, created_at desc);
create index if not exists card_transactions_card_created_idx
  on public.card_transactions (card_id, created_at desc);
create index if not exists card_transactions_status_idx
  on public.card_transactions (status, created_at desc);

create table if not exists public.treasury_financial_events (
  id uuid primary key,
  owner_address text not null default '',
  event_type text not null,
  amount text not null default '',
  token text not null default 'USDC',
  chain text not null default '',
  status text not null default '',
  tx_hash text not null default '',
  metadata jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);

create index if not exists treasury_financial_events_owner_occurred_idx
  on public.treasury_financial_events (owner_address, occurred_at desc);
create index if not exists treasury_financial_events_type_occurred_idx
  on public.treasury_financial_events (event_type, occurred_at desc);

-- Maintain updated_at consistently with the existing persistence schema.
drop trigger if exists agent_approvals_set_updated_at on public.agent_approvals;
create trigger agent_approvals_set_updated_at
before update on public.agent_approvals
for each row execute function public.arcox_set_updated_at();

drop trigger if exists card_accounts_set_updated_at on public.card_accounts;
create trigger card_accounts_set_updated_at
before update on public.card_accounts
for each row execute function public.arcox_set_updated_at();

drop trigger if exists card_records_set_updated_at on public.card_records;
create trigger card_records_set_updated_at
before update on public.card_records
for each row execute function public.arcox_set_updated_at();

revoke all on table
  public.agent_activity,
  public.agent_approvals,
  public.card_accounts,
  public.card_records,
  public.card_transactions,
  public.treasury_financial_events
from anon, authenticated;

grant select, insert, update, delete on table
  public.agent_activity,
  public.agent_approvals,
  public.card_accounts,
  public.card_records,
  public.card_transactions,
  public.treasury_financial_events
to service_role;

alter table public.agent_activity enable row level security;
alter table public.agent_approvals enable row level security;
alter table public.card_accounts enable row level security;
alter table public.card_records enable row level security;
alter table public.card_transactions enable row level security;
alter table public.treasury_financial_events enable row level security;

-- No client policies are created. All reads/writes remain behind the ARCOX
-- backend, which performs owner/MSCA checks before returning financial data.
