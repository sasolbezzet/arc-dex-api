-- ARCOX x402 refund audit log.
--
-- Append-only financial audit trail for every auto-refund decision
-- (pending_review, refund_approved, refund_manual_review, refund_executed,
-- refund_execute_failed, refund_completed, skipped_*). The backend writes
-- through the same dual-write queue as the other tables; the in-memory log
-- and per-invoice refundTimeline remain the offline fallback.
--
-- Backend-only table: anon/authenticated access is revoked and RLS is
-- enabled, matching the first migration's access contract.

create table if not exists public.refund_audit_log (
  id uuid primary key,
  invoice_id text not null default '',
  payment_id text not null default '',
  action text not null,
  amount_usdc numeric(20, 6) not null default 0,
  owner_wallet text not null default '',
  service_status text not null default '',
  tx_hash text not null default '',
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists refund_audit_log_invoice_idx
  on public.refund_audit_log (invoice_id, created_at desc)
  where invoice_id <> '';

create index if not exists refund_audit_log_owner_created_idx
  on public.refund_audit_log (owner_wallet, created_at desc);

create index if not exists refund_audit_log_action_created_idx
  on public.refund_audit_log (action, created_at desc);

create index if not exists refund_audit_log_tx_hash_idx
  on public.refund_audit_log (tx_hash)
  where tx_hash <> '';

-- Backend-only access contract, identical to the first migration.
revoke all on table public.refund_audit_log from anon, authenticated;

grant select, insert, update, delete on table public.refund_audit_log to service_role;

alter table public.refund_audit_log enable row level security;

-- No anon/authenticated policies are intentionally created. Frontend access
-- remains through the backend API (GET /api/x402/refunds/log).
