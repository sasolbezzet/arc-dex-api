-- Session metadata shadow store.
-- Never store delegate private keys, encrypted key material, passkey assertions,
-- calldata, signatures, or raw UserOperations here. JSON remains the execution
-- authority until an async, secret-aware cutover is separately reviewed.

create table if not exists public.session_metadata (
  wallet_address text primary key,
  owner_addresses text[] not null default '{}',
  delegate_address text not null default '',
  chain text not null default 'arc-testnet',
  active boolean not null default false,
  pending_authorization boolean not null default false,
  manual_revoke_pending boolean not null default false,
  revoke_reason text,
  authorization_user_op_hash text not null default '',
  authorization_user_op_hashes jsonb not null default '{}'::jsonb,
  authorization_attempt_at timestamptz,
  last_authorized_chain_at timestamptz,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  reconciled_at timestamptz,
  reconciled_on_chain boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists session_metadata_owner_idx
  on public.session_metadata using gin (owner_addresses);
create index if not exists session_metadata_active_idx
  on public.session_metadata (active, updated_at desc);
create index if not exists session_metadata_revoke_idx
  on public.session_metadata (revoke_reason)
  where revoke_reason is not null;

drop trigger if exists session_metadata_set_updated_at on public.session_metadata;
create trigger session_metadata_set_updated_at
before update on public.session_metadata
for each row execute function public.arcox_set_updated_at();

revoke all on table public.session_metadata from anon, authenticated;
grant select, insert, update, delete on table public.session_metadata to service_role;
alter table public.session_metadata enable row level security;

-- The service role is the only backend writer. No client-facing policy is
-- created; frontend/session identity remains behind the existing API.
