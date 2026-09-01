#!/usr/bin/env python3
"""Server-issued session tokens.

Replaces the old scheme of trusting a client-generated integer as a
session identifier -- that let anyone impersonate any session just by
sending the same integer, since nothing ever verified it against
something the server itself issued; any integer "worked" simply by being
used as a dict key on first use.

Tokens here are:
  - cryptographically random (secrets.token_urlsafe), not guessable
  - only ever valid if THIS server minted them -- checked against an
    in-memory registry, not just "does this key exist in a dict"
  - capacity-capped and idle-expired, so an unbounded number of sessions
    (each of which can spin up its own sandbox container -- see
    mcp_server.py) can't accumulate and exhaust the host
  - rate-limited per-IP on creation specifically, so someone can't script
    their way to filling the capacity cap and locking out real visitors

On hitting capacity, new session creation is REJECTED, never used as a
reason to evict an existing session -- silently destroying a live user's
in-progress conversation/sandbox to make room for a new anonymous request
would be its own abuse vector.
"""

import secrets
import time
import threading
from typing import Optional, Tuple

SESSION_TTL_SECONDS = 2 * 60 * 60      # 2 hours of inactivity -> expire
MAX_ACTIVE_SESSIONS = 200              # hard cap on concurrent sessions
CREATE_RATE_LIMIT_PER_IP = 5           # max session creations...
CREATE_RATE_LIMIT_WINDOW_SECONDS = 60  # ...per this many seconds, per IP

_lock = threading.Lock()
_sessions: dict = {}            # token -> {"created": ts, "last_used": ts}
_creation_attempts: dict = {}   # client_ip -> [timestamps]


def _prune_expired_locked():
    now = time.time()
    expired = [t for t, rec in _sessions.items() if now - rec["last_used"] > SESSION_TTL_SECONDS]
    for t in expired:
        _sessions.pop(t, None)


def _check_rate_limit_locked(client_ip: str) -> bool:
    now = time.time()
    attempts = _creation_attempts.setdefault(client_ip, [])
    attempts[:] = [t for t in attempts if now - t < CREATE_RATE_LIMIT_WINDOW_SECONDS]
    if len(attempts) >= CREATE_RATE_LIMIT_PER_IP:
        return False
    attempts.append(now)
    return True


def create_session(client_ip: str) -> Tuple[Optional[str], Optional[str]]:
    """Mint a new session token.

    Returns (token, None) on success, or (None, reason) on failure --
    reason is "rate_limited" or "at_capacity" so the caller can return an
    appropriate HTTP status/message.
    """
    with _lock:
        if not _check_rate_limit_locked(client_ip):
            return None, "rate_limited"
        _prune_expired_locked()
        if len(_sessions) >= MAX_ACTIVE_SESSIONS:
            return None, "at_capacity"
        token = secrets.token_urlsafe(32)
        now = time.time()
        _sessions[token] = {"created": now, "last_used": now}
        return token, None


def touch_and_validate(token: Optional[str]) -> bool:
    """Bump last_used and return True if this token is currently valid,
    False otherwise (missing, never issued, or expired)."""
    if not token:
        return False
    with _lock:
        rec = _sessions.get(token)
        if rec is None:
            return False
        now = time.time()
        if now - rec["last_used"] > SESSION_TTL_SECONDS:
            _sessions.pop(token, None)
            return False
        rec["last_used"] = now
        return True


def active_session_count() -> int:
    with _lock:
        _prune_expired_locked()
        return len(_sessions)


def get_client_ip(request_or_websocket) -> str:
    """Prefer the real client IP forwarded by nginx (X-Real-IP) over the
    immediate TCP peer, which -- since everything sits behind a reverse
    proxy -- would otherwise just be nginx's own container IP for every
    single visitor, making per-IP rate limiting meaningless (it'd become
    one shared limit across all users combined)."""
    headers = request_or_websocket.headers
    forwarded = headers.get("x-real-ip") or headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    client = getattr(request_or_websocket, "client", None)
    return client.host if client else "unknown"
