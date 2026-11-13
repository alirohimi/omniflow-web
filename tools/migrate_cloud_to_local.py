#!/usr/bin/env python3
"""
OmniFlow — migrate data from a hosted Supabase project to the local stack.

Uses the cloud service-role key (sb_secret_…) to read rows via the REST API,
and psycopg (localhost:54322) to write them into the local Postgres.

What gets migrated:
  * auth.users       (email + encrypted_password, so passwords still work;
                      user ids are PRESERVED, keeping every vault/policy
                      row referencing the same uuids)
  * omniflow_vaults  (encrypted vault blobs — ciphertext only, safe to copy)
  * omniflow_members / omniflow_admins / omniflow_llm_policy /
    omniflow_llm_default

Usage:
  python3 tools/migrate_cloud_to_local.py \
    --url https://<REF>.supabase.co \
    --key sb_secret_XXXX \
    [--local-dsn postgresql://postgres:postgres@127.0.0.1:54322/postgres]

Prerequisites:
  1. Local stack running:   npm run db:start
  2. Cloud DB password set: Supabase dashboard → Settings → Database
     (the key used here must be the service_role key; anon key cannot read
      auth.users encrypted_password or write to arbitrary rows)
  3. Cloud grants applied (one-time, in the SQL editor):
     GRANT SELECT, INSERT, UPDATE, DELETE ON
       public.omniflow_vaults, public.omniflow_members,
       public.omniflow_admins, public.omniflow_llm_policy,
       public.omniflow_llm_default
     TO service_role;
"""

import argparse
import json
import sys
import urllib.error
import urllib.request

# ---------------------------------------------------------------------------
# Cloud REST helpers
# ---------------------------------------------------------------------------

def cloud_get(base: str, key: str, path: str, timeout: int = 60):
    """GET from the cloud Supabase REST / auth admin API."""
    url = f"{base}{path}"
    req = urllib.request.Request(
        url,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode()
        return json.loads(raw) if raw.strip() else []


def cloud_users(base: str, key: str) -> list[dict]:
    """Fetch all auth.users rows via the admin API."""
    data = cloud_get(base, key, "/auth/v1/admin/users?limit=1000")
    return data.get("users", []) if isinstance(data, dict) else []


def cloud_table(base: str, key: str, table: str, limit: int = 1000) -> list:
    """Fetch all rows from a PostgREST table."""
    rows = cloud_get(base, key, f"/rest/v1/{table}?select=*&limit={limit}")
    if isinstance(rows, dict):
        print(f"  [warn] {table}: HTTP error: {rows.get('message', rows)}")
        return []
    return rows


# ---------------------------------------------------------------------------
# Local Postgres writer
# ---------------------------------------------------------------------------

def connect_local(dsn: str):
    import psycopg
    print(f"Connecting to LOCAL  ({dsn.split('@')[-1]}) ...")
    conn = psycopg.connect(dsn, autocommit=False)
    return conn


def upsert_auth_users(cur, users: list[dict]) -> int:
    """Upsert auth.users rows (parent table for all FKs).

    ON CONFLICT(id) DO UPDATE keeps existing rows updated with cloud values.
    """
    n = 0
    for u in users:
        uid = u.get("id")
        if not uid:
            continue
        email = u.get("email", "")
        enc = u.get("encrypted_password")
        confirmed_at = u.get("confirmed_at")
        raw_meta = u.get("raw_app_meta_data")
        raw_meta_s = json.dumps(raw_meta) if isinstance(raw_meta, (dict, list)) else raw_meta
        created_at = u.get("created_at")
        updated_at = u.get("updated_at")

        cur.execute(
            """
            insert into auth.users
              (id, email, encrypted_password, email_confirmed_at,
               raw_app_meta_data, aud, role, created_at, updated_at,
               instance_id)
            values (%s, %s, %s, %s, %s, 'authenticated', 'authenticated',
                    %s, %s, '00000000-0000-0000-0000-000000000000')
            on conflict (id) do update
              set email              = excluded.email,
                  encrypted_password = excluded.encrypted_password,
                  email_confirmed_at = excluded.email_confirmed_at,
                  updated_at         = excluded.updated_at
            """,
            (uid, email, enc, confirmed_at, raw_meta_s, created_at, updated_at),
        )
        n += 1
    return n


def upsert_identities(cur, users: list[dict]) -> int:
    """Create auth.identities rows (GoTrue requires one per user for login)."""
    n = 0
    for u in users:
        uid = u.get("id")
        if not uid:
            continue
        email = u.get("email", "")
        identity_data = json.dumps({
            "sub": uid,
            "email": email,
            "email_verified": True,
            "phone_verified": False,
        })
        cur.execute(
            """
            insert into auth.identities
              (id, provider_id, user_id, identity_data, provider,
               last_sign_in_at, created_at, updated_at)
            values (%s, %s, %s, %s::jsonb, 'email',
                    %s, %s, %s)
            on conflict (id) do nothing
            """,
            (uid, uid, uid, identity_data,
             u.get("email_confirmed_at"), u.get("created_at"), u.get("updated_at")),
        )
        n += 1
    return n


def fix_user_fields(cur) -> int:
    """GoTrue's Go struct can't scan NULL text fields — coalesce them."""
    cur.execute(
        """
        update auth.users
        set confirmation_token       = coalesce(confirmation_token, ''),
            recovery_token           = coalesce(recovery_token, ''),
            email_change_token_new   = coalesce(email_change_token_new, ''),
            email_change_token_current = coalesce(email_change_token_current, ''),
            phone_change_token       = coalesce(phone_change_token, ''),
            reauthentication_token   = coalesce(reauthentication_token, ''),
            email_change             = coalesce(email_change, ''),
            role                     = coalesce(role, 'authenticated'),
            raw_user_meta_data       = coalesce(raw_user_meta_data, '{}'::jsonb),
            instance_id              = coalesce(instance_id,
                             '00000000-0000-0000-0000-000000000000'::uuid)
        """
    )
    return cur.rowcount


def upsert_table(conn, table: str, rows: list[dict]) -> int:
    """Upsert rows into a local table, skipping conflicting keys silently."""
    if not rows:
        return 0
    cols = list(rows[0].keys())
    col_list = ", ".join(cols)
    ph = ", ".join(["%s"] * len(cols))
    sql = f"insert into public.{table} ({col_list}) values ({ph}) on conflict do nothing"
    n = 0
    with conn.cursor() as cur:
        for row in rows:
            vals = [row.get(c) for c in cols]
            vals = [json.dumps(v) if isinstance(v, (dict, list)) else v for v in vals]
            cur.execute(sql, vals)
            n += 1
    return n


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

APP_TABLES = [
    "omniflow_vaults",
    "omniflow_members",
    "omniflow_admins",
    "omniflow_llm_policy",
    "omniflow_llm_default",
]


def main() -> int:
    ap = argparse.ArgumentParser(description="Migrate cloud Supabase → local stack")
    ap.add_argument("--url", required=True,
                    help="Cloud project URL, e.g. https://abc123.supabase.co")
    ap.add_argument("--key", required=True,
                    help="Cloud service-role key (sb_secret_… or standard JWT)")
    ap.add_argument("--local-dsn",
                    default="postgresql://postgres:postgres@127.0.0.1:54322/postgres",
                    help="Local Postgres DSN (default: local stack on port 54322)")
    ap.add_argument("--limit", type=int, default=1000,
                    help="Rows to fetch per table (default 1000)")
    args = ap.parse_args()

    base = args.url.rstrip("/")

    # Verify reachability before connecting locally
    print(f"Connecting to CLOUD  ({base}) ...")
    try:
        cloud_get(base, args.key, "/auth/v1/health", timeout=15)
    except Exception as e:
        print(f"[error] Cloud not reachable: {e}")
        return 1

    conn = connect_local(args.local_dsn)

    # 1. auth.users (parent for all FKs)
    print("\n[1/4] auth.users ...")
    users = cloud_users(base, args.key)
    print(f"  fetched {len(users)} user(s) from cloud")
    with conn.cursor() as cur:
        n = upsert_auth_users(cur, users)
        conn.commit()
        print(f"  upserted {n} into local auth.users")

    # 2. auth.identities (GoTrue login requires these)
    print("\n[2/4] auth.identities ...")
    with conn.cursor() as cur:
        n = upsert_identities(cur, users)
        conn.commit()
        print(f"  ensured {n} identity row(s)")

    # 3. Fix NULL text fields that crash GoTrue's Go struct scanner
    print("\n[3/4] Fixing GoTrue NULL fields ...")
    with conn.cursor() as cur:
        n = fix_user_fields(cur)
        conn.commit()
        print(f"  patched {n} row(s)")

    # 4. App tables
    print("\n[4/4] App tables ...")
    for table in APP_TABLES:
        rows = cloud_table(base, args.key, table, limit=args.limit)
        print(f"  {table}: {len(rows)} row(s) from cloud")
        with conn.cursor() as cur:
            n = upsert_table(conn, table, rows)
            conn.commit()
            print(f"    upserted {n} into local")

    conn.close()
    print("\nDONE — sign in at http://localhost:5173 with your cloud email + password")
    return 0


if __name__ == "__main__":
    sys.exit(main())
