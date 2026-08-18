-- x402 invoice state is a reconciliation cache, not a payment authority.
-- On-chain receipt/webhook verification remains the source of truth.
create table if not exists public.x402_invoices (
  invoice_id text primary key,
  payment_id text not null unique,
  owner_wallet text not null default '',
  status text not null default '',
  amount text not null default '',
  network text not null default '',
  tx_hash text not null default '',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists x402_invoices_owner_created_idx
  on public.x402_invoices (owner_wallet, created_at desc);
create index if not exists x402_invoices_status_updated_idx
  on public.x402_invoices (status, updated_at desc);
create index if not exists x402_invoices_tx_hash_idx
  on public.x402_invoices (tx_hash)
  where tx_hash <> '';

drop trigger if exists x402_invoices_set_updated_at on public.x402_invoices;
create trigger x402_invoices_set_updated_at
before update on public.x402_invoices
for each row execute function public.arcox_set_updated_at();

revoke all on table public.x402_invoices from anon, authenticated;
grant select, insert, update, delete on table public.x402_invoices to service_role;
alter table public.x402_invoices enable row level security;
