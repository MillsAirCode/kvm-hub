"""Bootstrap Guacamole: change admin password, create first SSH connection.

Idempotent — safe to re-run. Reads passwords from sibling files in kvm-hub/.
"""
from __future__ import annotations
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GUAC_BASE = "http://100.104.140.85:8080"
DATA_SOURCE = "postgresql"

ADMIN_PASS_FILE = ROOT / ".guac_admin_password"
SSH_KEY_FILE = Path("/home/remote/.ssh/bradBigDesktop")


def _post_form(url: str, data: dict, token: str | None = None) -> dict:
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    if token:
        req.add_header("Guacamole-Token", token)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def _request_json(url: str, method: str, payload: dict | None, token: str) -> dict | None:
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Guacamole-Token", token)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code} on {method} {url}")
        print(f"  body: {e.read().decode()[:300]}")
        raise


def login(username: str, password: str) -> str:
    print(f"-> login as {username}")
    resp = _post_form(f"{GUAC_BASE}/api/tokens", {"username": username, "password": password})
    return resp["authToken"]


def change_password(token: str, username: str, old: str, new: str) -> None:
    print(f"-> change password for {username}")
    url = f"{GUAC_BASE}/api/session/data/{DATA_SOURCE}/users/{username}/password"
    _request_json(url, "PUT", {"oldPassword": old, "newPassword": new}, token)


def list_connections(token: str) -> dict:
    url = f"{GUAC_BASE}/api/session/data/{DATA_SOURCE}/connections"
    return _request_json(url, "GET", None, token) or {}


def create_ssh_connection(token: str, name: str, hostname: str, username: str,
                          private_key: str, port: int = 22) -> str:
    print(f"-> create SSH connection: {name} ({username}@{hostname}:{port})")
    url = f"{GUAC_BASE}/api/session/data/{DATA_SOURCE}/connections"
    payload = {
        "name": name,
        "parentIdentifier": "ROOT",
        "protocol": "ssh",
        "parameters": {
            "hostname": hostname,
            "port": str(port),
            "username": username,
            "private-key": private_key,
            "color-scheme": "gray-black",
            "font-name": "DejaVu Sans Mono",
            "font-size": "12",
        },
        "attributes": {"max-connections": "10", "max-connections-per-user": "5"},
    }
    resp = _request_json(url, "POST", payload, token)
    return resp["identifier"]


def main():
    new_admin_pass = ADMIN_PASS_FILE.read_text().strip()
    if not new_admin_pass:
        print("ERROR: empty admin password file")
        sys.exit(1)
    if not SSH_KEY_FILE.is_file():
        print(f"ERROR: ssh key not found at {SSH_KEY_FILE}")
        sys.exit(1)
    private_key = SSH_KEY_FILE.read_text()

    # Try login with new password first (idempotent re-run)
    try:
        token = login("guacadmin", new_admin_pass)
        print("  already on new password")
    except urllib.error.HTTPError:
        # Fall back to default creds, then rotate
        token = login("guacadmin", "guacadmin")
        change_password(token, "guacadmin", "guacadmin", new_admin_pass)
        # Re-login with new password
        token = login("guacadmin", new_admin_pass)

    # Create or skip bradBigDesktop SSH connection
    existing = list_connections(token)
    target_name = "bradBigDesktop (SSH)"
    if any(c.get("name") == target_name for c in existing.values()):
        print(f"  connection {target_name!r} already exists — skipping create")
    else:
        ident = create_ssh_connection(
            token,
            name=target_name,
            hostname="100.106.249.30",  # bradBigDesktop on Tailscale
            username="brad",
            private_key=private_key,
        )
        print(f"  created connection id={ident}")

    print()
    print("=== ready ===")
    print(f"URL:      {GUAC_BASE}/")
    print(f"Username: guacadmin")
    print(f"Password: (in {ADMIN_PASS_FILE})")


if __name__ == "__main__":
    main()
