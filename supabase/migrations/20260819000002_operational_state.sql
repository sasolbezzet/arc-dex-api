-- Operational persistence for idempotent webhooks and auto-mint polling.
-- Supabase stores coordination/state only; signatures, receipts, attestations,
-- and destination nonce checks remain authoritative for financial outcomes.

alter table public.webhook_events
  add column if not exists claim_token text,
  add column if not exists claim_expires_at timestamptz,
  add column if not exists claim_attempts integer not null default 0,
  add column if not exists claimed_at timestamptz;

create index if not exists webhook_events_claim_expiry_idx
  on public.webhook_events (claim_expires_at)
  where claim_expires_at is not null;

create table if not exists public.auto_mint_jobs (
  job_id text primary key,
  burn_tx_hash text not null unique,
  owner_address text not null,
  from_chain text not null,
  to_chain text not null,
  status text not null default 'polling',
  retryable boolean not null default false,
  attempts integer not null default 0 check (attempts >= 0),
  total_attempts integer not null default 0 check (total_attempts >= 0),
  retry_count integer not null default 0 check (retry_count >= 0),
  next_retry_at timestamptz,
  last_attempt_at timestamptz,
  ready_at timestamptz,
  attestation text not null default '',
  message text not null default '',
  message_transmitter text not null default '',
  error text not null default '',
  lease_token text,
  lease_expires_at timestamptz,
  lease_attempts integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists auto_mint_jobs_owner_updated_idx
  on public.auto_mint_jobs (owner_address, updated_at desc);
create index if not exists auto_mint_jobs_status_retry_idx
  on public.auto_mint_jobs (status, next_retry_at);
create index if not exists auto_mint_jobs_lease_idx
  on public.auto_mint_jobs (lease_expires_at)
  where lease_expires_at is not null;

drop trigger if exists auto_mint_jobs_set_updated_at on public.auto_mint_jobs;
create trigger auto_mint_jobs_set_updated_at
before update on public.auto_mint_jobs
for each row execute function public.arcox_set_updated_at();

revoke all on table public.auto_mint_jobs from anon, authenticated;
grant select, insert, update, delete on table public.auto_mint_jobs to service_role;
alter table public.auto_mint_jobs enable row level security;

-- A claim is atomic under a row lock. The caller must still verify the exact
-- burn hash, route, attestation and destination receipt before treating a job
-- as completed.
create or replace function public.arcox_claim_webhook_event(
  p_provider text,
  p_notification_id text,
  p_claim_token text,
  p_lease_seconds integer,
  p_event jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_event public.webhook_events%rowtype;
  lease_seconds integer := greatest(5, least(coalesce(p_lease_seconds, 120), 900));
begin
  if nullif(trim(p_provider), '') is null or nullif(trim(p_notification_id), '') is null or nullif(trim(p_claim_token), '') is null then
    raise exception 'provider, notification_id and claim_token are required';
  end if;

  select * into current_event
  from public.webhook_events
  where provider = p_provider and notification_id = p_notification_id
  for update;

  if not found then
    insert into public.webhook_events (
      id, provider, notification_id, event_type, raw_payload, processed, matched,
      related_invoice_id, related_tx_hash, related_user_operation_hash,
      wallet_address, status, error, received_at, processed_at,
      claim_token, claim_expires_at, claim_attempts, claimed_at
    ) values (
      gen_random_uuid(), p_provider, p_notification_id,
      coalesce(nullif(p_event->>'event_type', ''), ''),
      coalesce(p_event->'raw_payload', '{}'::jsonb),
      coalesce((p_event->>'processed')::boolean, false),
      coalesce((p_event->>'matched')::boolean, false),
      nullif(p_event->>'related_invoice_id', ''),
      coalesce(p_event->>'related_tx_hash', ''),
      coalesce(p_event->>'related_user_operation_hash', ''),
      coalesce(p_event->>'wallet_address', ''),
      coalesce(p_event->>'status', ''),
      coalesce(p_event->>'error', ''),
      coalesce((p_event->>'received_at')::timestamptz, now()),
      (p_event->>'processed_at')::timestamptz,
      p_claim_token, now() + make_interval(secs => lease_seconds), 1, now()
    ) returning * into current_event;
    return jsonb_build_object('claimed', true, 'duplicate', false, 'event', to_jsonb(current_event));
  end if;

  if current_event.processed then
    return jsonb_build_object('claimed', false, 'duplicate', true, 'event', to_jsonb(current_event));
  end if;

  if current_event.claim_expires_at is not null
     and current_event.claim_expires_at > now()
     and current_event.claim_token is distinct from p_claim_token then
    return jsonb_build_object('claimed', false, 'duplicate', true, 'event', to_jsonb(current_event));
  end if;

  update public.webhook_events
  set claim_token = p_claim_token,
      claim_expires_at = now() + make_interval(secs => lease_seconds),
      claim_attempts = current_event.claim_attempts + 1,
      claimed_at = now()
  where provider = p_provider and notification_id = p_notification_id
  returning * into current_event;

  return jsonb_build_object('claimed', true, 'duplicate', false, 'event', to_jsonb(current_event));
end;
$$;

create or replace function public.arcox_complete_webhook_event(
  p_provider text,
  p_notification_id text,
  p_claim_token text,
  p_event jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  changed integer;
begin
  update public.webhook_events
  set event_type = coalesce(nullif(p_event->>'event_type', ''), event_type),
      raw_payload = coalesce(p_event->'raw_payload', raw_payload),
      processed = coalesce((p_event->>'processed')::boolean, processed),
      matched = coalesce((p_event->>'matched')::boolean, matched),
      related_invoice_id = nullif(p_event->>'related_invoice_id', ''),
      related_tx_hash = coalesce(p_event->>'related_tx_hash', related_tx_hash),
      related_user_operation_hash = coalesce(p_event->>'related_user_operation_hash', related_user_operation_hash),
      wallet_address = coalesce(p_event->>'wallet_address', wallet_address),
      status = coalesce(p_event->>'status', status),
      error = coalesce(p_event->>'error', error),
      received_at = coalesce((p_event->>'received_at')::timestamptz, received_at),
      processed_at = (p_event->>'processed_at')::timestamptz,
      claim_token = null,
      claim_expires_at = null,
      claimed_at = null
  where provider = p_provider
    and notification_id = p_notification_id
    and claim_token = p_claim_token;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

create or replace function public.arcox_claim_auto_mint_job(
  p_job_id text,
  p_burn_tx_hash text,
  p_owner_address text,
  p_from_chain text,
  p_to_chain text,
  p_lease_token text,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_job public.auto_mint_jobs%rowtype;
  lease_seconds integer := greatest(10, least(coalesce(p_lease_seconds, 180), 1800));
begin
  select * into current_job from public.auto_mint_jobs where job_id = p_job_id for update;
  if not found then
    insert into public.auto_mint_jobs (
      job_id, burn_tx_hash, owner_address, from_chain, to_chain,
      status, lease_token, lease_expires_at, lease_attempts, payload
    ) values (
      p_job_id, p_burn_tx_hash, lower(p_owner_address), p_from_chain, p_to_chain,
      'polling', p_lease_token, now() + make_interval(secs => lease_seconds), 1, '{}'::jsonb
    ) returning * into current_job;
    return jsonb_build_object('claimed', true, 'conflict', false, 'job', to_jsonb(current_job));
  end if;

  if lower(current_job.owner_address) <> lower(p_owner_address)
     or current_job.burn_tx_hash <> p_burn_tx_hash then
    return jsonb_build_object('claimed', false, 'conflict', true, 'job', to_jsonb(current_job));
  end if;

  if current_job.status in ('cancelled', 'completed') then
    return jsonb_build_object('claimed', false, 'conflict', true, 'job', to_jsonb(current_job));
  end if;

  if current_job.lease_expires_at is not null
     and current_job.lease_expires_at > now()
     and current_job.lease_token is distinct from p_lease_token then
    return jsonb_build_object('claimed', false, 'conflict', true, 'job', to_jsonb(current_job));
  end if;

  update public.auto_mint_jobs
  set lease_token = p_lease_token,
      lease_expires_at = now() + make_interval(secs => lease_seconds),
      lease_attempts = current_job.lease_attempts + 1,
      status = case when status in ('ready', 'retryable') then status else 'polling' end
  where job_id = p_job_id
  returning * into current_job;
  return jsonb_build_object('claimed', true, 'conflict', false, 'job', to_jsonb(current_job));
end;
$$;

create or replace function public.arcox_release_auto_mint_lease(
  p_job_id text,
  p_lease_token text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  changed integer;
begin
  update public.auto_mint_jobs
  set lease_token = null, lease_expires_at = null
  where job_id = p_job_id and lease_token = p_lease_token;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

revoke execute on function public.arcox_claim_webhook_event(text, text, text, integer, jsonb) from public, anon, authenticated;
revoke execute on function public.arcox_complete_webhook_event(text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.arcox_claim_auto_mint_job(text, text, text, text, text, text, integer) from public, anon, authenticated;
revoke execute on function public.arcox_release_auto_mint_lease(text, text) from public, anon, authenticated;
grant execute on function public.arcox_claim_webhook_event(text, text, text, integer, jsonb) to service_role;
grant execute on function public.arcox_complete_webhook_event(text, text, text, jsonb) to service_role;
grant execute on function public.arcox_claim_auto_mint_job(text, text, text, text, text, text, integer) to service_role;
grant execute on function public.arcox_release_auto_mint_lease(text, text) to service_role;

drop trigger if exists webhook_events_set_updated_at on public.webhook_events;
create trigger webhook_events_set_updated_at
before update on public.webhook_events
for each row execute function public.arcox_set_updated_at();
