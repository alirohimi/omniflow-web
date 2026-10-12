-- ============================================================================
-- OmniFlow — tighten anon grants & lock down directory reads (0004)
--
-- Run ONCE in the Supabase SQL editor, AFTER 0003 (the LLM default table is
-- created there; 0004 revokes grants on it). Idempotent: drop-before-create
-- policies; REVOKE on a role with no grant is a no-op.
--
-- What this fixes (security audit 2026-10-12):
--
--   1. 0002/0003 granted table-level SELECT (0003: full CRUD) to the `anon`
--      role. RLS is the enforcement point and already blocks anon row access
--      on the LLM tables, but the anon grants are redundant attack surface:
--      they let an unauthenticated caller holding the PUBLIC anon key probe
--      the REST schema. Revoke every table-level anon grant; all app access
--      is behind `authenticated` (signed-in JWT), never anon.
--
--   2. 0002's "admins_readable_by_all" and "members_readable_by_all" SELECT
--      policies are `to anon, authenticated` — meaning an UNAUTHENTICATED
--      client can read the admin registry (user_ids) and every member's
--      email + display name. Rewrite both to `to authenticated` only.
--      In-app admin gating still works (it is always signed in).
--
-- NOT changed: the platform-default LLM row (0003) still exposes api_key to
-- authenticated non-admins. That is the documented, accepted trust model for
-- a personal project (see 0003 header). If this project is ever shared,
-- rotate the key — do not re-architect around it.
-- ============================================================================

-- ---- 1. revoke redundant anon table grants --------------------------------
-- (schema-usage grant stays; only row-table grants are removed. REVOKE on a
--  role with no privilege is a safe no-op.)
revoke select, insert, update, delete on public.omniflow_admins      from anon;
revoke select, insert, update, delete on public.omniflow_members     from anon;
revoke select, insert, update, delete on public.omniflow_llm_policy  from anon;
revoke select, insert, update, delete on public.omniflow_llm_default from anon;

-- ---- 2. lock the admin registry + member directory to authenticated ------
drop policy if exists "admins_readable_by_all" on public.omniflow_admins;
create policy "admins_readable_by_authenticated"
  on public.omniflow_admins for select
  to authenticated
  using (true);

drop policy if exists "members_readable_by_all" on public.omniflow_members;
create policy "members_readable_by_authenticated"
  on public.omniflow_members for select
  to authenticated
  using (true);

-- (writes on both tables were already admin/`authenticated`-only; unchanged.)

-- ---- 3. done --------------------------------------------------------------
-- After applying: no anon row access anywhere; directory/admin reads require
-- a signed-in user; LLM default api_key visibility to members is unchanged
-- (accepted). The client needs no change for 1–2 — it authenticates with a
-- JWT, not the anon key.
-- ============================================================================
