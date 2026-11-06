#!/usr/bin/env python3
"""Enable GitHub Pages (workflow build) for alirohimi/omniflow-web."""
import json
import re
import subprocess
import urllib.request

with open("/opt/data/home/.git-credentials") as f:
    cred = f.readline().strip()
m = re.match(r"https://([^:]+):([^@]+)@github.com", cred)
if not m:
    raise SystemExit("no token in git-credentials")
user, token = m.group(1), m.group(2)

BASE = "https://api.github.com"
H = {
    "Authorization": f"token {token}",
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json",
}


def req(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    r = urllib.request.Request(BASE + path, data=data, headers=H, method=method)
    try:
        resp = urllib.request.urlopen(r)
        return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


# 1. current config
st, body = req("GET", "/repos/alirohimi/omniflow-web/pages")
print("GET pages:", st, body[:300])

# 2. configure as a workflow-build site
st, body = req(
    "POST",
    "/repos/alirohimi/omniflow-web/pages",
    {"build_type": "workflow", "source": {"branch": "main", "path": "/"}},
)
print("POST pages:", st, body[:400])

# 3. re-read to get the published url
st, body = req("GET", "/repos/alirohimi/omniflow-web/pages")
cfg = json.loads(body)
print("url:", cfg.get("url"), "| status:", cfg.get("status"))
