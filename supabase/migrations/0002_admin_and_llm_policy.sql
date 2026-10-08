-- ============================================================================
-- OmniFlow — admin registry + member directory + admin LLM policy
--
-- Run ONCE in the Supabase SQL editor (as supabase_admin / postgres), the
-- same way 0001 was run. The frontend (anon key only) can do nothing
-- privileged: every capability below is gated by RLS, so a compromised
-- browser can never grant itself admin or read another user's policy row.
--
-- New objects:
--   omniflow_admins      user_id registry (bootstrap: ichsanalir@gmail.com)
--   omniflow_members     self-registry of signed-in users (directory)
--   omniflow_llm_policy  admin-assigned LLM provider/key/model per user
--   omniflow_vaults      + admin read (existence/last-sync) and admin wipe
--
-- Design notes:
--   * The LLM API key is stored in plain text in omniflow_llm_policy (Postgres
--     at rest). Only the admin and the target user's app (their own row) can
--     read it. Accept that risk or rotate the key periodically.
--   * Member self-registration is the only write path for members; admins
--     cannot forge another user's row, which keeps the directory honest.
-- ============================================================================

-- ---- 0. admin check helper -------------------------------------------------
-- SECURITY INVOKER: checks run with the CALLER's privileges and hit RLS on
-- omniflow_admins (which any authenticated user can read). No bypass.
create or replace function public.omniflow_is_admin(uid uuid default null)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.omniflow_admins a where a.user_id = coalesce(uid, (select auth.uid()))
  );
$$;

grant execute on function public.omniflow_is_admin(uuid) to anon, authenticated;

-- ---- 1. omniflow_admins ------------------------------------------------------
create table if not exists public.omniflow_admins (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  created_by  uuid references auth.users (id) on delete set null, -- who granted
  created_at  timestamptz not null default now()
);

alter table public.omniflow_admins enable row level security;

-- Anyone signed in may READ the admin registry (needed for UI gating + the
-- is-admin check). Writing requires admin, which transitively prevents any
-- self-escalation: a non-admin cannot INSERT their own row because the
-- policy below demands admin status for writes.
drop policy if exists "admins_readable_by_all" on public.omniflow_admins;
create policy "admins_readable_by_all"
  on public.omniflow_admins for select
  to anon, authenticated
  using (true);

drop policy if exists "admins_admin_write" on public.omniflow_admins;
create policy "admins_admin_write"
  on public.omniflow_admins for all
  to authenticated
  using (public.omniflow_is_admin())
  with check (public.omniflow_is_admin());

-- ---- 2. omniflow_members (directory) ----------------------------------------
create table if not exists public.omniflow_members (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  display_name  text not null default '',
  email         text not null,
  last_seen_at  timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

alter table public.omniflow_members enable row level security;

-- Self row: the user registers themselves and keeps it fresh (display name,
-- last-seen). No one else may write it.
drop policy if exists "members_self" on public.omniflow_members;
create policy "members_self"
  on public.omniflow_members for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "members_self_update" on public.omniflow_members;
create policy "members_self_update"
  on public.omniflow_members for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Directory: every signed-in user may read members (names/emails are
-- account-level facts, not financial data).
drop policy if exists "members_readable_by_all" on public.omniflow_members;
create policy "members_readable_by_all"
  on public.omniflow_members for select
  to anon, authenticated
  using (true);

-- Admins may remove a member's directory entry.
drop policy if exists "members_admin_delete" on public.omniflow_members;
create policy "members_admin_delete"
  on public.omniflow_members for delete
  to authenticated
  using (public.omniflow_is_admin());

-- ---- 3. omniflow_llm_policy ---------------------------------------------------
create table if not exists public.omniflow_llm_policy (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  provider   text not null default 'none'
             check (provider in ('none','openai','anthropic','gemini','adacode')),
  api_key    text not null default '',
  model      text not null default '',
  key_finger text not null default '',
  set_by     uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.omniflow_llm_policy enable row level security;

-- The target user may read their OWN row (the app uses it to build the
-- effective LLM config). No one may read another user's row — that is what
-- makes the lock unforgeable from the client.
drop policy if exists "llm_policy_self_read" on public.omniflow_llm_policy;
create policy "llm_policy_self_read"
  on public.omniflow_llm_policy for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Only admins may create/update/delete policy rows (for any user).
drop policy if exists "llm_policy_admin_write" on public.omniflow_llm_policy;
create policy "llm_policy_admin_write"
  on public.omniflow_llm_policy for all
  to authenticated
  using (public.omniflow_is_admin())
  with check (public.omniflow_is_admin());

create or replace function public.omniflow_llm_policy_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists omniflow_llm_policy_touch_trg on public.omniflow_llm_policy;
create trigger omniflow_llm_policy_touch_trg
  before update on public.omniflow_llm_policy
  for each row execute function public.omniflow_llm_policy_touch();

-- ---- 4. omniflow_vaults: admin read + admin wipe -----------------------------
-- Admins may see existence / last-sync of every vault row (no plaintext — the
-- columns are ciphertext + metadata).
drop policy if exists "vaults_admin_read" on public.omniflow_vaults;
create policy "vaults_admin_read"
  on public.omniflow_vaults for select
  to authenticated
  using (public.omniflow_is_admin());

-- Admins may delete any member's vault (data wipe, admin panel).
drop policy if exists "vaults_admin_delete" on public.omniflow_vaults;
create policy "vaults_admin_delete"
  on public.omniflow_vaults for delete
  to authenticated
  using (public.omniflow_is_admin());

-- ---- 5. grants ----------------------------------------------------------------
-- Data API exposure: the new tables must be reachable by the API roles even
-- though RLS is what actually gates every row.
grant usage on schema public to anon, authenticated;
grant select on public.omniflow_admins, public.omniflow_members to anon, authenticated;
grant insert, update on public.omniflow_members to anon, authenticated;
grant select on public.omniflow_llm_policy to anon, authenticated;
grant select, insert, update, delete on public.omniflow_admins, public.omniflow_llm_policy to anon, authenticated;
grant delete on public.omniflow_members to authenticated;

-- Bootstrap: promote the account owner to admin. Runs only when the account
-- already exists; if not yet, run this INSERT (or use the admin panel later):
--   insert into public.omniflow_admins (user_id) values
--   (select id from auth.users where lower(email) = 'ichsanalir@gmail.com');
insert into public.omniflow_admins (user_id, created_by)
select u.id, u.id
from auth.users u
where lower(u.email) = 'ichsanalir@gmail.com'
on conflict (user_id) do nothing;
