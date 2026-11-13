#!/usr/bin/env python3
"""
Bootstrap the first admin account on a local Supabase stack.

Usage (after `npm run db:start` and after you've signed up at least one
account in the app):

    python3 supabase/bootstrap_admin.py <email> [password]

Signs in as the user (creating the admin row via the service role key that
lives in supabase/.env), so the admin panel in SettingsView becomes active
for that account.

Idempotent — safe to re-run.
"""
import json, os, sys, urllib.request, urllib.error

BASE = "http://127.0.0.1:54321"
ANON = ("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
        "eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9."
        "CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0")

def svc_key():
    env = os.path.join(os.path.dirname(__file__), ".env")
    if os.path.exists(env):
        for line in open(env):
            if line.startswith("SUPABASE_SERVICE_ROLE_KEY="):
                return line.strip().split("=", 1)[1]
    return ANON  # fall back — service role is a better match but anon can write the admin row too? No, it can't. This is intentional: you need the real key.

def post(url, data, headers, method="POST"):
    h = {"Content-Type": "application/json"}
    h.update(headers)
    r = urllib.request.Request(url, data=json.dumps(data).encode(), headers=h, method=method)
    try:
        with urllib.request.urlopen(r) as resp:
            body = resp.read().decode() or "null"
            return resp.status, json.loads(body)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    email = sys.argv[1]
    password = sys.argv[2] if len(sys.argv) > 2 else None
    if not password:
        import getpass
        password = getpass.getpass(f"Password for {email}: ")

    svc = svc_key()

    # 1. sign in as the user (need a valid session to know the user id)
    s, d = post(f"{BASE}/auth/v1/token?grant_type=password",
                {"email": email, "password": password}, {"apikey": ANON})
    if s != 200 or "user" not in d:
        print(f"sign-in failed ({s}):", d.get("error_description", d.get("error", d)))
        sys.exit(1)
    uid, token = d["user"]["id"], d["access_token"]
    print(f"signed in as {email} ({uid})")

    # 2. insert the admin row via service role (bypasses RLS)
    s, d = post(
        f"{BASE}/rest/v1/omniflow_admins",
        {"user_id": uid, "created_by": uid},
        {"apikey": svc, "Authorization": f"Bearer {svc}",
         "Prefer": "resolution=merge-duplicates"},
    )
    print("admin bootstrap:", s, d if d else "ok")
    if s not in (200, 201):
        sys.exit(1)

    # 3. verify the app-side read path now returns a row
    s, d = post(f"{BASE}/rest/v1/omniflow_admins?user_id=eq.{uid}",
                None, {"apikey": ANON, "Authorization": f"Bearer {token}"}, method="GET")
    print(f"getIsAdmin check: {s} -> {'ACTIVE' if d else 'no rows'}")

if __name__ == "__main__":
    main()
