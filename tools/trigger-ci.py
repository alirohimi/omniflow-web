#!/usr/bin/env python3
"""Dispatch the Pages CI workflow and monitor until it completes."""
import json, re, time, urllib.request, urllib.error

with open("/opt/data/home/.git-credentials") as f:
    cred = f.readline().strip()
token = re.match(r"https://[^:]+:([^@]+)@", cred).group(1)
BASE = "https://api.github.com"
H = {"Authorization": f"token {token}", "Accept": "application/vnd.github+json", "Content-Type": "application/json"}

def req(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    r = urllib.request.Request(BASE + path, data=data, headers=H, method=method)
    try:
        resp = urllib.request.urlopen(r, timeout=30)
        raw = resp.read().decode()
        return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode() or "{}"
        return e.code, json.loads(raw)

# 1) Dispatch the CI workflow
st, out = req("POST", "/repos/alirohimi/omniflow-web/actions/workflows/pages.yml/dispatches", {"ref": "main"})
print("dispatch:", st, out.get("message", "ok"))

# 2) Poll for the run up to ~4 minutes
for i in range(24):
    time.sleep(10)
    st, runs = req("GET", "/repos/alirohimi/omniflow-web/actions/runs?branch=main&per_page=5")
    if st == 200 and runs.get("total_count"):
        latest = runs["workflow_runs"][0]
        line = f"[{(i+1)*10:>3}s] {latest.get('name')} #{latest.get('run_number')} {latest.get('status')}"
        print(line, flush=True)
        if latest.get("status") == "completed" and i >= 2:
            print(f"CONCLUSION: {latest.get('conclusion')}")
            print(f"LOGS: https://github.com/alirohimi/omniflow-web/actions/runs/{latest['id']}")
            break
        if latest.get("status") == "completed":
            print(f"CONCLUSION: {latest.get('conclusion')}")
            break

# 3) Final Pages state
time.sleep(5)
st, pages = req("GET", "/repos/alirohimi/omniflow-web/pages")
if st == 200:
    print(f"PAGES: status={pages.get('status')} html_url={pages.get('html_url')}")
