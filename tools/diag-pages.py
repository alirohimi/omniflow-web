#!/usr/bin/env python3
"""Diagnose GitHub Pages availability for alirohimi/omniflow-web."""
import json
import re
import urllib.request
import urllib.error

with open("/opt/data/home/.git-credentials") as f:
    cred = f.readline().strip()
m = re.match(r"https://([^:]+):([^@]+)@github.com", cred)
token = m.group(2)
BASE = "https://api.github.com"
H = {"Authorization": f"token {token}", "Accept": "application/vnd.github+json"}


def req(path):
    r = urllib.request.Request(BASE + path, headers=H)
    try:
        resp = urllib.request.urlopen(r, timeout=20)
        return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}


st, repo = req("/repos/alirohimi/omniflow-web")
print("repo status:", st)
if st == 200:
    print("  name        :", repo.get("full_name"))
    print("  visibility  :", repo.get("visibility"))
    print("  has_pages   :", repo.get("has_pages"))
    print("  archived    :", repo.get("archived"))
    print("  owner type  :", repo.get("owner", {}).get("type"))
    print("  private     :", repo.get("private"))
else:
    print("  message:", repo.get("message"))

st2, owner = req("/user")
print("user status:", st2, "| login:", owner.get("login"), "| plan:", owner.get("plan", {}).get("name"))

st3, pages = req("/repos/alirohimi/omniflow-web/pages")
print("pages status:", st3, "|", (pages.get("url") if st3 == 200 else pages.get("message")))
