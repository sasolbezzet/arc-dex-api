-- OAuth ephemeral shadow state.
-- This table is diagnostic-only. The local file-lock remains the authority for
-- authorization-code consumption and SIWE challenge replay protection.
-- Never store raw authorization codes, refresh/access tokens, SIWE messages,
-- nonces, signatures, or PKCE verifiers here.

create table if not exists public.oauth_ephemeral_state (
  state_key text primary key,
  state_type text not null check (state_type in ('authorization_code', 'oauth_request', 'siwe_challenge')),
  expires_at timestamptz not null,
  consumed boolean not null default false,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists oauth_ephemeral_state_expiry_idx
  on public.oauth_ephemeral_state (expires_at);
create index if not exists oauth_ephemeral_state_type_idx
  on public.oauth_ephemeral_state (state_type, updated_at desc);

drop trigger if exists oauth_ephemeral_state_set_updated_at on public.oauth_ephemeral_state;
create trigger oauth_ephemeral_state_set_updated_at
before update on public.oauth_ephemeral_state
for each row execute function public.arcox_set_updated_at();

revoke all on table public.oauth_ephemeral_state from anon, authenticated;
grant select, insert, update, delete on table public.oauth_ephemeral_state to service_role;
alter table public.oauth_ephemeral_state enable row level security;

-- No frontend policy is created. This state remains server-only and shadow-only.
