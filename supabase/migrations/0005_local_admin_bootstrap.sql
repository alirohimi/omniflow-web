-- ============================================================================
-- OmniFlow — local admin bootstrap (0005)
--
-- 0002 bootstrapped an admin row only for ichsanalir@gmail.com (the hosted
-- project's owner). In a fresh local stack no such user exists, so the admin
-- panel is inert until someone is promoted.
--
-- Promotion rule (unchanged from 0002): the omniflow_admins write policy
-- requires omniflow_is_admin() to be true for the CALLER, and the registry is
-- seeded empty — so no one can self-promote. The bootstrap below creates the
-- FIRST admin out-of-band. Which account becomes admin is a config-time
-- decision (this SQL), never a runtime one, so self-escalation stays
-- impossible.
--
-- Default: the app owner's account (ichsanalir@gmail.com), matching 0002.
-- If you sign up a different email on a local stack first, replace the
-- literal below with that email and re-run:  supabase db reset
-- ============================================================================

insert into public.omniflow_admins (user_id, created_by)
select u.id, u.id
from auth.users u
where lower(u.email) = 'ichsanalir@gmail.com'
on conflict (user_id) do nothing;
