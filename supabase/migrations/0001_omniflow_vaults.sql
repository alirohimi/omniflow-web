-- ============================================================================
-- OmniFlow — per-user cloud vault table (Supabase / Postgres)
--
-- Stores ONLY encrypted vault blobs (AES-256-GCM ciphertext). No plaintext
-- financial data ever reaches the database; the passphrase stays device-local.
--
-- Run this ONCE from the Supabase SQL editor (dashboard -> SQL editor).
-- It must run as the supabase_admin / postgres role: RLS policies that
-- reference auth.uid() cannot be created through the pooler app role.
--
-- Verifying afterwards: after running, sign in on two devices and confirm
-- Settings > Account & Sync shows "synced".
-- ============================================================================

create table if not exists public.omniflow_vaults (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  v           integer not null default 1,   -- encryption scheme version
  salt        text    not null,             -- base64 PBKDF2 salt
  iv          text    not null,             -- base64 GCM iv
  body        text    not null,             -- base64 AES-256-GCM ciphertext
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Row level security: a user can read/write ONLY their own row.
alter table public.omniflow_vaults enable row level security;

drop policy if exists "omniflow_vaults_self" on public.omniflow_vaults;
create policy "omniflow_vaults_self"
  on public.omniflow_vaults
  for all
  to anon, authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Keep updated_at fresh on writes.
create or replace function public.omniflow_vaults_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists omniflow_vaults_touch_trg on public.omniflow_vaults;
create trigger omniflow_vaults_touch_trg
  before update on public.omniflow_vaults
  for each row execute function public.omniflow_vaults_touch();

-- Grant access to the API roles (Supabase clients hit the API as anon;
-- signed-in sessions are also permitted, RLS still scopes by auth.uid()).
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.omniflow_vaults to anon, authenticated;
