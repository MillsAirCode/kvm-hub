"""KVM Hub backend.

Serves the React dashboard from ../dashboard/dist + a small JSON API for
machine list, live status pings, and Wake-on-LAN. Bound to the Tailscale
interface only.
"""
from __future__ import annotations
import asyncio
import base64
import json
import os
import re
import secrets
import time
from pathlib import Path
from typing import Literal

import yaml
from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from wakeonlan import send_magic_packet

ROOT = Path(__file__).resolve().parents[1]
MACHINES_FILE = ROOT / "machines.yaml"
AGENTS_FILE = ROOT / "agents.yaml"
SERVICES_FILE = ROOT / "services.yaml"
SCRATCHPAD_FILE = ROOT / "scratchpad.md"
DASHBOARD_DIST = ROOT / "dashboard" / "dist"
API_KEY_FILE = ROOT / ".api_key"


def _load_or_create_api_key() -> str:
    key = os.environ.get("KVMHUB_API_KEY", "").strip()
    if key:
        return key
    if API_KEY_FILE.exists():
        return API_KEY_FILE.read_text().strip()
    key = secrets.token_urlsafe(32)
    API_KEY_FILE.write_text(key)
    try:
        API_KEY_FILE.chmod(0o600)
    except Exception:
        pass
    print(f"[kvm-hub] generated new API key (also stored at {API_KEY_FILE}):")
    print(f"  KVMHUB_API_KEY={key}")
    return key


_API_KEY = _load_or_create_api_key()


def _extract_request_key(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    xkey = request.headers.get("x-api-key", "").strip()
    if xkey:
        return xkey
    # WebSocket fallback: ?api_key=... query param (browsers can't set headers on raw WS)
    qkey = request.query_params.get("api_key", "").strip()
    return qkey


app = FastAPI(title="KVM Hub", version="0.1.0")


# Structured access logger — emits one JSON line per request to a dedicated
# logger, more useful for metrics + alerting than uvicorn's default access log.
# Registered AFTER api_key_middleware so it runs FIRST in the request path
# (middleware stack is LIFO: last-registered = outermost = runs first).
import logging
import json as _json_for_log

_access_logger = logging.getLogger("kvm-hub.access")


@app.middleware("http")
async def api_key_middleware(request: Request, call_next):
    path = request.url.path
    if path == "/api/health":
        return await call_next(request)
    if path.startswith("/api/") or path.startswith("/ws/"):
        provided = _extract_request_key(request)
        if not provided or not secrets.compare_digest(provided, _API_KEY):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


@app.middleware("http")
async def access_log_middleware(request: Request, call_next):
    """One JSON line per request to the kvm-hub.access logger. Captures
    every request including 401-rejected ones because middleware stack is
    LIFO (this is registered after api_key_middleware → runs outer)."""
    start = time.perf_counter()
    try:
        response = await call_next(request)
        status_code = response.status_code
    except Exception:
        status_code = 500
        raise
    finally:
        try:
            _access_logger.info(_json_for_log.dumps({
                "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "method": request.method,
                "path": str(request.url.path),
                "status": status_code,
                "ms": round((time.perf_counter() - start) * 1000, 2),
                "ip": request.client.host if request.client else "?",
            }))
        except Exception:
            pass
    return response


class Machine(BaseModel):
    id: str
    name: str
    role: str
    protocol: str
    hostname: str
    lan_ip: str
    mac: str
    icon: str


class StatusEntry(BaseModel):
    id: str
    status: Literal["online", "offline"]
    latency_ms: float | None = None


class _YamlCache:
    """TTL + mtime cached YAML reader. Re-parses only when the file is touched
    on disk OR after `ttl` seconds elapse. Drops list_machines/list_agents
    parse cost from ~2-5ms to ~0.01ms after warmup, which adds up since several
    polled endpoints hit these on every tick."""
    def __init__(self, path: Path, ttl: float = 60.0):
        self.path = path
        self.ttl = ttl
        self._data: dict | None = None
        self._mtime = 0.0
        self._load_time = 0.0

    def get(self) -> dict:
        now = time.time()
        if now - self._load_time >= self.ttl:
            self._refresh()
            return self._data or {}
        try:
            m = self.path.stat().st_mtime
        except FileNotFoundError:
            return self._data or {}
        if m > self._mtime:
            self._refresh()
        return self._data or {}

    def _refresh(self) -> None:
        if not self.path.exists():
            self._data = {}
            return
        self._data = yaml.safe_load(self.path.read_text()) or {}
        try:
            self._mtime = self.path.stat().st_mtime
        except FileNotFoundError:
            self._mtime = 0.0
        self._load_time = time.time()


_machines_yaml = _YamlCache(MACHINES_FILE)
_agents_yaml = _YamlCache(AGENTS_FILE)
_services_yaml = _YamlCache(SERVICES_FILE)


def load_machines() -> list[dict]:
    return _machines_yaml.get().get("machines", []) or []


def find_machine(mid: str) -> dict:
    for m in load_machines():
        if m["id"] == mid:
            return m
    raise HTTPException(404, f"unknown machine: {mid}")


async def _probe_http(url: str, method: str = "GET", timeout: float = 2.0) -> dict:
    """Helper for /api/health — bounded HTTP probe with timing."""
    import httpx
    start = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.request(method, url)
            resp.raise_for_status()
            return {"ok": True, "ms": round((time.perf_counter() - start) * 1000)}
    except Exception:
        return {"ok": False, "ms": round((time.perf_counter() - start) * 1000)}


def _probe_sqlite(path: Path) -> dict:
    """Helper for /api/health — sync SQLite reachability probe (microseconds)."""
    start = time.perf_counter()
    try:
        conn = sqlite3.connect(path)
        try:
            conn.execute("SELECT 1").fetchone()
        finally:
            conn.close()
        return {"ok": True, "ms": round((time.perf_counter() - start) * 1000)}
    except Exception:
        return {"ok": False, "ms": round((time.perf_counter() - start) * 1000)}


@app.get("/api/health")
async def health() -> dict:
    """Aggregated health probe of upstream deps. Probes run concurrently
    via asyncio.gather so total latency is bounded by the slowest dep
    (≤2s timeout each). Returns per-dep status; top-level `ok` is true
    only if every dep returns true."""
    honcho_url = f"{HONCHO_BASE}/v3/workspaces/{HONCHO_WORKSPACE}/peers/list"
    sqlite_probe = _probe_sqlite(TASKS_DB_FILE)
    # Probe each agent's llama-server dynamically from agents.yaml
    agents = _agents_yaml.get().get("agents", []) or []
    llama_probes = {}
    probe_tasks = [_probe_http(honcho_url, "POST")]
    probe_keys = ["honcho"]
    for ag in agents:
        url = ag.get("llama_url", "")
        if url:
            probe_tasks.append(_probe_http(f"{url}/v1/models"))
            probe_keys.append(f"llama_{ag['id']}")
    results = await asyncio.gather(*probe_tasks)
    deps = dict(zip(probe_keys, results))
    deps["sqlite_tasks"] = sqlite_probe
    return {"ok": all(d["ok"] for d in deps.values()), "deps": deps}


@app.get("/api/machines", response_model=list[Machine])
def list_machines() -> list[dict]:
    out = []
    for m in load_machines():
        out.append({
            "id": m["id"],
            "name": m["name"],
            "role": m.get("role", ""),
            "protocol": m.get("protocol", "ssh"),
            "hostname": m["hostname"],
            "lan_ip": m["lan_ip"],
            "mac": m.get("mac", ""),
            "icon": m.get("icon", "minipc"),
        })
    return out


async def _ping_one(host: str, timeout_s: float = 2.0) -> tuple[bool, float | None]:
    """Run `ping -c1 -W<n> <host>`; return (alive, latency_ms or None)."""
    proc = await asyncio.create_subprocess_exec(
        "ping", "-c", "1", "-W", str(int(timeout_s)), host,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    stdout, _ = await proc.communicate()
    if proc.returncode != 0:
        return False, None
    # Parse `time=12.3 ms` if present.
    import re
    m = re.search(r"time=([\d.]+)\s*ms", stdout.decode())
    return True, float(m.group(1)) if m else None


@app.get("/api/status", response_model=list[StatusEntry])
async def status() -> list[dict]:
    """Concurrently ping every machine and return up/down + latency."""
    machines = load_machines()
    results = await asyncio.gather(*(_ping_one(m["lan_ip"]) for m in machines))
    return [
        {"id": m["id"], "status": "online" if alive else "offline", "latency_ms": lat}
        for m, (alive, lat) in zip(machines, results)
    ]


@app.get("/api/summary")
async def summary() -> dict:
    """Combined counts for the dashboard's header pills — saves 3 round-trips
    per poll cycle. Tasks-in-flight is read from SQLite directly to avoid the
    full /api/tasks payload."""
    machines = load_machines()
    agents_list = load_agents()

    # Fleet ping
    ping_results = await asyncio.gather(*(_ping_one(m["lan_ip"]) for m in machines))
    online = sum(1 for alive, _ in ping_results if alive)

    # Tasks in-flight from SQLite (TASKS_DB_FILE is defined later in the
    # module; runtime resolution is fine because routes only execute on
    # request after import completes).
    in_flight = 0
    try:
        import sqlite3 as _sqlite3
        with _sqlite3.connect(TASKS_DB_FILE) as conn:
            cur = conn.execute(
                "SELECT COUNT(*) FROM tasks WHERE status = 'in_progress'"
            )
            row = cur.fetchone()
            if row:
                in_flight = int(row[0])
    except Exception:
        pass

    return {
        "fleet": {"total": len(machines), "online": online},
        "agents": len(agents_list),
        "tasks_in_flight": in_flight,
    }


class WakeResult(BaseModel):
    ok: bool
    sent_to: str
    message: str


@app.post("/api/wake/{machine_id}", response_model=WakeResult)
def wake(machine_id: str) -> dict:
    m = find_machine(machine_id)
    mac = m.get("mac", "").strip()
    if not mac:
        raise HTTPException(400, f"no MAC address recorded for {machine_id}")
    # Broadcast magic packet on the LAN.
    send_magic_packet(mac)
    return {"ok": True, "sent_to": mac, "message": f"WoL packet sent to {m['name']} ({mac})"}


# ── Agents API ───────────────────────────────────────────────────────────


class Agent(BaseModel):
    id: str
    name: str
    short: str
    role: str
    host: str
    model: str
    icon: str
    has_log: bool
    has_chat: bool
    can_send: bool
    push_only: bool = False
    chat_format: str = "hermes"
    telegram_bot_username: str | None = None


class AgentStatus(BaseModel):
    id: str
    state: Literal["idle", "thinking", "responding", "unknown"]
    last_event_at: float | None
    last_event_text: str | None


def load_agents() -> list[dict]:
    return _agents_yaml.get().get("agents", []) or []


def find_agent(aid: str) -> dict:
    for a in load_agents():
        if a["id"] == aid:
            return a
    raise HTTPException(404, f"unknown agent: {aid}")


_BOT_USERNAME_CACHE: dict[str, str] = {}


async def _get_bot_username(agent: dict) -> str | None:
    cache_key = agent["id"]
    if cache_key in _BOT_USERNAME_CACHE:
        return _BOT_USERNAME_CACHE[cache_key]
    tok = await _get_bot_token(agent)
    if not tok:
        return None
    import httpx
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            r = await client.get(f"https://api.telegram.org/bot{tok}/getMe")
        if r.status_code != 200:
            return None
        d = r.json()
        if not d.get("ok"):
            return None
        username = (d.get("result") or {}).get("username")
        if username:
            _BOT_USERNAME_CACHE[cache_key] = username
        return username
    except Exception:
        return None


@app.get("/api/agents", response_model=list[Agent])
async def list_agents() -> list[dict]:
    agents = load_agents()
    # Resolve bot usernames in parallel
    usernames = await asyncio.gather(*(_get_bot_username(a) for a in agents))
    return [
        {
            "id": a["id"],
            "name": a["name"],
            "short": a.get("short", ""),
            "role": a.get("role", ""),
            "host": a.get("host", ""),
            "model": a.get("model", ""),
            "icon": a.get("icon", "brain"),
            "has_log": bool(a.get("log_path") or a.get("log_path_glob")),
            "has_chat": bool(a.get("sessions_glob")),
            "can_send": bool(a.get("api_server_url")) or bool(a.get("push_only")),
            "push_only": bool(a.get("push_only")),
            "chat_format": a.get("chat_format", "hermes"),
            "telegram_bot_username": usernames[i],
        }
        for i, a in enumerate(agents)
    ]


# ── Send message to agent ────────────────────────────────────────────────


_HERMES_API_KEY_FILE = ROOT / ".hermes_api_key"


def _hermes_api_key() -> str | None:
    if not _HERMES_API_KEY_FILE.is_file():
        return None
    return _HERMES_API_KEY_FILE.read_text().strip() or None


class SendMessageBody(BaseModel):
    message: str
    # Optional: agent_id of the originator (e.g. "claude_natalie") so the
    # workflow viz can render agent→agent flow instead of user→agent.
    source: str | None = None


class SendMessageResult(BaseModel):
    ok: bool
    reply: str | None = None
    error: str | None = None


async def _resolve_telegram_session_id(agent: dict) -> str | None:
    """Find the most-recent Hermes session that came from Telegram, so
    dashboard messages thread into the same conversation. Hermes' api_server
    keys its SessionDB by the .jsonl basename, so passing it as
    X-Hermes-Session-Id lets the agent load the full Telegram history.

    Strategy: list .jsonl files newest-first, peek the first line of each
    until we find one with platform=telegram on the session_meta entry.
    """
    glob_pat = agent.get("sessions_glob")
    if not glob_pat:
        return None
    is_local = agent.get("host", "localhost") == "localhost"
    # Inline shell snippet: list newest 12 sessions; for each, head -1 and
    # print "<path>\t<first_line>" so we can scan in one round-trip.
    sh_cmd = (
        f"for f in $(ls -t {glob_pat} 2>/dev/null | head -12); do "
        f"  printf '%s\\t' \"$f\"; head -n 1 \"$f\" 2>/dev/null; "
        f"done"
    )
    if is_local:
        cmd = ["sh", "-c", sh_cmd]
    else:
        cmd = [
            "ssh", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5",
            "-i", agent["key_file"], f"{agent['user']}@{agent['host']}",
            sh_cmd,
        ]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    stdout, _ = await proc.communicate()
    out = stdout.decode(errors="replace")
    fallback: str | None = None
    for raw in out.splitlines():
        if "\t" not in raw:
            continue
        path, first_line = raw.split("\t", 1)
        path = path.strip()
        first_line = first_line.strip()
        if not path:
            continue
        base = path.rsplit("/", 1)[-1]
        if base.endswith(".jsonl"):
            base = base[: -len(".jsonl")]
        if fallback is None:
            fallback = base
        try:
            obj = json.loads(first_line)
        except Exception:
            continue
        if obj.get("platform") == "telegram":
            return base
    # No Telegram session found — fall back to the most recent .jsonl
    return fallback


# Back-compat alias (older callers / tests)
_resolve_latest_session_id = _resolve_telegram_session_id


# ── Workflow event broadcast (drives WorkflowGraph particles) ──────────

# Per-connection asyncio queues. Backend emits events here when sends fire,
# regardless of whether they came from the frontend Broadcast composer or
# an external curl. Frontend subscribes via /api/workflow/events SSE.
_WORKFLOW_SUBSCRIBERS: set[asyncio.Queue] = set()


async def _publish_workflow_event(event: dict) -> None:
    # Persist for the replay scrubber + activity heatmap. 14-day retention
    # is plenty for both (replay = last 2h, heatmap = 7d). Trim every ~100
    # inserts so we don't run a delete on every single event.
    try:
        ts = time.time()
        with sqlite3.connect(TASKS_DB_FILE) as conn:
            cur = conn.execute(
                "INSERT INTO workflow_events (ts, type, payload) VALUES (?, ?, ?)",
                (ts, event.get("type", "?"), json.dumps(event)),
            )
            if cur.lastrowid and cur.lastrowid % 100 == 0:
                conn.execute(
                    "DELETE FROM workflow_events WHERE ts < ?",
                    (ts - 14 * 86400,),
                )
    except Exception:
        pass
    dead: list[asyncio.Queue] = []
    for q in list(_WORKFLOW_SUBSCRIBERS):
        try:
            q.put_nowait(event)
        except Exception:
            dead.append(q)
    for q in dead:
        _WORKFLOW_SUBSCRIBERS.discard(q)


@app.post("/api/workflow/emit")
async def workflow_emit(event: dict) -> dict:
    """Public emit endpoint — lets external tooling (e.g. the offload
    dispatch script that hits llama-server directly, bypassing Hermes)
    inject workflow events so the dashboard's WorkflowGraph + Notifications
    animate in sync with offloaded work.

    Auth piggy-backs on the global API key middleware that gates all /api/*
    requests, so callers must already be carrying x-api-key (or Bearer, or
    ?api_key=). No additional auth needed here.

    Event shape mirrors the internal _publish_workflow_event payloads:
        {"type": "user_to_agent", "agentId": "clue", "text": "...", "ts": <pf>}
        {"type": "agent_to_user", "agentId": "clue", "text": "...", "ts": <pf>}
        {"type": "agent_to_agent", "fromId": "x", "toId": "y", "text": "...", "ts": <pf>}
        {"type": "agent_tool", "agentId": "clue", "tool": "Read", "ts": <pf>}
    `ts` is optional — server fills in time.time() if missing.
    """
    if not isinstance(event, dict) or "type" not in event:
        raise HTTPException(400, "event must be an object with a `type` field")
    event.setdefault("ts", time.time())
    await _publish_workflow_event(event)
    return {"ok": True}


@app.get("/api/workflow/history")
def workflow_history(minutes: int = 60) -> list[dict]:
    """Return persisted workflow events from the last `minutes` for replay."""
    since = time.time() - max(1, minutes) * 60
    out = []
    with sqlite3.connect(TASKS_DB_FILE) as conn:
        for row in conn.execute(
            "SELECT ts, type, payload FROM workflow_events WHERE ts >= ? ORDER BY ts ASC",
            (since,),
        ):
            try:
                ev = json.loads(row[2])
            except Exception:
                continue
            ev["_ts"] = row[0]
            out.append(ev)
    return out


@app.get("/api/workflow/heatmap")
def workflow_heatmap(days: int = 7) -> dict:
    """7-day × 24-hour activity grid keyed to the user's local timezone.
    `days` clamped to [1, 14]. Returns ordered rows (oldest day first) and
    raw event-type breakdown for tooltips."""
    import datetime as _dt
    now = _dt.datetime.now()
    days = max(1, min(14, days))
    # Anchor on local midnight today
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    start = today - _dt.timedelta(days=days - 1)
    since_ts = start.timestamp()
    # Build empty grid first
    rows = []
    for i in range(days):
        d = start + _dt.timedelta(days=i)
        rows.append({
            "date": d.strftime("%Y-%m-%d"),
            "label": d.strftime("%a %m/%d"),
            "hours": [{"count": 0, "types": {}} for _ in range(24)],
        })
    total = 0
    with sqlite3.connect(TASKS_DB_FILE) as conn:
        for ts_, type_ in conn.execute(
            "SELECT ts, type FROM workflow_events WHERE ts >= ? ORDER BY ts ASC",
            (since_ts,),
        ):
            t = _dt.datetime.fromtimestamp(ts_)
            di = (t.date() - start.date()).days
            if 0 <= di < days:
                hr = t.hour
                cell = rows[di]["hours"][hr]
                cell["count"] += 1
                cell["types"][type_] = cell["types"].get(type_, 0) + 1
                total += 1
    # Per-row max for normalization
    grid_max = max(
        (cell["count"] for row in rows for cell in row["hours"]),
        default=0,
    )
    return {
        "days": days,
        "total_events": total,
        "grid_max": grid_max,
        "rows": rows,
    }


async def _publish_send_kickoff(agent_id: str, source: str | None) -> None:
    """Emit the right particle for who initiated the send."""
    if source and source != "user":
        await _publish_workflow_event({
            "type": "agent_to_agent",
            "fromId": source,
            "toId": agent_id,
        })
    else:
        await _publish_workflow_event({"type": "user_to_agent", "agentId": agent_id})


async def _publish_send_reply(agent_id: str, source: str | None) -> None:
    if source and source != "user":
        await _publish_workflow_event({
            "type": "agent_to_agent",
            "fromId": agent_id,
            "toId": source,
        })
    else:
        await _publish_workflow_event({"type": "agent_to_user", "agentId": agent_id})


@app.get("/api/workflow/events")
async def workflow_events():
    queue: asyncio.Queue = asyncio.Queue(maxsize=200)
    _WORKFLOW_SUBSCRIBERS.add(queue)

    async def gen():
        try:
            yield "data: {\"type\": \"hello\"}\n\n"
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=20.0)
                    yield f"data: {json.dumps(event)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            _WORKFLOW_SUBSCRIBERS.discard(queue)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ── Telegram bot relay (mirror dashboard ↔ phone) ────────────────────────

# In-memory bot token cache. Tokens live in a remote .env on the agent's
# host (Hermes) or a local .env (Claude). Read once per process.
_BOT_TOKEN_CACHE: dict[str, str] = {}


async def _get_bot_token(agent: dict) -> str | None:
    cache_key = agent["id"]
    if cache_key in _BOT_TOKEN_CACHE:
        return _BOT_TOKEN_CACHE[cache_key]

    local_path = agent.get("telegram_bot_token_env_local")
    remote_path = agent.get("telegram_bot_token_env")
    if local_path:
        try:
            text = open(local_path, "r").read()
        except Exception:
            return None
    elif remote_path:
        cmd = [
            "ssh", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5",
            "-i", agent["key_file"], f"{agent['user']}@{agent['host']}",
            f"grep -E '^TELEGRAM_BOT_TOKEN=' {remote_path}",
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await proc.communicate()
        text = stdout.decode(errors="replace")
    else:
        return None

    for line in text.splitlines():
        line = line.strip()
        if line.startswith("TELEGRAM_BOT_TOKEN="):
            tok = line[len("TELEGRAM_BOT_TOKEN="):].strip().strip("'").strip('"')
            if tok:
                _BOT_TOKEN_CACHE[cache_key] = tok
                return tok
    return None


async def _telegram_send(token: str, chat_id: str, text: str) -> None:
    """Fire-and-forget bot.sendMessage. Truncates at 4000 chars (Telegram's
    cap is 4096; leave headroom for prefixing). Errors are logged & swallowed."""
    if not text:
        return
    if len(text) > 4000:
        text = text[:3997] + "..."
    import httpx
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(url, json={"chat_id": chat_id, "text": text})
            if r.status_code >= 400:
                # Don't break the dashboard reply path on Telegram failures.
                pass
    except Exception:
        pass


async def _relay_to_telegram(agent: dict, user_msg: str, reply: str | None) -> None:
    """Mirror a dashboard exchange into the agent's Telegram chat. Sends
    two messages: the user's prompt prefixed [via web], then the reply."""
    chat_id = agent.get("telegram_chat_id")
    if not chat_id:
        return
    token = await _get_bot_token(agent)
    if not token:
        return
    await _telegram_send(token, chat_id, f"📲 [via web]\n{user_msg}")
    if reply:
        await _telegram_send(token, chat_id, reply)


@app.post("/api/agents/{agent_id}/restart")
async def restart_agent(agent_id: str) -> dict:
    """SSH to the agent's host and restart its Hermes gateway + llama-server
    user units. Returns ok + per-unit stdout/stderr. Bounded 60s timeout.

    Agents may set a `restart:` block in agents.yaml to override the default
    target (Sarah uses this — her llama-server lives on Junior while the
    shared gateway on bradBigDesktop must not be touched, since it would
    kick Clue too)."""
    agent = find_agent(agent_id)
    override = agent.get("restart") or {}
    host = override.get("ssh_host") or agent.get("host", "localhost")
    user = override.get("ssh_user") or agent.get("user", "remote")
    key_file = override.get("key_file") or agent.get("key_file")

    if host == "localhost" or host == "127.0.0.1":
        # Restart of the local orchestrator host — refuse, we'd be killing
        # ourselves. The orchestrator is supposed to be the canary.
        raise HTTPException(400, "cannot restart the orchestrator host from itself")

    cmd = override.get("cmd") or (
        "systemctl --user restart hermes-gateway.service llama-server.service"
        " && systemctl --user is-active hermes-gateway.service llama-server.service"
    )
    ssh_args = [
        "ssh", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5",
    ]
    if key_file:
        ssh_args += ["-i", key_file]
    ssh_args += [f"{user}@{host}", cmd]

    proc = await asyncio.create_subprocess_exec(
        *ssh_args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60.0)
    except asyncio.TimeoutError:
        try: proc.kill()
        except Exception: pass
        return {"ok": False, "error": "ssh restart timed out after 60s", "agent_id": agent_id}

    out = stdout.decode("utf-8", "replace").strip()
    err = stderr.decode("utf-8", "replace").strip()
    # Default cmd restarts 2 units (gateway + llama) so expects 2 "active"
    # lines from is-active. Override restarts may restart 1 — at minimum
    # require one "active" line and a clean rc.
    min_active = 2 if not override else 1
    success = proc.returncode == 0 and out.count("active") >= min_active

    # Emit a workflow event so the dashboard's WorkflowGraph + Notifications
    # animate with the restart.
    try:
        await _publish_workflow_event({
            "type": "agent_tool",
            "agentId": agent_id,
            "tool": f"restart {'OK' if success else 'FAILED'}",
            "ts": time.time(),
        })
    except Exception:
        pass

    return {
        "ok": success,
        "agent_id": agent_id,
        "host": host,
        "stdout": out,
        "stderr": err,
        "rc": proc.returncode,
    }


@app.post("/api/agents/{agent_id}/send", response_model=SendMessageResult)
async def send_message(agent_id: str, body: SendMessageBody) -> dict:
    agent = find_agent(agent_id)
    if not body.message.strip():
        raise HTTPException(400, "empty message")

    # Push-only agents (Claude): no api_server, just relay to Telegram.
    if agent.get("push_only"):
        await _publish_send_kickoff(agent_id, body.source)
        await _relay_to_telegram(agent, body.message, None)
        return {"ok": True, "reply": None, "error": "push_only"}

    api_url = agent.get("api_server_url")
    if not api_url:
        raise HTTPException(400, f"agent {agent_id} has no api_server_url configured")

    api_key = _hermes_api_key()
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    # Thread into the existing Telegram session (Hermes' SessionDB is keyed
    # by .jsonl basename — same key as platform sessions).
    session_id = await _resolve_telegram_session_id(agent)
    if session_id:
        headers["X-Hermes-Session-Id"] = session_id

    payload = {
        "model": "hermes-agent",
        "messages": [{"role": "user", "content": body.message}],
        "stream": False,
    }

    import httpx

    # Workflow particle (kickoff)
    await _publish_send_kickoff(agent_id, body.source)

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=5.0, read=600.0, write=10.0, pool=5.0)
        ) as client:
            resp = await client.post(
                f"{api_url.rstrip('/')}/v1/chat/completions",
                json=payload, headers=headers,
            )
            resp.raise_for_status()
            data = resp.json()
            choices = data.get("choices") or []
            reply = ""
            if choices:
                msg = choices[0].get("message") or {}
                reply = msg.get("content") or ""
            # Workflow particle (response)
            await _publish_send_reply(agent_id, body.source)
            # Mirror exchange to Telegram (don't block on failure).
            asyncio.create_task(_relay_to_telegram(agent, body.message, reply))
            return {"ok": True, "reply": reply, "error": None}
    except httpx.HTTPStatusError as e:
        body_text = e.response.text[:300] if e.response is not None else ""
        return {"ok": False, "reply": None, "error": f"HTTP {e.response.status_code}: {body_text}"}
    except Exception as e:
        return {"ok": False, "reply": None, "error": f"{type(e).__name__}: {e}"}


@app.post("/api/agents/{agent_id}/stream")
async def send_message_stream(agent_id: str, body: SendMessageBody):
    """Same as /send but streams the upstream response back as SSE.
    Browsers consume via fetch + reader (EventSource doesn't support POST)."""
    agent = find_agent(agent_id)
    if not body.message.strip():
        raise HTTPException(400, "empty message")

    # Push-only agents (Claude): one-way Telegram relay; reply via "delivered" event.
    if agent.get("push_only"):
        async def push_gen():
            await _relay_to_telegram(agent, body.message, None)
            yield (
                "data: " + json.dumps({
                    "choices": [{
                        "delta": {
                            "content": "📲 Delivered to Telegram. Claude's bot is poller-only — open Telegram to continue."
                        }
                    }]
                }) + "\n\n"
            )
            yield "data: [DONE-STREAM]\n\n"
        return StreamingResponse(
            push_gen(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
                "Connection": "keep-alive",
            },
        )

    api_url = agent.get("api_server_url")
    if not api_url:
        raise HTTPException(400, f"agent {agent_id} has no api_server_url configured")

    api_key = _hermes_api_key()
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    session_id = await _resolve_telegram_session_id(agent)
    if session_id:
        headers["X-Hermes-Session-Id"] = session_id

    payload = {
        "model": "hermes-agent",
        "messages": [{"role": "user", "content": body.message}],
        "stream": True,
    }

    async def gen():
        import httpx
        accumulated = ""
        first_delta = True
        # Workflow particle (kickoff)
        await _publish_send_kickoff(agent_id, body.source)
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(connect=5.0, read=600.0, write=10.0, pool=5.0)
            ) as client:
                async with client.stream(
                    "POST",
                    f"{api_url.rstrip('/')}/v1/chat/completions",
                    json=payload,
                    headers=headers,
                ) as resp:
                    if resp.status_code >= 400:
                        text = (await resp.aread()).decode(errors="replace")[:300]
                        yield f"data: {json.dumps({'error': f'HTTP {resp.status_code}: {text}'})}\n\n"
                        return
                    # Forward upstream SSE lines verbatim. Hermes emits standard
                    # OpenAI delta format: `data: {choices: [{delta: {content}}]}`
                    async for line in resp.aiter_lines():
                        if line is None:
                            continue
                        if line.startswith("data: "):
                            data_str = line[len("data: "):].strip()
                            if data_str and data_str != "[DONE]":
                                try:
                                    parsed = json.loads(data_str)
                                    for c in parsed.get("choices", []):
                                        delta = (c.get("delta") or {}).get("content")
                                        if isinstance(delta, str) and delta:
                                            if first_delta:
                                                first_delta = False
                                                await _publish_send_reply(agent_id, body.source)
                                            accumulated += delta
                                except Exception:
                                    pass
                            yield line + "\n\n"
                        elif line == "":
                            continue
        except Exception as e:
            yield f"data: {json.dumps({'error': f'{type(e).__name__}: {e}'})}\n\n"
        if accumulated:
            asyncio.create_task(_relay_to_telegram(agent, body.message, accumulated))
        yield "data: [DONE-STREAM]\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# Parse Hermes log lines into a coarse state. The line patterns are stable
# across our Hermes versions but may need updating if the log format changes.
_INBOUND_RE = re.compile(r"inbound message:")
# "Making API call" and "response ready:" are real activity signals.
# "Auxiliary auto-detect" / "Auxiliary compression" run once per turn as
# config probes — they are NOT sustained-thinking signals and were causing
# stuck "thinking" states when the most recent log line was a probe from a
# long-completed turn. Dropped from this regex (2026-04-30).
_API_CALL_RE = re.compile(r"Making API call|response ready:")
_RESPONSE_READY_RE = re.compile(r"response ready:")


def _classify(line: str) -> str | None:
    if _INBOUND_RE.search(line) or _API_CALL_RE.search(line):
        if _RESPONSE_READY_RE.search(line):
            return "idle"
        return "thinking"
    return None


def _resolve_log_path(agent: dict) -> str | None:
    """Resolve the log file to tail. Supports either log_path (literal)
    or log_path_glob (picks the most-recently-modified match — for setups
    that rotate by date)."""
    if agent.get("log_path"):
        return agent["log_path"]
    glob_pat = agent.get("log_path_glob")
    if not glob_pat:
        return None
    if agent.get("host", "localhost") == "localhost":
        import glob, os
        matches = glob.glob(glob_pat)
        if not matches:
            return None
        return max(matches, key=lambda p: os.path.getmtime(p))
    # Remote glob: shell-resolve via ssh ls -t.
    return None  # handled inline by callers using a remote command


async def _read_recent_lines(agent: dict, n: int = 200) -> list[str]:
    """SSH to agent host and tail -n N of its log. Supports log_path_glob
    by remote-resolving with `ls -t` to pick the newest match."""
    is_local = agent.get("host", "localhost") == "localhost"
    log_path = _resolve_log_path(agent)

    if is_local and log_path is None:
        return []
    if is_local:
        cmd = ["tail", "-n", str(n), log_path]
    else:
        # Remote: prefer literal log_path; if only glob given, resolve via shell.
        if agent.get("log_path"):
            tail_cmd = f"tail -n {int(n)} {agent['log_path']!s}"
        elif agent.get("log_path_glob"):
            tail_cmd = (
                f"set -- $(ls -t {agent['log_path_glob']} 2>/dev/null); "
                f"[ -n \"$1\" ] && tail -n {int(n)} \"$1\""
            )
        else:
            return []
        cmd = [
            "ssh", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5",
            "-i", agent["key_file"], f"{agent['user']}@{agent['host']}",
            tail_cmd,
        ]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    stdout, _ = await proc.communicate()
    return [line for line in stdout.decode(errors="replace").splitlines() if line.strip()]


class AgentMetrics(BaseModel):
    id: str
    msgs_today: int
    api_calls_today: int
    avg_latency_s: float | None
    tools_today: int
    activity_buckets: list[int]   # 60 buckets covering last 60 min, count of events per minute


@app.get("/api/agents/{agent_id}/metrics", response_model=AgentMetrics)
async def agent_metrics(agent_id: str) -> dict:
    agent = find_agent(agent_id)
    # Pull a generous slice of recent log lines (~2k) and parse counters.
    lines = await _read_recent_lines(agent, n=2000)

    import datetime as _dt
    today = _dt.date.today().isoformat()

    msgs_today = 0
    api_calls_today = 0
    latencies: list[float] = []
    tools_today = 0
    minute_counts = [0] * 60

    now_ts = _dt.datetime.now()

    # Hermes log line shape:
    # "2026-04-25 14:53:08,156 INFO gateway.run: inbound message: ..."
    # "2026-04-25 14:53:16,500 INFO gateway.run: response ready: platform=telegram chat=... time=8.4s api_calls=1 response=61 chars"
    # OpenClaw log: JSON, different shape — skip metrics for that.
    line_re = re.compile(r"^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})")
    inbound_re = re.compile(r"inbound message:")
    response_re = re.compile(r"response ready:.*time=([\d\.]+)s\s+api_calls=(\d+).*?(?:response=\d+\s+chars)?")

    for line in lines:
        m = line_re.match(line)
        if not m:
            continue
        date_str = m.group(1)
        hh, mm, ss = int(m.group(2)), int(m.group(3)), int(m.group(4))
        if date_str == today:
            if inbound_re.search(line):
                msgs_today += 1
            mr = response_re.search(line)
            if mr:
                try:
                    latencies.append(float(mr.group(1)))
                    api_calls_today += int(mr.group(2))
                except Exception:
                    pass
            # Crude tool-call detection: count "Auxiliary auto-detect" or "tool_use"
            if "tool_calls" in line or "Auxiliary auto-detect" in line:
                tools_today += 1
        # Activity buckets — cover last 60 min from now
        try:
            log_ts = _dt.datetime.fromisoformat(f"{date_str} {hh:02d}:{mm:02d}:{ss:02d}")
        except Exception:
            continue
        delta = (now_ts - log_ts).total_seconds()
        if 0 <= delta < 3600:
            minute_idx = 59 - int(delta // 60)
            if 0 <= minute_idx < 60 and (inbound_re.search(line) or response_re.search(line) or "Auxiliary auto-detect" in line):
                minute_counts[minute_idx] += 1

    avg_latency = sum(latencies) / len(latencies) if latencies else None
    return {
        "id": agent_id,
        "msgs_today": msgs_today,
        "api_calls_today": api_calls_today,
        "avg_latency_s": avg_latency,
        "tools_today": tools_today,
        "activity_buckets": minute_counts,
    }


# Per-agent llama-server perf snapshot. Uses /slots from the agent's
# llama_url to extract slots_busy/total + tps. tps is computed from delta
# of next_token[0].n_decoded between calls (llama.cpp doesn't expose
# t_token_generation in /slots — it must be inferred). Stale state is
# scoped per agent_id and resets when id_task changes.
_perf_state: dict[str, dict] = {}
_PERF_CACHE_TTL = 1.5


@app.get("/api/agents/{agent_id}/perf")
async def agent_perf(agent_id: str) -> dict:
    import httpx
    now = time.time()

    cached = _perf_state.get(agent_id)
    if cached and now - cached.get("cache_ts", 0) < _PERF_CACHE_TTL:
        return cached["data"]

    agent = next((a for a in load_agents() if a.get("id") == agent_id), None)
    result = {
        "agent_id": agent_id,
        "tps_recent": None,
        "ctx_used": 0,
        "ctx_max": 0,
        "slots_busy": 0,
        "slots_total": 0,
        "ts": now,
    }

    llama_url = (agent or {}).get("llama_url")
    if not llama_url:
        _perf_state[agent_id] = {"cache_ts": now, "data": result}
        return result

    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            r = await client.get(f"{llama_url}/slots")
            if r.status_code != 200:
                _perf_state[agent_id] = {"cache_ts": now, "data": result}
                return result
            slots = r.json()
            if not isinstance(slots, list) or not slots:
                _perf_state[agent_id] = {"cache_ts": now, "data": result}
                return result

            result["slots_total"] = len(slots)
            result["ctx_max"] = slots[0].get("n_ctx", 0) or 0
            busy = [s for s in slots if s.get("is_processing")]
            result["slots_busy"] = len(busy)

            if busy:
                active = busy[0]
                nt = active.get("next_token") or []
                n_decoded = (nt[0].get("n_decoded", 0) if nt else 0) or 0
                result["ctx_used"] = n_decoded

                prev = cached or {}
                prev_id_task = prev.get("active_id_task")
                prev_n = prev.get("active_n_decoded")
                prev_ts = prev.get("active_ts")
                same_task = prev_id_task is not None and prev_id_task == active.get("id_task")
                if same_task and prev_n is not None and prev_ts is not None:
                    dt = now - prev_ts
                    dn = n_decoded - prev_n
                    if dt > 0.05 and dn > 0:
                        result["tps_recent"] = round(dn / dt, 2)

                _perf_state[agent_id] = {
                    "cache_ts": now,
                    "active_id_task": active.get("id_task"),
                    "active_n_decoded": n_decoded,
                    "active_ts": now,
                    "data": result,
                }
                return result
    except Exception:
        pass

    _perf_state[agent_id] = {"cache_ts": now, "data": result}
    return result


@app.get("/api/agents/{agent_id}/status", response_model=AgentStatus)
async def agent_status(agent_id: str) -> dict:
    agent = find_agent(agent_id)
    lines = await _read_recent_lines(agent, n=80)
    state = "unknown"
    last_event_at = None
    last_event_text = None
    classified_at: float | None = None
    # Walk newest-to-oldest, find first inbound vs response_ready
    for line in reversed(lines):
        # Hermes log line: "2026-04-25 10:43:56,061 INFO ... inbound message: ..."
        m = re.match(r"^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})", line)
        line_ts: float | None = None
        if m:
            try:
                line_ts = time.mktime(time.strptime(m.group(1), "%Y-%m-%d %H:%M:%S"))
            except Exception:
                pass
            if last_event_at is None:
                last_event_at = line_ts
        if last_event_text is None:
            last_event_text = line[:200]
        c = _classify(line)
        if c is not None:
            state = c
            classified_at = line_ts
            break
    # Freshness window: if the latest classifying line is older than 60s, the
    # agent isn't actively working right now — treat as idle. Without this,
    # a long-completed turn whose final line was "thinking"-shaped (e.g. a
    # silent curator pass with no "response ready") pins the agent to
    # "thinking" forever in the dashboard. (Bug surfaced 2026-04-30 with
    # Sarah's autonomous curator pass on Hermes 0.12.0.)
    if state == "thinking" and classified_at is not None:
        if (time.time() - classified_at) > 60:
            state = "idle"
    return {
        "id": agent_id,
        "state": state,
        "last_event_at": last_event_at,
        "last_event_text": last_event_text,
    }


class Toolkit(BaseModel):
    id: str
    enabled: bool
    name: str   # display name (emoji + label, as Hermes prints it)
    key: str    # short key like "web", "browser"


CLAUDE_CODE_TOOLKITS: list[dict] = [
    # Curated set of Claude Code's main tools, grouped by capability
    {"key": "file_ops", "name": "📁 File Operations", "enabled": True},
    {"key": "edit", "name": "✏️ Edit / Write / Patch", "enabled": True},
    {"key": "search", "name": "🔎 Glob / Grep / Search", "enabled": True},
    {"key": "bash", "name": "💻 Bash & Terminal", "enabled": True},
    {"key": "web", "name": "🌐 Web Fetch & Search", "enabled": True},
    {"key": "subagent", "name": "👥 Task / Subagent Delegation", "enabled": True},
    {"key": "tasks", "name": "📋 Task Tracking (TodoWrite)", "enabled": True},
    {"key": "schedule", "name": "⏰ Schedule / Cron", "enabled": True},
    {"key": "skills", "name": "🎯 Skills / Slash Commands", "enabled": True},
    {"key": "memory", "name": "💾 Auto-Memory (MEMORY.md)", "enabled": True},
    {"key": "mcp_telegram", "name": "📱 MCP · Telegram", "enabled": True},
    {"key": "mcp_supabase", "name": "🗄️ MCP · Supabase", "enabled": True},
    {"key": "mcp_hf", "name": "🤗 MCP · Hugging Face", "enabled": True},
    {"key": "mcp_gmail", "name": "📧 MCP · Gmail", "enabled": True},
    {"key": "mcp_drive", "name": "📁 MCP · Google Drive", "enabled": True},
    {"key": "mcp_calendar", "name": "📅 MCP · Google Calendar", "enabled": True},
    {"key": "mcp_stripe", "name": "💳 MCP · Stripe", "enabled": True},
    {"key": "mcp_cf", "name": "☁️ MCP · Cloudflare", "enabled": True},
    {"key": "notebook", "name": "📓 Notebook Edit", "enabled": True},
    {"key": "vision", "name": "👁 Image / PDF Reading", "enabled": True},
]


@app.get("/api/agents/{agent_id}/toolkits", response_model=list[Toolkit])
async def agent_toolkits(agent_id: str) -> list[dict]:
    agent = find_agent(agent_id)
    if agent.get("host", "localhost") == "localhost":
        # Claude Code (this runtime) — return curated tool list for the orchestrator.
        return [
            {"id": f"{agent['id']}:{t['key']}", **t}
            for t in CLAUDE_CODE_TOOLKITS
        ]
    # Build hermes tools list command dynamically
    hermes_bin = os.environ.get("HERMES_BIN", "hermes")
    profile = agent.get("hermes_profile", "")
    profile_flag = f" -p {profile}" if profile else ""
    cmd = f"{hermes_bin}{profile_flag} tools list 2>&1"
    proc = await asyncio.create_subprocess_exec(
        "ssh", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5",
        "-i", agent["key_file"], f"{agent['user']}@{agent['host']}",
        cmd,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=12)
    except asyncio.TimeoutError:
        return []
    out = stdout.decode(errors="replace")
    # Parse lines like: "  ✓ enabled  web  🔍 Web Search & Scraping"
    line_re = re.compile(r"^\s*([✓✗])\s+(enabled|disabled)\s+(\S+)\s+(\S.*?)$")
    items: list[dict] = []
    seen_keys: set[str] = set()
    for line in out.splitlines():
        m = line_re.match(line)
        if not m:
            continue
        sym, status, key, display = m.groups()
        if key in seen_keys:
            continue
        seen_keys.add(key)
        items.append({
            "id": f"{agent['id']}:{key}",
            "enabled": status == "enabled",
            "name": display.strip(),
            "key": key,
        })
    return items


@app.websocket("/ws/agents/{agent_id}/chat")
async def agent_chat(ws: WebSocket, agent_id: str):
    """Tail the agent's latest session JSONL — actual user/assistant turns."""
    await ws.accept()
    try:
        agent = find_agent(agent_id)
    except HTTPException as e:
        await ws.send_json({"type": "error", "error": e.detail})
        await ws.close()
        return

    is_local = agent.get("host", "localhost") == "localhost"
    glob_pat = agent.get("sessions_glob")
    if not glob_pat:
        await ws.send_json({"type": "error", "error": "no sessions_glob configured"})
        await ws.close()
        return

    # Backfill: read the last 200 entries of the latest session jsonl.
    if is_local:
        backfill_cmd = (
            f"set -- $(ls -t {glob_pat} 2>/dev/null); "
            f"[ -n \"$1\" ] && tail -n 200 \"$1\""
        )
        proc = await asyncio.create_subprocess_shell(
            backfill_cmd,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
    else:
        proc = await asyncio.create_subprocess_exec(
            "ssh", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5",
            "-i", agent["key_file"], f"{agent['user']}@{agent['host']}",
            f"set -- $(ls -t {glob_pat} 2>/dev/null); "
            f"[ -n \"$1\" ] && tail -n 200 \"$1\"",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
    stdout, _ = await proc.communicate()
    backfill = [line for line in stdout.decode(errors="replace").splitlines() if line.strip()]
    await ws.send_json({"type": "backfill", "lines": backfill})

    # Live tail with rotation-tolerant follow loop.
    tail_cmd = (
        f"while true; do "
        f"set -- $(ls -t {glob_pat} 2>/dev/null); "
        f"[ -n \"$1\" ] && tail -n 0 -F \"$1\"; "
        f"sleep 5; done"
    )
    if is_local:
        proc2 = await asyncio.create_subprocess_shell(
            tail_cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
    else:
        # -tt forces a remote pseudo-tty so closing the local ssh sends
        # SIGHUP to the remote shell + tail (otherwise the remote loop
        # continues running as an orphan filling /proc with `sleep 5`s).
        proc2 = await asyncio.create_subprocess_exec(
            "ssh", "-tt",
            "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=no",
            "-o", "ServerAliveInterval=20", "-o", "ServerAliveCountMax=3",
            "-i", agent["key_file"], f"{agent['user']}@{agent['host']}",
            tail_cmd,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
    try:
        while True:
            line_bytes = await proc2.stdout.readline()
            if not line_bytes:
                break
            line = line_bytes.decode(errors="replace").rstrip("\n")
            if not line.strip():
                continue
            await ws.send_json({"type": "line", "line": line})
    except WebSocketDisconnect:
        pass
    finally:
        try:
            proc2.terminate()
            await asyncio.wait_for(proc2.wait(), timeout=2)
        except Exception:
            try:
                proc2.kill()
            except Exception:
                pass


@app.websocket("/ws/agents/{agent_id}/logs")
async def agent_logs(ws: WebSocket, agent_id: str):
    await ws.accept()
    try:
        agent = find_agent(agent_id)
    except HTTPException as e:
        await ws.send_json({"type": "error", "error": e.detail})
        await ws.close()
        return

    is_local = agent.get("host", "localhost") == "localhost"
    log_path = _resolve_log_path(agent)
    glob_pat = agent.get("log_path_glob")
    if is_local and log_path is None:
        await ws.send_json({"type": "error", "error": "no log file matched"})
        await ws.close()
        return
    if not is_local and not agent.get("log_path") and not glob_pat:
        await ws.send_json({"type": "error", "error": "no log_path configured"})
        await ws.close()
        return

    # First: send the last 200 lines as a backfill burst.
    backfill = await _read_recent_lines(agent, n=200)
    await ws.send_json({"type": "backfill", "lines": backfill})

    # Then: stream tail -F via SSH (or local).
    if is_local:
        cmd = ["tail", "-n", "0", "-F", log_path]
    else:
        if agent.get("log_path"):
            tail_cmd = f"tail -n 0 -F {agent['log_path']!s}"
        else:
            # tail -F doesn't follow new files matched by a later ls -t — for
            # rotation-by-date logs, follow the resolved file but also retry
            # via a small polling outer loop.
            tail_cmd = (
                f"while true; do "
                f"set -- $(ls -t {glob_pat} 2>/dev/null); "
                f"[ -n \"$1\" ] && tail -n 0 -F \"$1\"; "
                f"sleep 5; done"
            )
        cmd = [
            "ssh", "-tt",
            "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=no",
            "-o", "ServerAliveInterval=20", "-o", "ServerAliveCountMax=3",
            "-i", agent["key_file"], f"{agent['user']}@{agent['host']}",
            tail_cmd,
        ]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        while True:
            line_bytes = await proc.stdout.readline()
            if not line_bytes:
                break
            line = line_bytes.decode(errors="replace").rstrip("\n")
            if not line:
                continue
            await ws.send_json({"type": "line", "line": line})
    except WebSocketDisconnect:
        pass
    finally:
        try:
            proc.terminate()
            await asyncio.wait_for(proc.wait(), timeout=2)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


# ── Task store (sqlite) ──────────────────────────────────────────────────


import sqlite3
TASKS_DB_FILE = ROOT / "tasks.db"


def _tasks_init() -> None:
    """Create the tasks + quickprompts tables on first run."""
    with sqlite3.connect(TASKS_DB_FILE) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tasks (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                title           TEXT NOT NULL,
                description     TEXT DEFAULT '',
                owner_agent     TEXT,
                status          TEXT NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending','in_progress','completed','cancelled')),
                parent_task_id  INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
                created_by      TEXT NOT NULL DEFAULT 'user',
                created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_agent)"""
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS workflow_events (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                ts      REAL NOT NULL,
                type    TEXT NOT NULL,
                payload TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_wf_ts ON workflow_events(ts)"""
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS quickprompts (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                label       TEXT NOT NULL,
                icon        TEXT DEFAULT '⚡',
                prompt      TEXT NOT NULL,
                target      TEXT NOT NULL DEFAULT 'broadcast',
                ord         INTEGER NOT NULL DEFAULT 0,
                created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        # Seed defaults if empty
        cur = conn.execute("SELECT COUNT(*) FROM quickprompts")
        if cur.fetchone()[0] == 0:
            seeds = [
                ("Status check", "🩺",
                 "Quick status — anything notable on your machine right now? Load, memory, any errors? One-paragraph summary.",
                 "broadcast", 0),
                ("Today summary", "📅",
                 "In 3-5 bullets, summarize what we've been working on in our most recent conversations.",
                 "broadcast", 1),
                ("Fleet sweep", "🧹",
                 "Run `df -h`, `free -h`, and report anything filling up. Also: list any zombie / orphan processes.",
                 "clue", 2),
                ("Sarah idea", "💡",
                 "Pitch one creative side project we could build this weekend, given the current fleet hardware.",
                 "sarah", 3),
            ]
            conn.executemany(
                "INSERT INTO quickprompts (label, icon, prompt, target, ord) VALUES (?, ?, ?, ?, ?)",
                seeds,
            )


_tasks_init()


def _row_to_task(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "description": row["description"] or "",
        "owner_agent": row["owner_agent"],
        "status": row["status"],
        "parent_task_id": row["parent_task_id"],
        "created_by": row["created_by"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


class Task(BaseModel):
    id: int
    title: str
    description: str = ""
    owner_agent: str | None = None
    status: Literal["pending", "in_progress", "completed", "cancelled"]
    parent_task_id: int | None = None
    created_by: str = "user"
    created_at: str
    updated_at: str


class TaskCreateBody(BaseModel):
    title: str
    description: str = ""
    owner_agent: str | None = None
    parent_task_id: int | None = None
    created_by: str = "user"


class TaskUpdateBody(BaseModel):
    title: str | None = None
    description: str | None = None
    owner_agent: str | None = None
    status: Literal["pending", "in_progress", "completed", "cancelled"] | None = None
    parent_task_id: int | None = None


@app.get("/api/tasks", response_model=list[Task])
def list_tasks(
    status: Literal["pending", "in_progress", "completed", "cancelled"] | None = None,
    owner_agent: str | None = None,
) -> list[dict]:
    with sqlite3.connect(TASKS_DB_FILE) as conn:
        conn.row_factory = sqlite3.Row
        q = "SELECT * FROM tasks"
        clauses = []
        params: list = []
        if status:
            clauses.append("status = ?")
            params.append(status)
        if owner_agent:
            clauses.append("owner_agent = ?")
            params.append(owner_agent)
        if clauses:
            q += " WHERE " + " AND ".join(clauses)
        q += " ORDER BY id DESC LIMIT 500"
        rows = conn.execute(q, params).fetchall()
    return [_row_to_task(r) for r in rows]


@app.post("/api/tasks", response_model=Task)
def create_task(body: TaskCreateBody) -> dict:
    if not body.title.strip():
        raise HTTPException(400, "title required")
    with sqlite3.connect(TASKS_DB_FILE) as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.execute(
            """INSERT INTO tasks (title, description, owner_agent, parent_task_id, created_by)
               VALUES (?, ?, ?, ?, ?)""",
            (
                body.title.strip(),
                body.description,
                body.owner_agent,
                body.parent_task_id,
                body.created_by,
            ),
        )
        new_id = cur.lastrowid
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (new_id,)).fetchone()
    return _row_to_task(row)


@app.patch("/api/tasks/{task_id}", response_model=Task)
def update_task(task_id: int, body: TaskUpdateBody) -> dict:
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(400, "no fields to update")
    sets = ", ".join(f"{k} = ?" for k in fields.keys())
    params = list(fields.values()) + [task_id]
    with sqlite3.connect(TASKS_DB_FILE) as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.execute(
            f"UPDATE tasks SET {sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            params,
        )
        if cur.rowcount == 0:
            raise HTTPException(404, f"task {task_id} not found")
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    return _row_to_task(row)


@app.delete("/api/tasks/{task_id}")
def delete_task(task_id: int) -> dict:
    with sqlite3.connect(TASKS_DB_FILE) as conn:
        cur = conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        if cur.rowcount == 0:
            raise HTTPException(404, f"task {task_id} not found")
    return {"ok": True, "deleted": task_id}


# ── Quick prompts (saved presets) ────────────────────────────────────────


class QuickPromptBody(BaseModel):
    label: str
    icon: str = "⚡"
    prompt: str
    target: str = "broadcast"  # agent_id or "broadcast"


def _row_to_qp(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "label": row["label"],
        "icon": row["icon"] or "⚡",
        "prompt": row["prompt"],
        "target": row["target"] or "broadcast",
        "ord": row["ord"],
    }


@app.get("/api/quickprompts")
def list_quickprompts() -> list[dict]:
    with sqlite3.connect(TASKS_DB_FILE) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM quickprompts ORDER BY ord ASC, id ASC"
        ).fetchall()
    return [_row_to_qp(r) for r in rows]


@app.post("/api/quickprompts")
def create_quickprompt(body: QuickPromptBody) -> dict:
    if not body.label.strip() or not body.prompt.strip():
        raise HTTPException(400, "label and prompt required")
    with sqlite3.connect(TASKS_DB_FILE) as conn:
        conn.row_factory = sqlite3.Row
        max_ord = conn.execute("SELECT COALESCE(MAX(ord), -1) FROM quickprompts").fetchone()[0]
        cur = conn.execute(
            "INSERT INTO quickprompts (label, icon, prompt, target, ord) VALUES (?, ?, ?, ?, ?)",
            (body.label.strip(), body.icon.strip() or "⚡",
             body.prompt.strip(), body.target.strip() or "broadcast", max_ord + 1),
        )
        row = conn.execute(
            "SELECT * FROM quickprompts WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
    return _row_to_qp(row)


@app.put("/api/quickprompts/{qp_id}")
def update_quickprompt(qp_id: int, body: QuickPromptBody) -> dict:
    with sqlite3.connect(TASKS_DB_FILE) as conn:
        conn.row_factory = sqlite3.Row
        cur = conn.execute(
            "UPDATE quickprompts SET label = ?, icon = ?, prompt = ?, target = ? WHERE id = ?",
            (body.label.strip(), body.icon.strip() or "⚡",
             body.prompt.strip(), body.target.strip() or "broadcast", qp_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, f"quickprompt {qp_id} not found")
        row = conn.execute(
            "SELECT * FROM quickprompts WHERE id = ?", (qp_id,)
        ).fetchone()
    return _row_to_qp(row)


@app.delete("/api/quickprompts/{qp_id}")
def delete_quickprompt(qp_id: int) -> dict:
    with sqlite3.connect(TASKS_DB_FILE) as conn:
        cur = conn.execute("DELETE FROM quickprompts WHERE id = ?", (qp_id,))
        if cur.rowcount == 0:
            raise HTTPException(404, f"quickprompt {qp_id} not found")
    return {"ok": True, "deleted": qp_id}


# ── Host stats: GPU / VRAM via SSH ───────────────────────────────────────


class GpuStats(BaseModel):
    host: str
    available: bool
    name: str | None = None
    vram_used_mib: int | None = None
    vram_total_mib: int | None = None
    util_pct: int | None = None
    temp_c: int | None = None
    processes: list[dict] = []
    error: str | None = None


def _build_host_registry() -> dict[str, dict]:
    """Build HOST_REGISTRY dynamically from machines.yaml."""
    registry = {}
    for m in load_machines():
        mid = m["id"]
        is_local = (m.get("hostname") in ("localhost", "127.0.0.1") or
                    mid == os.environ.get("KVM_HUB_LOCAL_MACHINE", ""))
        registry[mid] = {
            "label": m.get("name", mid),
            "ssh_user": None if is_local else m.get("username"),
            "ssh_host": None if is_local else m.get("hostname"),
            "key_file": None if is_local else m.get("key_file"),
            "gpu_kind": m.get("gpu_kind"),  # set in machines.yaml if needed
            "iperf_addr": m.get("lan_ip") or m.get("hostname"),
        }
    return registry


def _get_host_registry() -> dict[str, dict]:
    return _build_host_registry()


def _get_hosts_with_gpu() -> dict[str, dict]:
    return {k: v for k, v in _get_host_registry().items() if v.get("gpu_kind") == "nvidia"}


# Backward compat: use property-like access. These are rebuilt on each call
# so they reflect machines.yaml changes without restart.
class _HostRegistryProxy(dict):
    def __getitem__(self, key): return _get_host_registry()[key]
    def get(self, key, default=None): return _get_host_registry().get(key, default)
    def __contains__(self, key): return key in _get_host_registry()
    def __iter__(self): return iter(_get_host_registry())
    def keys(self): return _get_host_registry().keys()
    def values(self): return _get_host_registry().values()
    def items(self): return _get_host_registry().items()
    def __len__(self): return len(_get_host_registry())

HOST_REGISTRY = _HostRegistryProxy()
HOSTS_WITH_GPU = type("_GpuProxy", (), {
    "__contains__": lambda s, k: k in _get_hosts_with_gpu(),
    "__iter__": lambda s: iter(_get_hosts_with_gpu()),
    "keys": lambda s: _get_hosts_with_gpu().keys(),
    "items": lambda s: _get_hosts_with_gpu().items(),
    "get": lambda s, k, d=None: _get_hosts_with_gpu().get(k, d),
})()


# ── Host history (ring buffer for sparklines) ───────────────────────────
# 30 samples × 60s = 30 min of trace per host. Lives in-process; on restart
# the history is empty (acceptable — sparklines just show what's been seen).
from collections import deque
_HOST_HIST_LEN = 30
_HOST_HISTORY: dict[str, deque] = {}


def _push_host_sample(host_id: str, sample: dict) -> None:
    if host_id not in _HOST_HISTORY:
        _HOST_HISTORY[host_id] = deque(maxlen=_HOST_HIST_LEN)
    buf = _HOST_HISTORY.get(host_id)
    if buf is None:
        return
    buf.append(sample)


@app.get("/api/hosts/{host_id}/history")
async def host_history(host_id: str) -> dict:
    if host_id not in HOST_REGISTRY:
        raise HTTPException(404, f"unknown host: {host_id}")
    return {
        "host": host_id,
        "samples": list(_HOST_HISTORY[host_id]),
        "max_len": _HOST_HIST_LEN,
    }


# ── Host desktop thumbnails ─────────────────────────────────────────────
# Periodic SSH screenshot of each host's active display, cached on the
# backend so the dashboard can poll cheaply. Requires `gnome-screenshot`
# and ImageMagick `convert` on the target host (default on stock GNOME).

_THUMB_CACHE: dict[str, tuple[float, bytes]] = {}
_THUMB_TTL_SEC = 25.0

# Tiny inline PNG used when capture fails — dark with a glyph.
_PLACEHOLDER_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAUAAAACQCAIAAAAcOPdMAAAAEUlEQVR4nGP4//8/AwwxAACj+gOf"
    "C/GjrwAAAABJRU5ErkJggg=="
)


def _make_status_image(line1: str, line2: str = "") -> bytes:
    """Render a small dark PNG with text status when capture is unavailable.
    Avoids a hard PIL dependency by rendering with cairo if available; otherwise
    returns the static placeholder."""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except Exception:
        return _PLACEHOLDER_PNG
    img = Image.new("RGB", (480, 270), color=(17, 18, 26))
    draw = ImageDraw.Draw(img)
    try:
        font_big = ImageFont.truetype(
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 18,
        )
        font_small = ImageFont.truetype(
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 13,
        )
    except Exception:
        font_big = ImageFont.load_default()
        font_small = ImageFont.load_default()
    # Subtle border
    draw.rectangle([(0, 0), (479, 269)], outline=(43, 45, 64), width=1)
    # Centered text. When line1 is empty, line2 takes the center spot —
    # caller now omits the host label since the dashboard's HostAgentBar
    # carries identity already (avoids two nameplates per host card).
    cx, cy = 240, 135
    if line1:
        draw.text(
            (cx, cy - 12), line1, fill=(180, 180, 200),
            font=font_big, anchor="mm",
        )
        if line2:
            draw.text(
                (cx, cy + 18), line2, fill=(110, 113, 130),
                font=font_small, anchor="mm",
            )
    elif line2:
        draw.text(
            (cx, cy), line2, fill=(110, 113, 130),
            font=font_small, anchor="mm",
        )
    import io
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


async def _capture_thumbnail(host_id: str) -> bytes | None:
    """Take a screenshot on the host and return resized image bytes, or None
    when no real screenshot is available (host headless, GDM login screen,
    capture timed out, no screenshot tool). Caller raises 404 on None so the
    React side can hide the thumbnail block entirely."""
    cfg = HOST_REGISTRY.get(host_id)
    if not cfg:
        return None

    # Local host (the dashboard server itself, e.g. Natalie) — a self-screenshot
    # of the headless container isn't useful and tends to capture a black frame
    # from the user's display. Skip entirely so the React side hides the block.
    if cfg.get("ssh_host") is None:
        return None

    # Probe for a GUI compositor *owned by the SSH user*. If none, abort early.
    cmd = (
        "ps -eo pid,user,comm | awk -v u=$USER '$2==u && ($3 ~ /^gnome-shell$|^wayland-session$|^sway$|^hyprland$|^kwin_x11$|^kwin_wayland$|^mutter$|^Xorg$/) {print $1; exit}'"
    )
    is_local = cfg.get("ssh_host") is None
    if is_local:
        proc = await asyncio.create_subprocess_shell(
            cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
    else:
        proc = await asyncio.create_subprocess_exec(
            "ssh", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5",
            "-i", cfg["key_file"], f"{cfg['ssh_user']}@{cfg['ssh_host']}",
            cmd,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=6.0)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except Exception:
            pass
        return None
    pid = stdout.decode(errors="replace").strip()
    if not pid:
        return None

    # Capture script — pick env from compositor pid, try multiple tools, JPEG out
    capture_cmd = (
        f"PID={pid}; "
        "for v in DISPLAY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR; do "
        "  val=$(tr '\\0' '\\n' < /proc/$PID/environ 2>/dev/null | grep -E \"^$v=\" | head -1 | cut -d= -f2-); "
        "  if [ -n \"$val\" ]; then export $v=\"$val\"; fi; "
        "done; "
        "T=/tmp/kvmhub_thumb_$$.png; "
        "rm -f $T; "
        "if command -v gnome-screenshot >/dev/null 2>&1; then gnome-screenshot -f $T 2>/dev/null; fi; "
        "if [ ! -s $T ] && command -v grim >/dev/null 2>&1; then grim $T 2>/dev/null; fi; "
        "if [ ! -s $T ] && command -v scrot >/dev/null 2>&1; then scrot -o $T 2>/dev/null; fi; "
        "if [ ! -s $T ] && command -v import >/dev/null 2>&1; then import -window root $T 2>/dev/null; fi; "
        "if [ ! -s $T ] && command -v gdbus >/dev/null 2>&1; then "
        "  gdbus call --session --dest org.gnome.Shell.Screenshot "
        "  --object-path /org/gnome/Shell/Screenshot "
        "  --method org.gnome.Shell.Screenshot.Screenshot false false $T 2>/dev/null; "
        "fi; "
        "if [ ! -s $T ]; then echo CAPTURE_FAILED 1>&2; exit 2; fi; "
        "if command -v convert >/dev/null 2>&1; then "
        "  convert $T -resize 480x270^ -gravity center -extent 480x270 -quality 75 jpeg:- ; "
        "else "
        "  cat $T; "  # raw, frontend will downscale via CSS
        "fi; "
        "rm -f $T"
    )
    if is_local:
        proc = await asyncio.create_subprocess_shell(
            capture_cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
    else:
        proc = await asyncio.create_subprocess_exec(
            "ssh", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5",
            "-i", cfg["key_file"], f"{cfg['ssh_user']}@{cfg['ssh_host']}",
            capture_cmd,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=12.0)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except Exception:
            pass
        return None
    if not stdout or len(stdout) < 200:
        return None
    return stdout


# 1×1 transparent PNG, returned in lieu of 404 when no real screenshot
# is available. The React side detects natural-dim = 1px on img.onLoad and
# hides the thumbnail block. Quieter than a 404 (no console error noise).
_TRANSPARENT_1X1_PNG = bytes([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
])


@app.get("/api/hosts/{host_id}/thumbnail")
async def host_thumbnail(host_id: str):
    if host_id not in HOST_REGISTRY:
        raise HTTPException(404, f"unknown host: {host_id}")
    now = time.time()
    cached = _THUMB_CACHE.get(host_id)
    if cached and (now - cached[0]) < _THUMB_TTL_SEC:
        data = cached[1]
    else:
        data = await _capture_thumbnail(host_id)
        _THUMB_CACHE[host_id] = (now, data)
    if data is None:
        # No real screenshot — return a 1×1 transparent PNG instead of 404
        # so the browser console stays clean. React side detects natural
        # dimensions and hides the thumbnail block.
        return Response(
            content=_TRANSPARENT_1X1_PNG,
            media_type="image/png",
            headers={"Cache-Control": "no-cache, no-transform"},
        )
    # JPEG output from convert; raw PNG otherwise. Sniff magic bytes.
    media = "image/jpeg" if data.startswith(b"\xff\xd8") else "image/png"
    return Response(content=data, media_type=media, headers={
        "Cache-Control": "no-cache, no-transform",
    })


# Background poller: refresh host stats every 60s so sparklines accrue
# even when the dashboard isn't actively requesting them.
@app.on_event("startup")
async def _start_host_poller() -> None:
    async def loop():
        # Stagger startup so we don't hammer all 3 hosts at once
        await asyncio.sleep(5)
        while True:
            for hid in HOST_REGISTRY:
                try:
                    await host_stats(hid)  # writes a sample as a side effect
                except Exception:
                    pass
                await asyncio.sleep(2)  # gap between hosts
            await asyncio.sleep(45)  # wait before next sweep
    asyncio.create_task(loop())


class HostStats(BaseModel):
    host: str
    label: str
    available: bool
    cpu_pct: float | None = None
    ram_used_gb: float | None = None
    ram_total_gb: float | None = None
    load_1m: float | None = None
    uptime_days: float | None = None
    gpu: GpuStats | None = None
    error: str | None = None


async def _ssh_or_local_run(host_cfg: dict, command: str) -> tuple[int, str, str]:
    """Run command locally or over SSH. Returns (exit, stdout, stderr)."""
    if host_cfg.get("ssh_host") is None:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
    else:
        cmd = [
            "ssh", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=4",
            "-i", host_cfg["key_file"], f"{host_cfg['ssh_user']}@{host_cfg['ssh_host']}",
            command,
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=8)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except Exception:
            pass
        return -1, "", "ssh timeout"
    return proc.returncode or 0, stdout.decode(errors="replace"), stderr.decode(errors="replace")


@app.get("/api/hosts/{host_id}/stats", response_model=HostStats)
async def host_stats(host_id: str) -> dict:
    cfg = HOST_REGISTRY.get(host_id)
    if not cfg:
        raise HTTPException(404, f"unknown host: {host_id}")

    label = cfg["label"]

    # Single shell command that emits all the stats we want, line-prefixed.
    cmd = (
        # CPU% via /proc/stat: average over 1 second
        "awk '/^cpu / {u=$2+$4; s=$2+$3+$4+$5+$6+$7+$8} END {print \"CPU0\", u, s}' /proc/stat ; "
        "sleep 1 ; "
        "awk '/^cpu / {u=$2+$4; s=$2+$3+$4+$5+$6+$7+$8} END {print \"CPU1\", u, s}' /proc/stat ; "
        # Memory
        "awk '/MemTotal/ {t=$2} /MemAvailable/ {a=$2} END {print \"MEM\", t, a}' /proc/meminfo ; "
        # Load avg
        "awk '{print \"LOAD\", $1}' /proc/loadavg ; "
        # Uptime in seconds
        "awk '{print \"UPTIME\", $1}' /proc/uptime"
    )
    rc, out, err = await _ssh_or_local_run(cfg, cmd)
    if rc != 0 and not out.strip():
        return {"host": host_id, "label": label, "available": False, "error": err[:200]}

    cpu_pct = None
    ram_used_gb = None
    ram_total_gb = None
    load_1m = None
    uptime_days = None
    cpu0 = cpu1 = None
    for line in out.splitlines():
        parts = line.strip().split()
        if not parts:
            continue
        if parts[0] == "CPU0" and len(parts) >= 3:
            try:
                cpu0 = (int(parts[1]), int(parts[2]))
            except Exception:
                pass
        elif parts[0] == "CPU1" and len(parts) >= 3:
            try:
                cpu1 = (int(parts[1]), int(parts[2]))
            except Exception:
                pass
        elif parts[0] == "MEM" and len(parts) >= 3:
            try:
                t_kb = int(parts[1])
                a_kb = int(parts[2])
                used_kb = t_kb - a_kb
                ram_used_gb = round(used_kb / 1024 / 1024, 2)
                ram_total_gb = round(t_kb / 1024 / 1024, 2)
            except Exception:
                pass
        elif parts[0] == "LOAD" and len(parts) >= 2:
            try:
                load_1m = float(parts[1])
            except Exception:
                pass
        elif parts[0] == "UPTIME" and len(parts) >= 2:
            try:
                uptime_days = round(float(parts[1]) / 86400.0, 2)
            except Exception:
                pass
    if cpu0 and cpu1:
        u_diff = cpu1[0] - cpu0[0]
        s_diff = cpu1[1] - cpu0[1]
        if s_diff > 0:
            cpu_pct = round((u_diff / s_diff) * 100, 1)

    gpu = None
    if cfg.get("gpu_kind") in ("nvidia", "amd"):
        gpu_dict = await host_gpu(host_id)
        gpu = gpu_dict

    result = {
        "host": host_id,
        "label": label,
        "available": True,
        "cpu_pct": cpu_pct,
        "ram_used_gb": ram_used_gb,
        "ram_total_gb": ram_total_gb,
        "load_1m": load_1m,
        "uptime_days": uptime_days,
        "gpu": gpu,
        "error": None,
    }

    # Capture a compact sample for the sparkline ring buffer.
    sample = {
        "ts": int(time.time()),
        "cpu_pct": cpu_pct,
        "ram_used_gb": ram_used_gb,
        "ram_total_gb": ram_total_gb,
        "load_1m": load_1m,
        "gpu_util_pct": (gpu or {}).get("util_pct"),
        "gpu_temp_c": (gpu or {}).get("temp_c"),
        "vram_used_mib": (gpu or {}).get("vram_used_mib"),
        "vram_total_mib": (gpu or {}).get("vram_total_mib"),
    }
    _push_host_sample(host_id, sample)
    return result


@app.get("/api/hosts", response_model=list[str])
def list_hosts() -> list[str]:
    return list(HOST_REGISTRY.keys())


# ── iperf3 ad-hoc speed test (Network panel, Fleet tab) ──────────────────
class IperfRequest(BaseModel):
    from_host: str
    to_host: str
    duration: int = 5


async def _ssh_run(cfg: dict, cmd: str, timeout: float = 30.0) -> tuple[int, str, str]:
    """Run a shell command on `cfg`'s host. Returns (rc, stdout, stderr).

    For natalie (no ssh_host) the command runs locally."""
    if not cfg.get("ssh_host"):
        proc = await asyncio.create_subprocess_shell(
            cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return proc.returncode or 0, stdout.decode(errors="replace"), stderr.decode(errors="replace")
    args = [
        "ssh", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
        "-o", "ControlMaster=no", "-o", "ControlPath=none",
        "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=5",
        "-i", cfg["key_file"], f"{cfg['ssh_user']}@{cfg['ssh_host']}", cmd,
    ]
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    return proc.returncode or 0, stdout.decode(errors="replace"), stderr.decode(errors="replace")


@app.post("/api/network/iperf")
async def network_iperf(req: IperfRequest) -> dict:
    """Ad-hoc iperf3 between two hosts. Spawns a one-shot iperf3 server on the
    target (`-s -1` exits after first connection) then runs the client from the
    source. Returns JSON with throughput + retransmits."""
    from_cfg = HOST_REGISTRY.get(req.from_host)
    to_cfg = HOST_REGISTRY.get(req.to_host)
    if not from_cfg or not to_cfg:
        raise HTTPException(404, "unknown host id")
    if req.from_host == req.to_host:
        raise HTTPException(400, "from_host and to_host must differ")
    duration = max(2, min(req.duration, 30))

    # Start one-shot server on target. `-1` makes iperf3 exit after the first
    # client connection completes — no cleanup needed. Backgrounded so we can
    # then run the client. Sleep 1s to let the server bind before connecting.
    server_cmd = "nohup iperf3 -s -1 >/dev/null 2>&1 & sleep 1; echo started"
    rc_s, _, err_s = await _ssh_run(to_cfg, server_cmd, timeout=10.0)
    if rc_s != 0:
        return {"ok": False, "error": f"failed to start iperf3 server on {req.to_host}: {err_s.strip()[:200]}"}

    target_addr = to_cfg.get("iperf_addr") or to_cfg.get("ssh_host")
    client_cmd = f"iperf3 -c {target_addr} -t {duration} -i 0 -J"
    rc_c, out_c, err_c = await _ssh_run(from_cfg, client_cmd, timeout=duration + 15.0)
    if rc_c != 0:
        return {
            "ok": False,
            "error": f"iperf3 client failed: {err_c.strip()[:200] or out_c.strip()[:200]}",
            "from_host": req.from_host,
            "to_host": req.to_host,
        }

    try:
        data = json.loads(out_c)
        end = data.get("end", {})
        sum_received = end.get("sum_received", {})
        sum_sent = end.get("sum_sent", {})
        return {
            "ok": True,
            "from_host": req.from_host,
            "to_host": req.to_host,
            "duration_actual": sum_received.get("seconds"),
            "throughput_bits_per_sec": sum_received.get("bits_per_second"),
            "throughput_mbits_per_sec": (sum_received.get("bits_per_second") or 0) / 1_000_000,
            "throughput_mbytes_per_sec": (sum_received.get("bits_per_second") or 0) / 8_000_000,
            "bytes_transferred": sum_received.get("bytes"),
            "retransmits": sum_sent.get("retransmits", 0),
            "from_label": from_cfg.get("label", req.from_host),
            "to_label": to_cfg.get("label", req.to_host),
        }
    except (json.JSONDecodeError, KeyError) as e:
        return {"ok": False, "error": f"failed to parse iperf3 output: {e}", "raw": out_c[:500]}


async def _host_gpu_amd(host_id: str, cfg: dict) -> dict:
    """Read amdgpu stats from sysfs over SSH."""
    cmd = (
        "for cn in /sys/class/drm/card*/device; do "
        "  v=$(cat $cn/vendor 2>/dev/null); "
        "  if [ \"$v\" = \"0x1002\" ]; then "
        "    echo PATH=$cn; "
        "    echo BUSY=$(cat $cn/gpu_busy_percent 2>/dev/null); "
        "    echo VRAM_USED=$(cat $cn/mem_info_vram_used 2>/dev/null); "
        "    echo VRAM_TOTAL=$(cat $cn/mem_info_vram_total 2>/dev/null); "
        "    echo GTT_USED=$(cat $cn/mem_info_gtt_used 2>/dev/null); "
        "    echo GTT_TOTAL=$(cat $cn/mem_info_gtt_total 2>/dev/null); "
        "    for h in $cn/hwmon/hwmon*/temp1_input; do "
        "      [ -e $h ] && echo TEMP=$(cat $h); "
        "    done; "
        "    break; "
        "  fi; "
        "done"
    )
    rc, out, err = await _ssh_or_local_run(cfg, cmd)
    if rc != 0 and not out.strip():
        return {"host": host_id, "available": False, "error": err[:200]}
    fields: dict[str, str] = {}
    for line in out.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            fields[k.strip()] = v.strip()
    if "VRAM_TOTAL" not in fields:
        return {"host": host_id, "available": False, "error": "amdgpu sysfs not found"}
    try:
        vram_used = int(fields["VRAM_USED"]) // (1024 * 1024)
        vram_total = int(fields["VRAM_TOTAL"]) // (1024 * 1024)
        util = int(fields.get("BUSY", "0") or 0)
        temp_milli = int(fields.get("TEMP", "0") or 0)
        temp = temp_milli // 1000 if temp_milli else None
    except Exception as e:
        return {"host": host_id, "available": False, "error": f"parse: {e}"}
    # GTT (shared system RAM addressable by GPU) is also useful info
    gtt_used = int(fields.get("GTT_USED", "0") or 0) // (1024 * 1024)
    gtt_total = int(fields.get("GTT_TOTAL", "0") or 0) // (1024 * 1024)

    # Try to attribute the dominant llama-server VRAM block as a single proc
    # (no per-process VRAM accounting on AMD; report llama-server RSS as a proxy)
    procs: list[dict] = []
    rc2, out2, _ = await _ssh_or_local_run(
        cfg,
        "pgrep -af 'llama-server' | head -1 | awk '{print $1}' | "
        "xargs -I{} sh -c 'cat /proc/{}/status 2>/dev/null | "
        "awk -v pid={} \"/^Name/ {n=\\$2} /^VmRSS/ {r=\\$2; print pid, n, r}\"'",
    )
    if rc2 == 0:
        for line in out2.strip().splitlines():
            parts = line.split()
            if len(parts) >= 3:
                try:
                    procs.append({
                        "pid": int(parts[0]),
                        "name": parts[1],
                        "vram_mib": int(parts[2]) // 1024,  # RSS is in kB
                    })
                except Exception:
                    pass

    return {
        "host": host_id,
        "available": True,
        "name": f"AMD Radeon iGPU (UMA, +{gtt_total} MiB GTT)",
        "vram_used_mib": vram_used,
        "vram_total_mib": vram_total,
        "util_pct": util,
        "temp_c": temp,
        "processes": procs,
    }


@app.get("/api/hosts/{host_id}/gpu", response_model=GpuStats)
async def host_gpu(host_id: str) -> dict:
    cfg = HOST_REGISTRY.get(host_id)
    if not cfg:
        return {"host": host_id, "available": False, "error": "unknown host"}
    if cfg.get("gpu_kind") == "amd":
        return await _host_gpu_amd(host_id, cfg)
    if cfg.get("gpu_kind") != "nvidia":
        return {"host": host_id, "available": False, "error": "no GPU configured for this host"}

    cmd = [
        "ssh", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=4",
        "-i", cfg["key_file"], f"{cfg['ssh_user']}@{cfg['ssh_host']}",
        # All three queries in one connection.
        "nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader,nounits"
        " ; echo '---PROCESSES---' ;"
        " nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits"
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=8)
    except asyncio.TimeoutError:
        return {"host": host_id, "available": False, "error": "ssh timeout"}
    except Exception as e:
        return {"host": host_id, "available": False, "error": f"{type(e).__name__}: {e}"}

    out = stdout.decode(errors="replace").strip()
    if proc.returncode != 0 or not out:
        return {"host": host_id, "available": False, "error": stderr.decode(errors="replace")[:200]}

    parts = out.split("---PROCESSES---")
    gpu_line = parts[0].strip().splitlines()[0] if parts[0].strip() else ""
    procs_block = parts[1].strip() if len(parts) > 1 else ""

    # Parse first GPU line: "NVIDIA GeForce RTX 4090, 22512, 24564, 1, 38"
    fields = [f.strip() for f in gpu_line.split(",")]
    if len(fields) < 5:
        return {"host": host_id, "available": False, "error": f"unexpected nvidia-smi output: {gpu_line[:200]}"}
    name = fields[0]
    try:
        vram_used = int(fields[1])
        vram_total = int(fields[2])
        util = int(fields[3])
        temp = int(fields[4])
    except Exception:
        return {"host": host_id, "available": False, "error": "parse failed"}

    procs: list[dict] = []
    for ln in procs_block.splitlines():
        ln = ln.strip()
        if not ln:
            continue
        cols = [c.strip() for c in ln.split(",")]
        if len(cols) < 3:
            continue
        try:
            procs.append({
                "pid": int(cols[0]),
                "name": cols[1].rsplit("/", 1)[-1],
                "vram_mib": int(cols[2]),
            })
        except Exception:
            pass

    return {
        "host": host_id,
        "available": True,
        "name": name,
        "vram_used_mib": vram_used,
        "vram_total_mib": vram_total,
        "util_pct": util,
        "temp_c": temp,
        "processes": procs,
    }


# ── Memory / Honcho proxy ────────────────────────────────────────────────


HONCHO_BASE = os.environ.get("HONCHO_BASE", "http://localhost:8000")
HONCHO_WORKSPACE = os.environ.get("HONCHO_WORKSPACE", "hermes")


@app.get("/api/memory/conclusions")
async def memory_conclusions(limit: int = 50, observed_id: str | None = None) -> dict:
    """Honcho conclusions — durable insights agents have written about peers.
    These are what `list_conclusions` MCP returns. Optional observed_id filter
    to scope to a single peer (e.g. just the user, just one of the AI agents).
    """
    import httpx
    body: dict = {"size": min(max(1, limit), 200)}
    if observed_id:
        body["filters"] = {"observed_id": observed_id}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(
                f"{HONCHO_BASE}/v3/workspaces/{HONCHO_WORKSPACE}/conclusions/list",
                json=body,
            )
            if r.status_code >= 400:
                return {"error": f"HTTP {r.status_code}: {r.text[:200]}", "items": [], "total": 0}
            data = r.json()
        return {
            "items": data.get("items", []),
            "total": data.get("total", 0),
            "page": data.get("page", 1),
            "pages": data.get("pages", 1),
        }
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}", "items": [], "total": 0}


@app.get("/api/memory/search")
async def memory_search(q: str, limit: int = 50) -> dict:
    """Naive substring search across all stored Honcho messages.
    Honcho's vector /search requires embeddings (LLM key), so this
    bypasses by client-side filtering on raw message content."""
    if not q or not q.strip():
        return {"hits": [], "query": q}
    needle = q.strip().lower()

    import httpx
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            r = await client.post(
                f"{HONCHO_BASE}/v3/workspaces/{HONCHO_WORKSPACE}/sessions/list",
                json={"limit": 50},
            )
            sessions = (r.json().get("items") or []) if r.status_code < 400 else []
        except Exception:
            sessions = []

        async def msgs_for(sid: str) -> list[dict]:
            try:
                r = await client.post(
                    f"{HONCHO_BASE}/v3/workspaces/{HONCHO_WORKSPACE}/sessions/{sid}/messages/list",
                    json={"limit": 100, "reverse": True},
                )
                return (r.json().get("items") or []) if r.status_code < 400 else []
            except Exception:
                return []

        sids = [s.get("id") for s in sessions if s.get("id")]
        results = await asyncio.gather(*(msgs_for(sid) for sid in sids))

    hits: list[dict] = []
    for sid, items in zip(sids, results):
        for m in items:
            content = m.get("content", "") or ""
            if isinstance(content, str) and needle in content.lower():
                hits.append({
                    "session_id": sid,
                    "peer_id": m.get("peer_id"),
                    "content": content,
                    "created_at": m.get("created_at"),
                    "id": m.get("id"),
                })

    def _ts(s: str) -> float:
        if not s:
            return 0
        try:
            import datetime as _dt
            s2 = s.replace("T", " ").rstrip("Z").split(".")[0]
            return _dt.datetime.strptime(s2, "%Y-%m-%d %H:%M:%S").timestamp()
        except Exception:
            return 0
    hits.sort(key=lambda h: _ts(h.get("created_at") or ""), reverse=True)
    return {"hits": hits[:limit], "query": q}


@app.get("/api/memory/overview")
async def memory_overview() -> dict:
    """Aggregate useful Honcho state for the Memory tab in one call."""
    import httpx

    async with httpx.AsyncClient(timeout=10.0) as client:
        async def post(path: str, body: dict | None = None) -> dict:
            try:
                r = await client.post(f"{HONCHO_BASE}{path}", json=body or {})
                if r.status_code >= 400:
                    return {"_error": f"HTTP {r.status_code}: {r.text[:200]}"}
                return r.json()
            except Exception as e:
                return {"_error": f"{type(e).__name__}: {e}"}

        async def get_(path: str) -> dict:
            try:
                r = await client.get(f"{HONCHO_BASE}{path}")
                if r.status_code >= 400:
                    return {"_error": f"HTTP {r.status_code}: {r.text[:200]}"}
                return r.json()
            except Exception as e:
                return {"_error": f"{type(e).__name__}: {e}"}

        ws = HONCHO_WORKSPACE
        peers, sessions, queue = await asyncio.gather(
            post(f"/v3/workspaces/{ws}/peers/list", {}),
            post(f"/v3/workspaces/{ws}/sessions/list", {"limit": 20}),
            get_(f"/v3/workspaces/{ws}/queue/status"),
        )

        # For each session, get the last few messages
        recent_messages: list[dict] = []
        if isinstance(sessions.get("items"), list):
            sids = [s.get("id") for s in sessions["items"][:5] if s.get("id")]
            msg_results = await asyncio.gather(*(
                post(
                    f"/v3/workspaces/{ws}/sessions/{sid}/messages/list",
                    {"limit": 10, "reverse": True},
                )
                for sid in sids
            ))
            for sid, mr in zip(sids, msg_results):
                items = mr.get("items") or []
                for m in items:
                    m["_session"] = sid
                    recent_messages.append(m)
            recent_messages.sort(key=lambda m: m.get("created_at", ""), reverse=True)
            recent_messages = recent_messages[:30]

        # Try peer cards (fast best-effort)
        peer_cards: dict[str, str] = {}
        if isinstance(peers.get("items"), list):
            card_results = await asyncio.gather(*(
                get_(f"/v3/workspaces/{ws}/peers/{p['id']}/card")
                for p in peers["items"]
                if p.get("id")
            ))
            for p, cr in zip(peers["items"], card_results):
                if "_error" in cr:
                    continue
                # Card shape: {"peer_card": {...}} or string
                content = cr.get("peer_card") or cr.get("content") or cr
                if isinstance(content, dict):
                    content = content.get("content") or json.dumps(content)
                if isinstance(content, str) and content.strip():
                    peer_cards[p["id"]] = content.strip()

        return {
            "workspace": ws,
            "peers": peers.get("items", []) if "_error" not in peers else [],
            "peer_cards": peer_cards,
            "sessions": sessions.get("items", []) if "_error" not in sessions else [],
            "recent_messages": recent_messages,
            "queue_status": queue if "_error" not in queue else {},
            "errors": {
                k: v.get("_error")
                for k, v in [("peers", peers), ("sessions", sessions), ("queue", queue)]
                if "_error" in v
            },
        }


# ── Service health & restart ────────────────────────────────────────────

def load_services() -> list[dict]:
    return _services_yaml.get().get("services", []) or []


def _find_service(sid: str) -> dict:
    for s in load_services():
        if s["id"] == sid:
            return s
    raise HTTPException(404, f"unknown service '{sid}'")


def _ssh_args(svc: dict) -> list[str]:
    return [
        "ssh", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5",
        "-i", svc["key_file"], f"{svc['ssh_user']}@{svc['ssh_host']}",
    ]


async def _run(cmd: list[str], timeout: float = 7.0) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return 124, "", "timeout"
    return proc.returncode or 0, stdout.decode(errors="replace"), stderr.decode(errors="replace")


def _parse_systemd_show(text: str) -> dict:
    out = {}
    for line in text.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def _uptime_text(active_enter_iso: str | None) -> str | None:
    if not active_enter_iso or active_enter_iso in ("", "0", "n/a"):
        return None
    # systemctl emits e.g. "Sat 2026-04-26 09:00:00 CDT"
    try:
        import datetime as _dt
        # Strip the day-of-week prefix if present
        s = active_enter_iso.strip()
        for prefix in ("Mon ", "Tue ", "Wed ", "Thu ", "Fri ", "Sat ", "Sun "):
            if s.startswith(prefix):
                s = s[len(prefix):]
                break
        # Drop the trailing tz word (CDT/UTC/etc.) — assume local
        parts = s.rsplit(" ", 1)
        if len(parts) == 2 and len(parts[1]) <= 5:
            s = parts[0]
        t = _dt.datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
        delta_sec = (_dt.datetime.now() - t).total_seconds()
        if delta_sec < 60: return f"{int(delta_sec)}s"
        if delta_sec < 3600: return f"{int(delta_sec // 60)}m"
        if delta_sec < 86400: return f"{int(delta_sec // 3600)}h"
        return f"{int(delta_sec // 86400)}d"
    except Exception:
        return None


async def _query_systemd_local(svc: dict) -> dict:
    rc, out, _ = await _run(
        ["systemctl", "--user", "show", svc["unit"],
         "-p", "ActiveState", "-p", "SubState", "-p", "ActiveEnterTimestamp",
         "-p", "LoadState"],
    )
    info = _parse_systemd_show(out)
    rc_log, log_out, _ = await _run(
        ["journalctl", "--user", "-u", svc["unit"], "-n", "5", "--no-pager", "-o", "cat"],
    )
    return {
        "id": svc["id"],
        "name": svc["name"],
        "host": svc.get("host", "localhost"),
        "kind": svc.get("kind", "normal"),
        "type": "systemd",
        "active": info.get("ActiveState") == "active",
        "state": info.get("ActiveState", "unknown"),
        "sub_state": info.get("SubState"),
        "uptime": _uptime_text(info.get("ActiveEnterTimestamp")),
        "log_tail": [l for l in log_out.splitlines()[-5:] if l.strip()] if rc_log == 0 else [],
        "description": svc.get("description", ""),
    }


async def _query_systemd_remote(svc: dict) -> dict:
    cmd = _ssh_args(svc) + [
        f"systemctl --user show {svc['unit']!s} -p ActiveState -p SubState -p ActiveEnterTimestamp -p LoadState; "
        f"echo '----LOGSEP----'; "
        f"journalctl --user -u {svc['unit']!s} -n 5 --no-pager -o cat"
    ]
    rc, out, err = await _run(cmd, timeout=10.0)
    show_text, _, log_text = out.partition("----LOGSEP----")
    info = _parse_systemd_show(show_text)
    return {
        "id": svc["id"],
        "name": svc["name"],
        "host": svc.get("host", svc.get("ssh_host", "?")),
        "kind": svc.get("kind", "normal"),
        "type": "systemd",
        "active": info.get("ActiveState") == "active",
        "state": info.get("ActiveState", "unknown" if rc == 0 else "unreachable"),
        "sub_state": info.get("SubState"),
        "uptime": _uptime_text(info.get("ActiveEnterTimestamp")),
        "log_tail": [l for l in log_text.splitlines()[-5:] if l.strip()],
        "description": svc.get("description", ""),
    }


async def _query_docker_local(svc: dict) -> dict:
    name = svc["container"]
    # `.State.Health` is nil for containers with no healthcheck — guard with if.
    fmt = "{{.State.Status}}|{{.State.StartedAt}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}"
    rc, out, _ = await _run(
        ["sg", "docker", "-c", f"docker inspect --format '{fmt}' {name}"],
    )
    parts = out.strip().split("|") if rc == 0 else []
    status = parts[0] if parts else "unknown"
    started = parts[1] if len(parts) > 1 else ""
    health = parts[2] if len(parts) > 2 else ""
    # Tail last 5 lines of container logs
    rc_log, log_out, _ = await _run(
        ["sg", "docker", "-c", f"docker logs --tail 5 {name} 2>&1"],
        timeout=5.0,
    )
    uptime = None
    if started and started != "0001-01-01T00:00:00Z":
        try:
            import datetime as _dt
            t = _dt.datetime.fromisoformat(started.replace("Z", "+00:00"))
            delta = (_dt.datetime.now(_dt.timezone.utc) - t).total_seconds()
            if delta < 60: uptime = f"{int(delta)}s"
            elif delta < 3600: uptime = f"{int(delta // 60)}m"
            elif delta < 86400: uptime = f"{int(delta // 3600)}h"
            else: uptime = f"{int(delta // 86400)}d"
        except Exception:
            uptime = None
    return {
        "id": svc["id"],
        "name": svc["name"],
        "host": svc.get("host", "localhost"),
        "kind": svc.get("kind", "normal"),
        "type": "docker",
        "active": status == "running",
        "state": status,
        "sub_state": health or None,
        "uptime": uptime,
        "log_tail": [l for l in log_out.splitlines()[-5:] if l.strip()],
        "description": svc.get("description", ""),
    }


@app.get("/api/services")
async def list_service_status():
    services = load_services()
    if not services:
        return []
    async def query(s: dict) -> dict:
        try:
            t = s.get("type")
            if t == "systemd_user_local":
                return await _query_systemd_local(s)
            if t == "systemd_user_remote":
                return await _query_systemd_remote(s)
            if t == "docker_local":
                return await _query_docker_local(s)
            return {
                "id": s["id"], "name": s["name"], "host": s.get("host", "?"),
                "kind": s.get("kind", "normal"), "type": t or "unknown",
                "active": False, "state": "unsupported", "sub_state": None,
                "uptime": None, "log_tail": [], "description": s.get("description", ""),
            }
        except Exception as e:
            return {
                "id": s["id"], "name": s["name"], "host": s.get("host", "?"),
                "kind": s.get("kind", "normal"), "type": s.get("type", "?"),
                "active": False, "state": "error", "sub_state": str(e)[:80],
                "uptime": None, "log_tail": [], "description": s.get("description", ""),
            }
    return await asyncio.gather(*(query(s) for s in services))


class RestartBody(BaseModel):
    confirm: bool = False


@app.post("/api/services/{service_id}/restart")
async def restart_service(service_id: str, body: RestartBody):
    svc = _find_service(service_id)
    if svc.get("kind") == "critical" and not body.confirm:
        raise HTTPException(409, "critical service — pass confirm:true to restart")

    t = svc.get("type")
    if t == "systemd_user_local":
        rc, out, err = await _run(["systemctl", "--user", "restart", svc["unit"]], timeout=15.0)
    elif t == "systemd_user_remote":
        rc, out, err = await _run(
            _ssh_args(svc) + [f"systemctl --user restart {svc['unit']!s}"],
            timeout=20.0,
        )
    elif t == "docker_local":
        rc, out, err = await _run(
            ["sg", "docker", "-c", f"docker restart {svc['container']}"],
            timeout=20.0,
        )
    else:
        raise HTTPException(400, f"unsupported service type {t!r}")
    return {"ok": rc == 0, "rc": rc, "stdout": out[-200:], "stderr": err[-200:]}


# ── Scratchpad (shared markdown notes) ──────────────────────────────────


class ScratchpadBody(BaseModel):
    content: str


@app.get("/api/scratchpad")
def read_scratchpad() -> dict:
    if not SCRATCHPAD_FILE.is_file():
        SCRATCHPAD_FILE.write_text("# Scratch pad\n\n")
    stat = SCRATCHPAD_FILE.stat()
    return {
        "content": SCRATCHPAD_FILE.read_text(),
        "modified_ts": int(stat.st_mtime),
        "size": stat.st_size,
    }


@app.post("/api/scratchpad")
def write_scratchpad(body: ScratchpadBody) -> dict:
    SCRATCHPAD_FILE.write_text(body.content)
    stat = SCRATCHPAD_FILE.stat()
    return {
        "ok": True,
        "modified_ts": int(stat.st_mtime),
        "size": stat.st_size,
    }


# ── Model inspector (llama-server props + runtime flags) ───────────────


_MODEL_FLAG_KEYS = [
    "model", "alias", "ctx-size", "n-gpu-layers", "cache-type-k", "cache-type-v",
    "flash-attn", "mlock", "no-mmap", "n-predict", "temp", "top-k", "top-p",
    "min-p", "repeat-penalty", "n-ubatch", "n-batch", "parallel",
]


_BOOL_LLAMA_FLAGS = {"mlock", "no-mmap", "no-warmup", "verbose", "embedding"}


def _parse_llama_flags(exec_start: str) -> dict:
    """Pull a subset of CLI flags out of a llama-server ExecStart line.
    `--flag value` → {flag: value}. Boolean flags → {flag: True}. We only
    surface flags listed in _MODEL_FLAG_KEYS. Treat any token starting with
    '-' as a flag-not-a-value, to avoid eating short flags like `-np`."""
    parts = exec_start.split()
    out: dict[str, object] = {}
    i = 0
    while i < len(parts):
        p = parts[i]
        if p.startswith("--"):
            key = p[2:]
            next_tok = parts[i + 1] if i + 1 < len(parts) else None
            takes_value = (
                next_tok is not None
                and not next_tok.startswith("-")
                and key not in _BOOL_LLAMA_FLAGS
            )
            if takes_value:
                if key in _MODEL_FLAG_KEYS:
                    out[key] = next_tok
                i += 2
                continue
            else:
                if key in _MODEL_FLAG_KEYS or key in _BOOL_LLAMA_FLAGS:
                    out[key] = True
                i += 1
                continue
        i += 1
    return out


@app.get("/api/agents/{agent_id}/model")
async def agent_model(agent_id: str) -> dict:
    agent = find_agent(agent_id)
    llama_url = agent.get("llama_url")
    if not llama_url:
        return {"available": False, "reason": "no llama_url configured (push-only agent?)"}

    props: dict = {}
    slots: list = []
    is_processing = False
    n_ctx = None
    model_path = None
    model_alias = None
    build_info = None

    import httpx
    async with httpx.AsyncClient(timeout=4.0) as client:
        try:
            r = await client.get(f"{llama_url}/props")
            if r.status_code == 200:
                props = r.json()
                model_path = props.get("model_path")
                model_alias = props.get("model_alias")
                build_info = props.get("build_info")
        except Exception as e:
            return {"available": False, "reason": f"props fetch failed: {e}"}
        try:
            r = await client.get(f"{llama_url}/slots")
            if r.status_code == 200:
                slots = r.json() or []
                if slots:
                    s0 = slots[0]
                    n_ctx = s0.get("n_ctx")
                    is_processing = bool(s0.get("is_processing"))
        except Exception:
            pass

    # Pull runtime flags from the systemd ExecStart, plus model file size
    flags: dict = {}
    file_size_bytes: int | None = None
    unit = agent.get("llama_unit", "llama-server.service")
    is_local = agent.get("host", "localhost") == "localhost"
    ssh = None if is_local else [
        "ssh", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5",
        "-i", agent["key_file"], f"{agent['user']}@{agent['host']}",
    ]
    try:
        cmd = f"systemctl --user show {unit} -p ExecStart --no-pager"
        if ssh:
            proc = await asyncio.create_subprocess_exec(
                *ssh, cmd,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
        else:
            proc = await asyncio.create_subprocess_shell(
                cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=6.0)
        out = stdout.decode(errors="replace")
        # ExecStart line like: ExecStart={ path=...; argv[]=... }
        m = re.search(r"argv\[]=([^;]+)", out)
        if m:
            flags = _parse_llama_flags(m.group(1))
    except Exception:
        pass

    if model_path:
        try:
            cmd = f"stat -c '%s' {model_path!s}"
            if ssh:
                proc = await asyncio.create_subprocess_exec(
                    *ssh, cmd,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                )
            else:
                proc = await asyncio.create_subprocess_shell(
                    cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=4.0)
            sz = stdout.decode(errors="replace").strip()
            if sz.isdigit():
                file_size_bytes = int(sz)
        except Exception:
            pass

    # Parse quantization from filename (e.g. carnice-v2-27b-Q4_K_M.gguf → Q4_K_M)
    quant = None
    if model_path:
        fname = model_path.rsplit("/", 1)[-1]
        m = re.search(r"(Q[0-9]+_[A-Z0-9_]+|TQ[0-9]+_[0-9])", fname)
        if m:
            quant = m.group(1)

    return {
        "available": True,
        "agent_id": agent_id,
        "model_alias": model_alias,
        "model_path": model_path,
        "quant": quant,
        "file_size_bytes": file_size_bytes,
        "n_ctx": n_ctx,
        "build": build_info,
        "is_processing": is_processing,
        "n_slots": len(slots),
        "flags": flags,
    }


# ── Process inspector / killer ──────────────────────────────────────────


@app.get("/api/hosts/{host_id}/processes")
async def host_processes(host_id: str, sort: str = "mem", limit: int = 10) -> dict:
    cfg = HOST_REGISTRY.get(host_id)
    if not cfg:
        raise HTTPException(404, f"unknown host: {host_id}")
    sort_flag = "-pmem" if sort == "mem" else "-pcpu"
    # comm + args separated by ASCII unit separator (\x1f) so we can split
    # safely even when args contains spaces.
    awk = (
        "ps -eo pid,user,pcpu,pmem,rss,etime,comm,args --no-headers --sort=" + sort_flag +
        " | head -n " + str(int(max(1, min(50, limit))))
    )
    rc, out, _ = await _ssh_or_local_run(cfg, awk)
    if rc != 0 and not out.strip():
        return {"host": host_id, "available": False, "processes": []}
    rows: list[dict] = []
    for line in out.splitlines():
        line = line.rstrip("\n")
        if not line.strip():
            continue
        # 7 leading whitespace-separated fields, then args (rest of line)
        parts = line.split(None, 7)
        if len(parts) < 8:
            continue
        try:
            pid = int(parts[0])
            user = parts[1]
            pcpu = float(parts[2])
            pmem = float(parts[3])
            rss_kb = int(parts[4])
            etime = parts[5]
            comm = parts[6]
            args = parts[7]
            rows.append({
                "pid": pid,
                "user": user,
                "cpu_pct": round(pcpu, 1),
                "mem_pct": round(pmem, 1),
                "rss_mb": round(rss_kb / 1024, 1),
                "etime": etime,
                "comm": comm,
                "args": args[:160],
            })
        except (ValueError, IndexError):
            continue
    return {
        "host": host_id,
        "available": True,
        "ssh_user": cfg.get("ssh_user"),
        "processes": rows,
    }


class KillBody(BaseModel):
    signal: str = "TERM"  # or KILL


@app.post("/api/hosts/{host_id}/processes/{pid}/kill")
async def host_kill(host_id: str, pid: int, body: KillBody):
    cfg = HOST_REGISTRY.get(host_id)
    if not cfg:
        raise HTTPException(404, f"unknown host: {host_id}")
    sig = body.signal.upper()
    if sig not in ("TERM", "KILL", "INT", "HUP"):
        raise HTTPException(400, f"unsupported signal: {sig}")
    # Safety check: only allow killing processes owned by the SSH user.
    # We re-check ownership server-side before issuing the kill.
    ssh_user = cfg.get("ssh_user")
    user_check = (
        f"if [ $(id -u) -ne 0 ]; then "
        f"  OWNER=$(ps -o user= -p {int(pid)} 2>/dev/null); "
        f"  if [ \"$OWNER\" != \"$USER\" ]; then echo NOT_OWNED >&2; exit 3; fi; "
        f"fi; "
        f"kill -s {sig} {int(pid)}"
    )
    rc, out, err = await _ssh_or_local_run(cfg, user_check)
    if rc == 3 or "NOT_OWNED" in err:
        raise HTTPException(
            403, f"refused: PID {pid} not owned by {ssh_user or 'service user'}"
        )
    return {"ok": rc == 0, "rc": rc, "stderr": err[:200]}


# ── Network ping matrix ─────────────────────────────────────────────────

# Sources (ssh-reachable) × Targets. Built dynamically from machines.yaml.
def _build_ping_sources() -> list[dict]:
    sources = []
    local_id = os.environ.get("KVM_HUB_LOCAL_MACHINE", "")
    for m in load_machines():
        is_local = (m["id"] == local_id or m.get("hostname") in ("localhost", "127.0.0.1"))
        sources.append({
            "id": m["id"], "label": m.get("name", m["id"]),
            "ssh": None if is_local else True,
            "ssh_user": m.get("username"), "ssh_host": m.get("hostname"),
            "key_file": m.get("key_file"),
        })
    return sources

def _build_ping_targets() -> list[dict]:
    return [{"id": m["id"], "label": m.get("name", m["id"]),
             "ip": m.get("lan_ip") or m.get("hostname")}
            for m in load_machines()]

_PING_CACHE: dict[str, tuple[float, dict]] = {}
_PING_TTL = 25.0


async def _matrix_ping_one(src: dict, target_ip: str) -> float | None:
    """Run a single ping from `src` to `target_ip`. Returns ms or None on failure."""
    cmd = f"ping -c 1 -W 2 -q {target_ip} 2>/dev/null | awk -F'/' '/rtt/ {{print $5}}'"
    if src.get("ssh_host") is None:
        proc = await asyncio.create_subprocess_shell(
            cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
    else:
        proc = await asyncio.create_subprocess_exec(
            "ssh", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=4",
            "-i", src["key_file"], f"{src['ssh_user']}@{src['ssh_host']}",
            cmd,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=6.0)
    except asyncio.TimeoutError:
        try: proc.kill()
        except Exception: pass
        return None
    s = stdout.decode(errors="replace").strip()
    try:
        return float(s) if s else None
    except Exception:
        return None


@app.get("/api/network/ping")
async def network_ping_matrix() -> dict:
    """3×N matrix of ping latencies. Cached 25s."""
    now = time.time()
    cached = _PING_CACHE.get("all")
    if cached and (now - cached[0]) < _PING_TTL:
        return cached[1]

    ping_sources = _build_ping_sources()
    ping_targets = _build_ping_targets()

    async def row_for(src: dict) -> dict:
        cells = await asyncio.gather(*(
            _matrix_ping_one(src, t["ip"])
            for t in ping_targets
            if t["id"] != src["id"]  # skip self-ping
        ))
        out = {}
        i = 0
        for t in ping_targets:
            if t["id"] == src["id"]:
                out[t["id"]] = None  # self
            else:
                out[t["id"]] = cells[i]
                i += 1
        return out

    rows = await asyncio.gather(*(row_for(s) for s in ping_sources))
    result = {
        "sources": [{"id": s["id"], "label": s["label"]} for s in ping_sources],
        "targets": [{"id": t["id"], "label": t["label"]} for t in ping_targets],
        "matrix": {
            ping_sources[i]["id"]: rows[i] for i in range(len(ping_sources))
        },
        "captured_ts": int(now),
    }
    _PING_CACHE["all"] = (now, result)
    return result


# ── Cron / scheduled work (unified view) ────────────────────────────────


def _next_cron_run(expr: str) -> int | None:
    """Compute next-run unix ts from a cron expression."""
    try:
        from croniter import croniter
        return int(croniter(expr, time.time()).get_next())
    except Exception:
        return None


def _build_cron_sources() -> list[dict]:
    """Build cron sources dynamically from agents.yaml + machines.yaml."""
    sources = [{"id": "local", "label": "Local", "ssh": None}]
    for ag in (_agents_yaml.get().get("agents", []) or []):
        mcfg = None
        for m in load_machines():
            if m.get("hostname") == ag.get("host") or m.get("id") == ag.get("host"):
                mcfg = m
                break
        sources.append({
            "id": ag["id"],
            "label": ag.get("name", ag["id"]),
            "ssh_user": ag.get("user") or (mcfg or {}).get("username"),
            "ssh_host": ag.get("host"),
            "key_file": ag.get("key_file") or (mcfg or {}).get("key_file"),
            "hermes_bin": "hermes",
        })
    return sources


CRON_SOURCES = type("_CronProxy", (), {
    "__iter__": lambda s: iter(_build_cron_sources()),
    "__len__": lambda s: len(_build_cron_sources()),
})()


async def _ssh_cmd(src: dict, command: str) -> tuple[int, str, str]:
    if not src.get("ssh_host"):
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
    else:
        proc = await asyncio.create_subprocess_exec(
            "ssh", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5",
            "-i", src["key_file"], f"{src['ssh_user']}@{src['ssh_host']}",
            command,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=8.0)
    except asyncio.TimeoutError:
        proc.kill()
        return 124, "", "timeout"
    return proc.returncode or 0, stdout.decode(errors="replace"), stderr.decode(errors="replace")


def _parse_crontab(text: str, host: str) -> list[dict]:
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # 5-field cron expression + command
        parts = line.split(maxsplit=5)
        if len(parts) < 6:
            continue
        expr = " ".join(parts[:5])
        cmd = parts[5]
        out.append({
            "source": "crontab",
            "host": host,
            "schedule": expr,
            "command": cmd,
            "description": cmd.split()[0] if cmd else "",
            "next_run_ts": _next_cron_run(expr),
        })
    return out


def _parse_hermes_cron(text: str, host: str) -> list[dict]:
    """Parse the textual output of `hermes cron list`. Format varies; we
    accept tabular or one-per-block forms by scanning for cron expressions
    and target hints. Any line starting with a 5-field expression counts."""
    import re
    out = []
    cron_re = re.compile(r"^\s*([\*\d/,-]+\s+[\*\d/,-]+\s+[\*\d/,-]+\s+[\*\d/,-]+\s+[\*\d/,-]+)\s+(.+)$")
    for line in text.splitlines():
        m = cron_re.match(line)
        if m:
            expr, rest = m.group(1).strip(), m.group(2).strip()
            out.append({
                "source": "hermes",
                "host": host,
                "schedule": expr,
                "command": rest,
                "description": rest[:60],
                "next_run_ts": _next_cron_run(expr),
            })
    return out


def _parse_systemd_timers(text: str, host: str) -> list[dict]:
    """Parse `systemctl --user list-timers --no-pager` output."""
    out = []
    # Skip header line and blank/footer lines
    for line in text.splitlines()[1:]:
        s = line.strip()
        if not s or s.startswith("Pass") or s.endswith("listed."):
            continue
        # Skip noise — snap/firmware/launchpadlib are uninteresting
        if any(noise in s for noise in ("snap.", "launchpadlib-cache")):
            continue
        # Lines look like: "Sun 2026-04-26 12:00:00 CDT  2h 8min  ...  unit  service"
        # Easiest path: extract the unit name (penultimate token) and a timestamp prefix
        toks = s.split()
        if len(toks) < 6:
            continue
        unit = toks[-2]
        # Find the date in the line (4 toks: dow, YYYY-MM-DD, HH:MM:SS, TZ)
        next_dt = " ".join(toks[0:4])
        out.append({
            "source": "systemd",
            "host": host,
            "schedule": "timer",
            "command": unit,
            "description": next_dt,
            "next_run_ts": None,
        })
    return out


@app.get("/api/cron")
async def cron_overview() -> list[dict]:
    jobs: list[dict] = []
    for src in CRON_SOURCES:
        # crontab
        rc, out, _ = await _ssh_cmd(src, "crontab -l 2>/dev/null || true")
        if out.strip():
            jobs.extend(_parse_crontab(out, src["id"]))
        # hermes cron (only on hermes hosts)
        if "hermes_bin" in src:
            rc, out, _ = await _ssh_cmd(
                src, f"{src['hermes_bin']} cron list 2>&1 || true",
            )
            if out and "No scheduled" not in out:
                jobs.extend(_parse_hermes_cron(out, src["id"]))
        # systemd user timers (only meaningful on natalie since the others
        # mostly carry stock snap timers)
        if src["id"] == "natalie":
            rc, out, _ = await _ssh_cmd(
                src, "systemctl --user list-timers --no-pager 2>&1 || true",
            )
            jobs.extend(_parse_systemd_timers(out, src["id"]))
    # Sort by next_run when available, else by schedule string
    now_ts = int(time.time())
    for j in jobs:
        j["due_in_sec"] = (
            (j["next_run_ts"] - now_ts) if j.get("next_run_ts") else None
        )
    jobs.sort(key=lambda j: (j["due_in_sec"] is None, j.get("due_in_sec") or 0))
    return jobs


# ── Activity feed (cross-source aggregation) ────────────────────────────


@app.get("/api/activity")
async def activity_feed(limit: int = 80) -> dict:
    """Aggregate fleet-wide events into a single chronological stream:
    Honcho-stored messages + task transitions. Sorted newest-first.
    """
    import httpx

    events: list[dict] = []

    # 1. Honcho messages (already cross-session)
    async with httpx.AsyncClient(timeout=8.0) as client:
        try:
            r = await client.post(
                f"{HONCHO_BASE}/v3/workspaces/{HONCHO_WORKSPACE}/sessions/list",
                json={"limit": 10},
            )
            sessions = (r.json().get("items") or []) if r.status_code < 400 else []
        except Exception:
            sessions = []

        async def msgs_for(sid: str) -> list[dict]:
            try:
                r = await client.post(
                    f"{HONCHO_BASE}/v3/workspaces/{HONCHO_WORKSPACE}/sessions/{sid}/messages/list",
                    json={"limit": 30, "reverse": True},
                )
                return (r.json().get("items") or []) if r.status_code < 400 else []
            except Exception:
                return []

        sids = [s.get("id") for s in sessions if s.get("id")]
        msg_results = await asyncio.gather(*(msgs_for(sid) for sid in sids))
        for sid, items in zip(sids, msg_results):
            for m in items:
                events.append({
                    "type": "message",
                    "ts": m.get("created_at"),
                    "peer_id": m.get("peer_id"),
                    "session_id": sid,
                    "content": m.get("content", ""),
                })

    # 2. Task transitions — derived from tasks.db updated_at
    try:
        with sqlite3.connect(TASKS_DB_FILE) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        for r in rows:
            events.append({
                "type": "task",
                "ts": r["updated_at"],
                "task_id": r["id"],
                "title": r["title"],
                "owner_agent": r["owner_agent"],
                "status": r["status"],
                "created_at": r["created_at"],
            })
    except Exception:
        pass

    def _parse_ts(s: str) -> float:
        if not s:
            return 0
        # Handle both "2026-04-26 03:34:27" and ISO-with-Z
        try:
            import datetime as _dt
            s2 = s.replace("T", " ").rstrip("Z").split(".")[0]
            return _dt.datetime.strptime(s2, "%Y-%m-%d %H:%M:%S").timestamp()
        except Exception:
            return 0

    events.sort(key=lambda e: _parse_ts(e.get("ts") or ""), reverse=True)
    return {"events": events[:limit]}


# ── Self-hosted tweb (Telegram Web K) static serve ─────────────────────
# We build the open-source `tweb` SPA (github.com/morethanwords/tweb) into
# Self-hosted tweb dist served at /tg/. This avoids the brittleness of
# reverse-proxying the official web.telegram.org (origin checks, service-worker
# scope, baked-in API credentials). The SPA uses MTProto-over-WebSocket
# directly from the browser to Telegram's data centres, which works from any
# origin.

TWEB_DIST = Path(os.environ.get("TWEB_DIST", str(ROOT.parent / "tweb" / "public")))


_TWEB_ASSET_EXTS = {
    ".js", ".mjs", ".css", ".map", ".json", ".woff", ".woff2", ".ttf",
    ".otf", ".eot", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
    ".ico", ".mp4", ".webm", ".wasm", ".tgs",
}


@app.get("/tg/{path:path}")
def telegram_static(path: str = "") -> FileResponse:
    """Serve the bundled tweb client. SPA fallback only fires for non-asset
    paths so missing asset URLs get a real 404 instead of HTML — otherwise
    browsers cache the HTML for asset URLs and OTS-parse it as a font/script
    on subsequent loads."""
    target = TWEB_DIST / path if path else TWEB_DIST / "index.html"
    if path and target.is_file():
        # Service workers must be served as application/javascript and need
        # an explicit scope header so they can control the /tg/ subtree.
        if path.endswith(".js"):
            return FileResponse(
                target,
                media_type="application/javascript",
                headers={"Service-Worker-Allowed": "/tg/"},
            )
        return FileResponse(target)
    # If the request looked like an asset, return 404 instead of falling
    # through to index.html. Otherwise the browser caches HTML at the asset
    # URL and breaks every subsequent reference until the cache is purged.
    if path:
        ext = Path(path).suffix.lower()
        if ext in _TWEB_ASSET_EXTS:
            raise HTTPException(404, detail=f"asset not found: {path}")
    # SPA fallback for client-side routes
    return FileResponse(TWEB_DIST / "index.html")


@app.get("/tg")
def telegram_index_redirect():
    return Response(
        status_code=307,
        headers={"Location": "/tg/"},
    )


# -- Config CRUD API --------------------------------------------------------
# Endpoints for managing machines, agents, and services via the UI.
# Reads/writes the YAML files and forces cache refresh on write.

SETTINGS_FILE = ROOT / "settings.yaml"
_settings_yaml = _YamlCache(SETTINGS_FILE, ttl=10.0)


def _atomic_yaml_write(path: Path, key: str, data: list[dict]) -> None:
    """Write a YAML list atomically and refresh the cache."""
    content = yaml.dump({key: data}, default_flow_style=False, allow_unicode=True, sort_keys=False)
    tmp = path.with_suffix(".yaml.tmp")
    tmp.write_text(content)
    os.replace(str(tmp), str(path))
    # Force cache refresh
    for cache in (_machines_yaml, _agents_yaml, _services_yaml, _settings_yaml):
        if cache.path == path:
            cache._refresh()
            break


class MachineConfig(BaseModel):
    id: str
    name: str
    icon: str = "desktop"
    role: str = ""
    protocol: str = "ssh"
    hostname: str = ""
    lan_ip: str = ""
    mac: str = ""
    username: str = ""
    key_file: str = ""
    password: str | None = None


class AgentConfig(BaseModel):
    id: str
    name: str
    short: str = ""
    role: str = ""
    host: str = ""
    user: str = ""
    key_file: str = ""
    log_path: str = ""
    sessions_glob: str = ""
    model: str = ""
    icon: str = "brain"
    api_server_url: str = ""
    llama_url: str = ""
    llama_unit: str = ""
    telegram_bot_token_env: str = ""
    telegram_chat_id: str = ""


class ServiceConfig(BaseModel):
    id: str
    name: str
    host: str = ""
    type: str = "systemd_user_local"
    unit: str = ""
    container: str = ""
    ssh_user: str = ""
    ssh_host: str = ""
    key_file: str = ""
    kind: str = "normal"
    description: str = ""


class SshTestRequest(BaseModel):
    hostname: str
    username: str
    key_file: str = ""
    password: str | None = None


# ── Machines CRUD ──

@app.get("/api/config/machines")
async def config_list_machines():
    return load_machines()


@app.post("/api/config/machines")
async def config_create_machine(cfg: MachineConfig):
    machines = load_machines()
    if any(m["id"] == cfg.id for m in machines):
        raise HTTPException(409, f"machine '{cfg.id}' already exists")
    machines.append(cfg.model_dump(exclude_none=True))
    _atomic_yaml_write(MACHINES_FILE, "machines", machines)
    return {"ok": True, "id": cfg.id}


@app.put("/api/config/machines/{machine_id}")
async def config_update_machine(machine_id: str, cfg: MachineConfig):
    machines = load_machines()
    idx = next((i for i, m in enumerate(machines) if m["id"] == machine_id), None)
    if idx is None:
        raise HTTPException(404, f"machine '{machine_id}' not found")
    machines[idx] = cfg.model_dump(exclude_none=True)
    _atomic_yaml_write(MACHINES_FILE, "machines", machines)
    return {"ok": True}


@app.delete("/api/config/machines/{machine_id}")
async def config_delete_machine(machine_id: str):
    machines = load_machines()
    before = len(machines)
    machines = [m for m in machines if m["id"] != machine_id]
    if len(machines) == before:
        raise HTTPException(404, f"machine '{machine_id}' not found")
    _atomic_yaml_write(MACHINES_FILE, "machines", machines)
    return {"ok": True}


# ── Agents CRUD ──

def _load_agents() -> list[dict]:
    return _agents_yaml.get().get("agents", []) or []


@app.get("/api/config/agents")
async def config_list_agents():
    return _load_agents()


@app.post("/api/config/agents")
async def config_create_agent(cfg: AgentConfig):
    agents = _load_agents()
    if any(a["id"] == cfg.id for a in agents):
        raise HTTPException(409, f"agent '{cfg.id}' already exists")
    agents.append(cfg.model_dump(exclude_none=True))
    _atomic_yaml_write(AGENTS_FILE, "agents", agents)
    return {"ok": True, "id": cfg.id}


@app.put("/api/config/agents/{agent_id}")
async def config_update_agent(agent_id: str, cfg: AgentConfig):
    agents = _load_agents()
    idx = next((i for i, a in enumerate(agents) if a["id"] == agent_id), None)
    if idx is None:
        raise HTTPException(404, f"agent '{agent_id}' not found")
    agents[idx] = cfg.model_dump(exclude_none=True)
    _atomic_yaml_write(AGENTS_FILE, "agents", agents)
    return {"ok": True}


@app.delete("/api/config/agents/{agent_id}")
async def config_delete_agent(agent_id: str):
    agents = _load_agents()
    before = len(agents)
    agents = [a for a in agents if a["id"] != agent_id]
    if len(agents) == before:
        raise HTTPException(404, f"agent '{agent_id}' not found")
    _atomic_yaml_write(AGENTS_FILE, "agents", agents)
    return {"ok": True}


# ── Services CRUD ──

def _load_services_raw() -> list[dict]:
    return _services_yaml.get().get("services", []) or []


@app.get("/api/config/services")
async def config_list_services_raw():
    return _load_services_raw()


@app.post("/api/config/services")
async def config_create_service(cfg: ServiceConfig):
    services = _load_services_raw()
    if any(s["id"] == cfg.id for s in services):
        raise HTTPException(409, f"service '{cfg.id}' already exists")
    services.append(cfg.model_dump(exclude_none=True))
    _atomic_yaml_write(SERVICES_FILE, "services", services)
    return {"ok": True, "id": cfg.id}


@app.put("/api/config/services/{service_id}")
async def config_update_service(service_id: str, cfg: ServiceConfig):
    services = _load_services_raw()
    idx = next((i for i, s in enumerate(services) if s["id"] == service_id), None)
    if idx is None:
        raise HTTPException(404, f"service '{service_id}' not found")
    services[idx] = cfg.model_dump(exclude_none=True)
    _atomic_yaml_write(SERVICES_FILE, "services", services)
    return {"ok": True}


@app.delete("/api/config/services/{service_id}")
async def config_delete_service(service_id: str):
    services = _load_services_raw()
    before = len(services)
    services = [s for s in services if s["id"] != service_id]
    if len(services) == before:
        raise HTTPException(404, f"service '{service_id}' not found")
    _atomic_yaml_write(SERVICES_FILE, "services", services)
    return {"ok": True}


# ── General settings ──

@app.get("/api/config/general")
async def config_get_general():
    return _settings_yaml.get()


@app.put("/api/config/general")
async def config_put_general(request: Request):
    body = await request.json()
    content = yaml.dump(body, default_flow_style=False, allow_unicode=True, sort_keys=False)
    tmp = SETTINGS_FILE.with_suffix(".yaml.tmp")
    tmp.write_text(content)
    os.replace(str(tmp), str(SETTINGS_FILE))
    _settings_yaml._refresh()
    return {"ok": True}


# ── SSH connectivity test ──

@app.post("/api/config/test-ssh")
async def config_test_ssh(req: SshTestRequest):
    args = ["ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=accept-new"]
    if req.key_file:
        args += ["-i", req.key_file]
    args += [f"{req.username}@{req.hostname}", "echo ok"]
    start = time.perf_counter()
    code, stdout, stderr = await _run(args, timeout=10.0)
    elapsed = (time.perf_counter() - start) * 1000
    if code == 0 and "ok" in stdout:
        return {"ok": True, "latency_ms": round(elapsed, 1)}
    return {"ok": False, "error": stderr.strip() or stdout.strip() or "connection failed",
            "latency_ms": round(elapsed, 1)}


# ── Config status (for setup wizard) ──

@app.get("/api/config/status")
async def config_status():
    return {
        "has_machines": len(load_machines()) > 0,
        "has_agents": len(_load_agents()) > 0,
        "has_services": len(_load_services_raw()) > 0,
    }


# ── Service discovery (for setup wizard) ──

@app.post("/api/config/discover-services/{machine_id}")
async def config_discover_services(machine_id: str):
    mcfg = find_machine(machine_id)
    discovered = []

    # Probe systemd user units
    args = ["ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes"]
    if mcfg.get("key_file"):
        args += ["-i", mcfg["key_file"]]
    target = f"{mcfg.get('username', 'root')}@{mcfg['hostname']}"

    code, stdout, _ = await _run(
        args + [target, "systemctl --user list-units --type=service --state=running --no-legend --plain"],
        timeout=15.0,
    )
    if code == 0:
        for line in stdout.strip().splitlines():
            parts = line.split()
            if parts:
                unit = parts[0]
                discovered.append({
                    "id": unit.replace(".service", "").replace("@", "-"),
                    "name": unit.replace(".service", ""),
                    "type": "systemd_user_remote" if machine_id != "natalie" else "systemd_user_local",
                    "unit": unit,
                    "host": machine_id,
                    "ssh_user": mcfg.get("username", ""),
                    "ssh_host": mcfg["hostname"],
                    "key_file": mcfg.get("key_file", ""),
                })

    # Probe docker containers
    code, stdout, _ = await _run(
        args + [target, "docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null"],
        timeout=15.0,
    )
    if code == 0:
        for line in stdout.strip().splitlines():
            parts = line.split("\t")
            if len(parts) >= 1:
                name = parts[0]
                discovered.append({
                    "id": f"docker-{name}",
                    "name": name,
                    "type": "docker_local" if machine_id == "natalie" else "docker_remote",
                    "container": name,
                    "host": machine_id,
                    "description": parts[1] if len(parts) > 1 else "",
                })

    return {"machine_id": machine_id, "discovered": discovered}


# -- End Config CRUD API ---------------------------------------------------


# ── Static dashboard ─────────────────────────────────────────────────────
# Mounted last so /api routes take precedence.
if DASHBOARD_DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=DASHBOARD_DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def index(path: str = "") -> FileResponse:
        # SPA: anything that isn't a known asset returns index.html.
        target = DASHBOARD_DIST / path
        if path and target.is_file():
            # Hashed asset filenames are content-addressable, so we can let
            # browsers cache them aggressively. index.html and the manifest
            # need to revalidate every load so users always see the latest
            # bundle hash.
            media_type = None
            headers: dict[str, str] = {}
            # /assets/* is content-hashed and served by the StaticFiles mount above,
            # so this catch-all only sees root-level files: icons, manifest, splash
            # screens, large videos, index.html. Most are NOT content-hashed —
            # treating them all as immutable made stale icons stick in Safari (Brad
            # caught a stale purple PWA icon 2026-05-02 even after we redeployed).
            UNHASHED_STATIC = {
                "icon-192.png", "icon-512.png", "apple-touch-icon.png",
                "favicon-32.png", "manifest.webmanifest",
            }
            if path.endswith(".webmanifest"):
                media_type = "application/manifest+json"
                headers["Cache-Control"] = "no-cache"
            elif path == "index.html":
                headers["Cache-Control"] = "no-cache"
            elif path in UNHASHED_STATIC or path.startswith("splash/"):
                # Short revalidation window — these can change between deploys
                headers["Cache-Control"] = "public, max-age=3600, must-revalidate"
            else:
                # Large static assets (videos etc) — long cache is fine
                headers["Cache-Control"] = "public, max-age=31536000, immutable"
            return FileResponse(target, media_type=media_type, headers=headers)
        return FileResponse(
            DASHBOARD_DIST / "index.html",
            headers={"Cache-Control": "no-cache"},
        )
else:
    @app.get("/")
    def root_missing():
        return {"error": "dashboard not built. Run `npm run build` in dashboard/."}


def main():
    import uvicorn
    host = os.environ.get("KVM_HUB_HOST", "0.0.0.0")
    port = int(os.environ.get("KVM_HUB_PORT", "8090"))
    ssl_keyfile = os.environ.get("KVM_HUB_TLS_KEY") or None
    ssl_certfile = os.environ.get("KVM_HUB_TLS_CERT") or None
    uvicorn.run(
        app,
        host=host,
        port=port,
        ssl_keyfile=ssl_keyfile,
        ssl_certfile=ssl_certfile,
    )


if __name__ == "__main__":
    main()
