-- ============================================================================
-- OmniFlow (tewaulkfcrakeyedxunj) — live DB fixes
-- Paste this whole block into:
--   Supabase Dashboard -> your project -> SQL Editor -> New query -> Run
-- It runs as `postgres` and bypasses RLS, so it can do things the anon key
-- (and the app's admin-only path) cannot.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- STEP 1 — Diagnose bug 2 ("Wrong password after re-lock")
-- This is READ-ONLY. Run it first so we know what we are dealing with
-- before we touch anything.
-- ---------------------------------------------------------------------------
select user_id,
       length(body)                as body_len,
       length(salt)                as salt_len,
       v                            as schema_version,
       updated_at
from public.omniflow_vaults
order by updated_at desc nulls last;

-- How many distinct vault rows does your account have?
-- (More than 1 row for the same user_id means the app is upserting a new row
--  instead of updating the existing one, which is a strong sign the "wrong
--  password" bug is the stale-ciphertext-after-rollback path.)
select user_id, count(*) as n
from public.omniflow_vaults
group by user_id
order by n desc;

-- ---------------------------------------------------------------------------
-- STEP 2 — Fix bug 1 ("Could not update, you may not be an admin")
-- The admin registry is empty, so the LLM save is denied by RLS.
-- Bootstrap your account as the first admin.
-- ---------------------------------------------------------------------------
insert into public.omniflow_admins (user_id, created_by)
values ('6bc5e692-9f36-426e-888b-ac52163c57e0',
        '6bc5e692-9f36-426e-888b-ac52163c57e0')
on conflict (user_id) do nothing;

-- Verify the admin row is now present.
select user_id, created_by, created_at
from public.omniflow_admins;

-- ---------------------------------------------------------------------------
-- STEP 3 (OPTIONAL, only if you want to fix a stale vault row right now)
-- If STEP 1 shows your account has a vault row but you are stuck with a
-- "wrong password" after a password change, you can either:
--
--   (a) Delete the row so the app recreates a clean one on next sign-in:
--       delete from public.omniflow_vaults
--       where user_id = '6bc5e692-9f36-426e-888b-ac52163c57e0';
--
--   (b) Or just change the password a second time in the app — if the first
--       change left a stale ciphertext, the second change will re-encrypt
--       from the in-memory copy and persist it, so the next unlock works.
--
-- Do NOT delete the row if it is the ONLY one and you actually still know a
-- working password — you will lose your data.
-- ---------------------------------------------------------------------------

-- Confirm the final state of both tables:
select 'admins' as t, user_id from public.omniflow_admins
union all
select 'vaults', user_id from public.omniflow_vaults
order by t, user_id;
