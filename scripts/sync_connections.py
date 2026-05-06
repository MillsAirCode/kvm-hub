"""Sync Guacamole connections from machines.yaml. Idempotent.

Reads machines.yaml, ensures each machine has a Guacamole
connection. Existing connections are not modified — delete them by hand if you
want to recreate.
"""
from __future__ import annotations
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
GUAC_BASE = os.environ.get("GUAC_BASE", "http://localhost:8080")
DATA_SOURCE = "postgresql"
ADMIN_PASS_FILE = ROOT / ".guac_admin_password"
MACHINES_FILE = ROOT / "machines.yaml"


def _post_form(url: str, data: dict) -> dict:
    req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode(), method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def _request_json(url: str, method: str, payload: dict | None, token: str) -> dict | None:
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Guacamole-Token", token)
    with urllib.request.urlopen(req, timeout=10) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def login(password: str) -> str:
    resp = _post_form(f"{GUAC_BASE}/api/tokens", {"username": "guacadmin", "password": password})
    return resp["authToken"]


def list_connections(token: str) -> dict:
    return _request_json(f"{GUAC_BASE}/api/session/data/{DATA_SOURCE}/connections", "GET", None, token) or {}


def create_ssh(token: str, name: str, hostname: str, username: str,
               key: str | None = None, password: str | None = None) -> str:
    if not key and not password:
        raise ValueError(f"create_ssh({name}): need key or password")
    parameters = {
        "hostname": hostname,
        "port": "22",
        "username": username,
        "color-scheme": "gray-black",
        "font-name": "DejaVu Sans Mono",
        "font-size": "12",
    }
    if key:
        parameters["private-key"] = key
    if password:
        parameters["password"] = password
    payload = {
        "name": name,
        "parentIdentifier": "ROOT",
        "protocol": "ssh",
        "parameters": parameters,
        "attributes": {"max-connections": "10", "max-connections-per-user": "5"},
    }
    resp = _request_json(f"{GUAC_BASE}/api/session/data/{DATA_SOURCE}/connections", "POST", payload, token)
    return resp["identifier"]


def main():
    cfg = yaml.safe_load(MACHINES_FILE.read_text())
    machines = cfg["machines"]
    admin_pass = ADMIN_PASS_FILE.read_text().strip()
    token = login(admin_pass)

    existing = list_connections(token)
    existing_names = {c["name"] for c in existing.values()}
    print(f"Existing connections: {sorted(existing_names)}")

    created = 0
    for m in machines:
        if m["name"] in existing_names:
            print(f"  skip (exists): {m['name']}")
            continue
        proto = m.get("protocol", "ssh")
        if proto == "ssh":
            key_text = None
            password = m.get("password")
            if m.get("key_file"):
                key_path = Path(m["key_file"])
                if not key_path.is_file():
                    print(f"  SKIP (no key): {m['name']} — {key_path}")
                    continue
                key_text = key_path.read_text()
            elif not password:
                print(f"  SKIP (no auth): {m['name']} — set key_file or password")
                continue
            ident = create_ssh(token, m["name"], m["hostname"], m["username"],
                               key=key_text, password=password)
            auth_note = "key+password" if key_text and password else ("key" if key_text else "password")
            print(f"  CREATED ssh ({auth_note}): {m['name']} → id={ident}")
            created += 1
        else:
            print(f"  SKIP (proto {proto} not implemented yet): {m['name']}")

    print(f"\nDone. {created} created.")


if __name__ == "__main__":
    main()
