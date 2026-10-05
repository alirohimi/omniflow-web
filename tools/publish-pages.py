#!/usr/bin/env python3
"""Publish repo -> enable Pages -> report the live URL."""
import json
import re
import time
import urllib.request
import urllib.error

with open("/opt/data/home/.git-credentials") as f:
    cred = f.readline().strip()
token = re.match(r"https://([^:]+):([^@]+)@github.com", cred).group(2)
BASE = "https://api.github.com"
REPO = "/repos/alirohimi/omniflow-web"
H = {
    "Authorization": f"token {token}",
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json",
}


def req(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    r = urllib.request.Request(BASE + path, data=data, headers=H, method=method)
    try:
        resp = urllib.request.urlopen(r, timeout=30)
        return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


# 1) Make the repo public (reversible; free plan needs this for Pages).
st, body = req("PATCH", REPO, {"private": False})
print("PATCH visibility:", st, body[:200])
if st not in (200,):
    raise SystemExit("could not make repo public")

# 2) Enable Pages via the CI workflow (build_type=workflow).
st, body = req(
    "POST",
    REPO + "/pages",
    {"build_type": "workflow", "source": {"branch": "main", "path": "/"}},
)
print("POST pages:", st, body[:300])

# 3) Read back the configured URL + status.
time.sleep(2)
st, body = req("GET", REPO + "/pages")
if st == 200:
    cfg = json.loads(body)
    print("PAGES_URL:", cfg.get("url"))
    print("PAGES_STATUS:", cfg.get("status"))
else:
    print("pages read:", st, body[:300])
