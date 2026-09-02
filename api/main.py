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
