#!/usr/bin/env python3

import io
import tarfile
from fastmcp import FastMCP
from sympy import sympify
from typing import List, Dict, Any
import requests
import asyncio
from ddgs import DDGS
import os
import difflib
import requests
from web_search import _searxng_available, search_searxng
import docker

mcp = FastMCP('my local tools')

docker_client = None
sandbox_container = None

knowledge_base_folder = "/etc/omnichat_knowledge_base"

def get_sandbox():
    global docker_client, sandbox_container
    if sandbox_container is None:
        docker_client = docker.from_env()
        # Add 'volumes' to the run configuration
        sandbox_container = docker_client.containers.run(
            image="ubuntu:latest",
            command="tail -f /dev/null",
            detach=True,
            auto_remove=True,
            network_mode="bridge",
            # This binds your host path to the same path inside the container
            volumes={
                knowledge_base_folder: {
                    'bind': knowledge_base_folder,
                    'mode': 'rw'
                }
            }
        )
    return sandbox_container

def cleanup_container():
    global sandbox_container
    if sandbox_container:
        try:
            sandbox_container.stop(timeout=1)
        except Exception:
            pass

# ─── File manager (sandbox container) helpers ──────────────────────────────

def fm_list_directory(path: str = "/"):
    container = get_sandbox()
    if not path.startswith("/"):
        path = "/" + path
    exit_code, output = container.exec_run(["ls", "-1AF", "--", path])
    if exit_code != 0:
        return {"error": output.decode("utf-8", errors="replace").strip() or f"Could not list '{path}'"}
    entries = []
    for name in output.decode("utf-8", errors="replace").splitlines():
        if not name:
            continue
        is_dir = name.endswith("/")
        entries.append({"name": name[:-1] if is_dir else name, "type": "directory" if is_dir else "file", "size": 0, "mtime": 0})
    entries.sort(key=lambda e: (e["type"] != "directory", e["name"].lower()))
    return {"path": path, "entries": entries}


def fm_read_file(path: str, max_bytes: int = 200_000):
    """Read a file's bytes from the sandbox container via a tar archive."""
    container = get_sandbox()
    if not path.startswith("/"):
        path = "/" + path
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


def fm_write_file(path: str, content: bytes):
    """Write bytes to a file inside the sandbox container by uploading a tar archive."""
    container = get_sandbox()
    if not path.startswith("/"):
        path = "/" + path
    directory = os.path.dirname(path) or "/"
    filename = os.path.basename(path)

    tar_stream = io.BytesIO()
    with tarfile.open(fileobj=tar_stream, mode="w") as tar:
        info = tarfile.TarInfo(name=filename)
        info.size = len(content)
        tar.addfile(info, io.BytesIO(content))
    tar_stream.seek(0)

    container.exec_run(["mkdir", "-p", directory])
    return container.put_archive(directory, tar_stream.getvalue())


def fm_delete_path(path: str):
    """Delete a file or directory inside the sandbox container."""
    container = get_sandbox()
    if not path.startswith("/"):
        path = "/" + path
    if path.strip("/") == "":
        return {"error": "Refusing to delete root directory"}
    exit_code, output = container.exec_run(["rm", "-rf", path])
    if exit_code != 0:
        return {"error": output.decode("utf-8", errors="replace").strip()}
    return {"success": True}


def fm_make_directory(path: str):
    """Create a directory (and parents) inside the sandbox container."""
    container = get_sandbox()
    if not path.startswith("/"):
        path = "/" + path
    exit_code, output = container.exec_run(["mkdir", "-p", path])
    if exit_code != 0:
        return {"error": output.decode("utf-8", errors="replace").strip()}
    return {"success": True}

knowledge_base_folder = "/etc/omnichat_knowledge_base"

def get_files(path):
    if path == "/":
        path = ""
    paths = []
    for filename in os.listdir(f"{knowledge_base_folder}{path}"):
        file_path = f"{path}/{filename}"
        paths.append(file_path)
    return paths


@mcp.tool()
def execute_bash(command: str, timeout: int = 30) -> str:
    """
    Executes a bash terminal command inside an isolated, session-scoped Linux environment and returns STDOUT/STDERR.
    Use this to run terminal commands, inspect system files, install tools via apt/pip, or run scripts.

    Args:
        command: The bash command string to execute in the terminal.
        timeout: Max seconds to allow the command to run before it is killed (default 30).
    """
    container = get_sandbox()
    # Wrap the command with `timeout` so a hung/long-running process gets killed
    # inside the container itself, rather than blocking the exec_run call forever.
    wrapped = f"timeout -k 2 {int(timeout)} bash -c {repr(command)}"
    exec_result = container.exec_run(f"bash -c {repr(wrapped)}")
    output = exec_result.output.decode("utf-8", errors="replace")

    if exec_result.exit_code == 124:
        return f"[Command timed out after {timeout}s]\n{output}"
    return output if output.strip() else "Command executed with no output."

@mcp.tool()
def search_web(query: str, limit: int = 8) -> list[dict]:
    """
    Search the web using SearXNG to get up-to-date information on a topic.

    Args:
        query: The search terms or question to look up.
        limit: The maximum number of search results to return (default 5, max 10).
    Returns:
        A list of dicts with 'title', 'url', and 'snippet' keys drawn from
        the actual page content of each result.
    """
    return search_searxng(query, limit)


@mcp.tool()
def evaluate(equation: str) -> str:
    "Calculates the resulting value of a mathematical equation."
    result = sympify(equation).evalf()
    return result


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

    print("Tools list:")
    print(tools_list)
    return tools_list, available_tools


if __name__ == "__main__":
    mcp.run()