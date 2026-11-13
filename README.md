# OmniFlow Web

Zero-cost personal-finance PWA: expense capture (manual / OCR / PDF statements),
budgets, cashflow forecast, investments, and an AI coach. Data is stored in an
AES-256-GCM encrypted vault scoped to the user — no plaintext ever reaches the
backend.

## Backend: local-first, cloud-configurable

The app talks to any **Supabase-compatible stack** (hosted Supabase,
`supabase start`, or a standalone Postgres + GoTrue + PostgREST). Everything is
switched by environment variables — no code changes:

| Variable | Purpose | Local default | Cloud |
|---|---|---|---|
| `VITE_SUPABASE_URL` | API base (auth + REST) | `http://127.0.0.1:54321` | your `https://xyz.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | public anon JWT | local `.env`-generated key | your project's anon key |
| `VITE_SUPABASE_REST_URL` | optional REST-only override | _(unset — same origin)_ | _(unset)_ |

Values are read from `.env.local` (gitignored). `supabase/local.env` is the
committed template for the local stack.

## Migrate data from your cloud project → local

Move accounts + encrypted vaults + admin/LLM rows from a hosted Supabase
project into the local stack. Copies `auth.users` (so passwords keep working),
`omniflow_vaults`, `omniflow_members`, `omniflow_admins`, `omniflow_llm_policy`,
`omniflow_llm_default`. Ciphertext only — no plaintext financial data moves.

```bash
npm run db:start                                        # local stack up
pip3 install "psycopg[binary]"                           # one-time dep
python3 tools/migrate_cloud_to_local.py --dry-run \
  "postgresql://postgres.<REF>:<DBPW>@db.<REF>.supabase.co:5432/postgres"
python3 tools/migrate_cloud_to_local.py \
  "postgresql://postgres.<REF>:<DBPW>@db.<REF>.supabase.co:5432/postgres"
```

`<REF>` is in your cloud project URL (`https://<REF>.supabase.co`); `<DBPW>` is
from project Settings → Database. User UUIDs are preserved, so every vault row
still resolves to the same person. Sign in locally with your cloud email +
password and your data is there.

## Quick start (local)

Prereqs: Docker runtime (Docker Desktop or colima) + Supabase CLI
(`brew install supabase colima docker docker-compose docker-buildx`).

```bash
npm install
colima start          # start the Docker VM (one-time)
npm run db:start      # = supabase start: applies all migrations, boots the stack
npm run dev           # Vite on :5173, talking to 127.0.0.1:54321
```

First run opens `http://localhost:5173` — sign up any email (confirmations are
disabled locally), sign in, and data persists across reloads in local Postgres.

Useful:

```bash
npm run db:stop       # tear the stack down (data survives in docker volumes)
npm run db:reset      # stop + start; re-applies migrations
```

## Migration to cloud

1. Create a hosted Supabase project.
2. Point `.env.local` at it:

   ```
   VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
   VITE_SUPABASE_ANON_KEY=<anon key from project settings>
   ```

3. Run `supabase/migrations/0001`–`0004` in the project's SQL editor
   (or `supabase db push` from the CLI if you link the project).
4. Set the same two values as CI secrets in
   `.github/workflows/pages.yml` (GitHub → Settings → Secrets) — the Pages
   deploy then builds with cloud backend baked in; local stays local.

Optional knobs (usually leave unset):

- `VITE_SUPABASE_REST_URL` — when auth and PostgREST live on different
  origins.
- `VITE_OWNIFLOW_TABLES` — JSON override of table names
  (`{"vaults":"x_vaults",...}`).

## Admin panel

0002's admin policy only lets an *existing* admin create admins, and the
registry starts empty — so the very first admin must be bootstrapped
out-of-band (self-promotion is RLS-blocked by design).

On a fresh local stack:

1. Sign up any account in the app (confirmations are off locally, so you're
   in immediately).
2. Insert the admin row via the service role, which bypasses RLS:

   ```bash
   SERVICE_KEY=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' supabase/.env | cut -d= -f2-)
   # user_id = that account's auth.users.id:
   docker exec -i supabase-db_<pid> psql -U postgres \
     -c "insert into omniflow_admins (user_id, created_by) select u.id, u.id from auth.users u where lower(u.email) = 'you@x.com' on conflict (user_id) do nothing;"
   ```

   or use the helper: `supabase/functions/admin-bootstrap/index.ts`
   (service-role-gated; see its header for the curl).

Migration 0005 bootstraps `ichsanalir@gmail.com` as the default owner —
edit it and `npm run db:reset` if your local owner email differs.

## Tests

`npm test`. Note: the suite's 21 failing tests are **pre-existing at HEAD**
(localStorage-gated store tests under vitest); they fail identically with or
without these changes — verify against a clean checkout if in doubt.

## Layout

```
src/services/supabase.ts   backend client + env config (the single switch)
src/services/cloudVault.ts encrypted vault row persistence + keepalive flush
src/services/admin.ts      admin / member directory / LLM-policy rows
supabase/config.toml       local stack config (CORS, auth, ports)
supabase/migrations/       0001–0005, applied automatically on start
```
