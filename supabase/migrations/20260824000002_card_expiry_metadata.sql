-- Preserve non-sensitive expiry metadata for the masked card projection.
-- PAN and CVV remain intentionally absent from Supabase.

alter table public.card_records
  add column if not exists exp_month text not null default '',
  add column if not exists exp_year text not null default '';
