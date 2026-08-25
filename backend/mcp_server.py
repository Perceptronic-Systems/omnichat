#!/usr/bin/env python3

import io
import os
import tarfile
import time
import threading
import contextvars
from fastmcp import FastMCP
from sympy import sympify
import docker
from web_search import search_searxng

mcp = FastMCP("my local tools")

_docker_client = None


def _get_docker_client():
    global _docker_client
    if _docker_client is None:
        _docker_client = docker.from_env()
    return _docker_client


current_session_id: contextvars.ContextVar = contextvars.ContextVar("current_session_id", default=None)

# Security & Container Configuration
SANDBOX_IMAGE = "ubuntu:latest"
IDLE_TIMEOUT_SECONDS = 1800  # 30 minutes of inactivity before auto-destruction
CLEANUP_INTERVAL_SECONDS = 60 # Check for idle containers every minute
SANDBOX_PIDS_LIMIT = 128      # cap process count -- fork-bomb protection

# Memory store for session containers: { session_id: {"container": container_obj, "last_accessed": timestamp} }
active_sandboxes = {}
sandbox_lock = threading.Lock()


def get_or_create_session_sandbox(session_id: str):
    """
    Returns an existing container for the given session_id or spins up a new 
    hardened, persistent session container if one doesn't exist.
    """
    with sandbox_lock:
        now = time.time()
        
        if session_id in active_sandboxes:
            entry = active_sandboxes[session_id]
            try:
                # Ping container state to ensure it hasn't crashed
                entry["container"].reload()
                if entry["container"].status == "running":
                    entry["last_accessed"] = now
                    return entry["container"]
            except Exception:
                # Clean up stale reference if container died
                del active_sandboxes[session_id]

        # Spin up a long-running, hardened container for this session.
        # Everything writable is tmpfs (RAM-backed) -- nothing here ever
        # touches host disk, and it's all gone the moment the container
        # stops (idle timeout, session end, or process exit). "Persists
        # throughout your session" below means exactly that and no more:
        # not across sessions, not to disk.
        container = _get_docker_client().containers.run(
            image=SANDBOX_IMAGE,
            command="tail -f /dev/null",  # Keeps container alive for session duration
            detach=True,
            auto_remove=True,
            network_mode="none",
            tmpfs={'/tmp': 'rw,noexec,nosuid,size=128m', '/workspace': 'rw,exec,nosuid,size=512m'},
            working_dir="/workspace",
            mem_limit="512m",
            nano_cpus=1000000000,
            pids_limit=SANDBOX_PIDS_LIMIT,
            cap_drop=["ALL"],
            security_opt=["no-new-privileges:true"],
            # Non-root: network access is already fully disabled above, so
            # there's no apt/pip install capability lost by dropping root --
            # nothing here could reach a package registry either way. Root
            # only would have bought a bigger blast radius for zero benefit.
            user="1000:1000",
        )

        active_sandboxes[session_id] = {
            "container": container,
            "last_accessed": now
        }
        return container


def start_idle_janitor():
    """Background thread that destroys containers unused past the IDLE_TIMEOUT."""
    def janitor_loop():
        while True:
            time.sleep(CLEANUP_INTERVAL_SECONDS)
            now = time.time()
            expired_sessions = []

            with sandbox_lock:
                for session_id, data in active_sandboxes.items():
                    if now - data["last_accessed"] > IDLE_TIMEOUT_SECONDS:
                        expired_sessions.append((session_id, data["container"]))

            for session_id, container in expired_sessions:
                try:
                    container.stop(timeout=2)
                    print(f"[JANITOR] Evicted idle sandbox for session {session_id}")
                except Exception as e:
                    print(f"[JANITOR ERROR] Failed stopping session {session_id}: {e}")
                
                with sandbox_lock:
                    active_sandboxes.pop(session_id, None)

    thread = threading.Thread(target=janitor_loop, daemon=True)
    thread.start()

# Start background cleanup loop at startup
start_idle_janitor()


def cleanup_all_containers():
    """App tear-down hook to kill remaining containers on server shutdown."""
    with sandbox_lock:
        for session_id, data in active_sandboxes.items():
            try:
                data["container"].stop(timeout=1)
            except Exception:
                pass
        active_sandboxes.clear()


# ─── File Manager (Session-Scoped Helpers) ───────────────────────────────────


def fm_list_directory(session_id: str, path: str = "/workspace"):
    container = get_or_create_session_sandbox(session_id)
    exit_code, output = container.exec_run(["ls", "-1AF", "--", path])
    if exit_code != 0:
        return {"error": output.decode("utf-8", errors="replace").strip()}

    entries = []
    for name in output.decode("utf-8", errors="replace").splitlines():
        if not name:
            continue
        is_dir = name.endswith("/")
        entries.append({
            "name": name[:-1] if is_dir else name,
            "type": "directory" if is_dir else "file",
            "size": 0,
            "mtime": 0
        })
    entries.sort(key=lambda e: (e["type"] != "directory", e["name"].lower()))
    return {"path": path, "entries": entries}


def fm_read_file(session_id: str, path: str, max_bytes: int = 200_000):
    container = get_or_create_session_sandbox(session_id)
    try:
        stream, stat_info = container.get_archive(path)
    except docker.errors.NotFound:
        return None, {"error": f"'{path}' not found"}
    except Exception as e:
        return None, {"error": str(e)}

    tar_bytes = io.BytesIO(b"".join(stream))
    with tarfile.open(fileobj=tar_bytes) as tar:
        member = tar.getmembers()[0]
        if member.isdir():
            return None, {"error": f"'{path}' is a directory"}
        f = tar.extractfile(member)
        data = f.read(max_bytes + 1) if f else b""

    truncated = len(data) > max_bytes
    if truncated:
        data = data[:max_bytes]
    return data, {"name": os.path.basename(path.rstrip("/")), "size": stat_info.get("size"), "truncated": truncated}


def fm_write_file(session_id: str, path: str, content: bytes):
    container = get_or_create_session_sandbox(session_id)
    directory = os.path.dirname(path) or "/workspace"
    filename = os.path.basename(path)

    tar_stream = io.BytesIO()
    with tarfile.open(fileobj=tar_stream, mode="w") as tar:
        info = tarfile.TarInfo(name=filename)
        info.size = len(content)
        tar.addfile(info, io.BytesIO(content))
    tar_stream.seek(0)

    container.exec_run(["mkdir", "-p", directory])
    return container.put_archive(directory, tar_stream.getvalue())


def fm_delete_path(session_id: str, path: str):
    container = get_or_create_session_sandbox(session_id)
    if path.strip("/") in ["", "workspace"]:
        return {"error": "Refusing to delete root or workspace directory"}
    exit_code, output = container.exec_run(["rm", "-rf", path])
    if exit_code != 0:
        return {"error": output.decode("utf-8", errors="replace").strip()}
    return {"success": True}


def fm_make_directory(session_id: str, path: str):
    container = get_or_create_session_sandbox(session_id)
    exit_code, output = container.exec_run(["mkdir", "-p", path])
    if exit_code != 0:
        return {"error": output.decode("utf-8", errors="replace").strip()}
    return {"success": True}


# ─── Tools Exposed to AI Agent ──────────────────────────────────────────────


@mcp.tool()
def execute_bash(command: str, timeout: int = 30) -> str:
    """
    Executes a bash terminal command inside your own private, isolated Linux
    environment for this conversation. Network access is disabled inside
    this environment -- use the search_web tool for anything internet-
    related, since this shell cannot reach the internet at all. Files saved
    to /workspace or /tmp persist only for the duration of this chat
    session (held in memory, never written to disk) and are permanently
    destroyed when the session ends or goes idle.

    Args:
        command: The bash command string to execute in the terminal.
        timeout: Max seconds to allow command execution before cancellation (default 30).
    """
    session_id = current_session_id.get()
    if session_id is None:
        return "Error: no active session context for this tool call."

    container = get_or_create_session_sandbox(session_id)
    wrapped = f"timeout -k 2 {int(timeout)} bash -c {repr(command)}"
    exec_result = container.exec_run(f"bash -c {repr(wrapped)}", workdir="/workspace")
    output = exec_result.output.decode("utf-8", errors="replace")

    if exec_result.exit_code == 124:
        return f"[Command timed out after {timeout}s]\n{output}"
        
    return output if output.strip() else "Command executed with no output."


@mcp.tool()
def search_web(query: str, limit: int = 8) -> list[dict]:
    """Search the web using SearXNG to get up-to-date information on a topic."""
    return search_searxng(query, limit)


@mcp.tool()
def evaluate(equation: str) -> str:
    """Calculates the resulting value of a mathematical equation."""
    result = sympify(equation).evalf()
    return str(result)


async def initialize_tools():
    tools_list = []
    available_tools = {}
    mcp_tools = await mcp.list_tools()

    for tool in mcp_tools:
        tools_list.append({
            'type': 'function',
            'function': {
                'name': tool.name,
                'description': tool.description or f"Executes {tool.name}",
                'parameters': tool.parameters
            }
        })
        available_tools[tool.name] = tool.fn

    return tools_list, available_tools


if __name__ == "__main__":
    mcp.run()