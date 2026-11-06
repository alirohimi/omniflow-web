-- ============================================================================
-- OmniFlow — platform-default LLM policy
--
-- Run ONCE in the Supabase SQL editor (as supabase_admin / postgres), the
-- same way 0001 + 0002 were run. 0002 already created the helper
-- public.omniflow_is_admin(uuid), which this file reuses — no re-definition.
--
-- What this adds:
--   a SINGLE platform-wide default LLM row (row_id = 'default'). An admin
--   configures it once and it becomes the fallback AI for any signed-in
--   user who has NO per-user lock row AND no personal BYOK key. It is the
--   "out-of-the-box advisor" that lets every new account use AI without
--   pasting their own API key.
--
-- Resolution order in the app (see src/ai/resolveLlm.ts):
--   1. admin per-user lock row (omniflow_llm_policy)   -- most specific
--   2. the user's own BYOK key (encrypted in their vault)
--   3. THIS platform default                            -- the new fallback
--   4. free on-device rule engine
--
-- Trust model (same as 0002, no bypass):
--   * READ   -> any authenticated user (the app needs the default to build
--               the effective LLM config; provider+model are not financial
--               data and are safe to expose to members of your own project).
--   * WRITE  -> admins only, via public.omniflow_is_admin(). A non-admin
--               cannot set/replace the default because the write policy
--               demands admin status. The api_key transits the Supabase
--               gateway only (never a second public host) and is stored
--               in plain text at rest, same as 0002's per-user policy —
--               accept that risk or rotate the key.
--
-- The frontend (anon key) probes this table with a SELECT; if the table
-- does not exist yet (pre-0003), admin.ts treats it as "feature off" and
-- the app silently falls back to on-device rules. Everything is RLS-gated,
-- so a compromised browser can never write the default without admin.
-- ============================================================================

-- ---- 1. the table (single row, row_id is a PK so it upserts cleanly) ------
create table if not exists public.omniflow_llm_default (
  row_id   text primary key default 'default',
  provider text not null default 'none'
           check (provider in ('none','openai','anthropic','gemini','adacode')),
  api_key  text not null default '',
  model    text not null default '',
  key_finger text not null default '',
  set_by   uuid references auth.users (id) on delete set null, -- which admin
  updated_at timestamptz not null default now()
);
alter table public.omniflow_llm_default enable row level security;

-- ---- 2. policies -----------------------------------------------------------
-- Any signed-in user may read the platform default (needed to build the
-- effective LLM config for users who rely on it).
drop policy if exists "llm_default_readable_by_all" on public.omniflow_llm_default;
create policy "llm_default_readable_by_all"
  on public.omniflow_llm_default for select
  to authenticated
  using (true);

-- Only admins may create/update/delete the default row. The using/with check
-- both demand admin status, which transitively blocks any self-escalation.
drop policy if exists "llm_default_admin_write" on public.omniflow_llm_default;
create policy "llm_default_admin_write"
  on public.omniflow_llm_default for all
  to authenticated
  using (public.omniflow_is_admin())
  with check (public.omniflow_is_admin());

-- ---- 3. updated_at touch trigger -------------------------------------------
create or replace function public.omniflow_llm_default_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists omniflow_llm_default_touch_trg on public.omniflow_llm_default;
create trigger omniflow_llm_default_touch_trg
  before update on public.omniflow_llm_default
  for each row execute function public.omniflow_llm_default_touch();

-- ---- 4. grants -------------------------------------------------------------
-- Read granted broadly (RLS still enforces the policies); write granted to
-- anon/authenticated but effectively admin-only through the policy above.
grant select on public.omniflow_llm_default to anon, authenticated;
grant select, insert, update, delete on public.omniflow_llm_default to anon, authenticated;

-- Seed an inert default row so reads never 404 into "no row" once 0003 is
-- applied. provider 'none' + empty key = "no platform default — users keep
-- their own BYOK / on-device settings." An admin's set/replace overrides it.
insert into public.omniflow_llm_default (row_id, provider, api_key, model, key_finger, set_by)
values ('default', 'none', '', '', '', null)
on conflict (row_id) do nothing;
