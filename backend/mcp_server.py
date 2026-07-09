#!/usr/bin/env python3

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

docker_client = docker.from_env()

sandbox_container = docker_client.containers.run(
    image="ubuntu:latest",
    command="tail -f /dev/null",
    detach=True,
    auto_remove=True,
    network_mode="bridge"
)

def cleanup_container():
    try:
        sandbox_container.stop(timeout=1)
    except Exception:
        pass

mcp = FastMCP('my local tools')

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
def execute_bash(command: str) -> str:
    """
    Executes a bash terminal command inside an isolated, session-scoped Linux environment and returns STDOUT/STDERR.
    Use this to run terminal commands, inspect system files, install tools via apt/pip, or run scripts.
    """
    exec_result = sandbox_container.exec_run(f"bash -c {repr(command)}")
    output = exec_result.output.decode("utf-8", errors="replace")
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


@mcp.tool()
def list_files(path: str = "/") -> List[str]:
    """
    Lists the files and immediate contents of a specific directory within the knowledge base.
    Use this to browse a directory's contents or the available directories within the root directory "/".

    Args:
        path (str): The relative path of the directory to list, starting from the root "/". Defaults to "/".

    Returns:
        List[str]: A list of file paths found within the directory. Returns an empty list if the path does not exist.
    """
    if path.startswith('./'):
        path = path[1:]
    full_path = path
    if full_path == "/":
        full_path = knowledge_base_folder
    else:
        full_path = f"{knowledge_base_folder}{full_path}"
    if os.path.exists(full_path):
        if os.path.isdir(full_path):
            filepaths = get_files(path)
            tool_output = filepaths
    else:
        tool_output = []
    return tool_output

def get_all_files(dir="/"):
    full_path = knowledge_base_folder
    full_path = knowledge_base_folder + dir
    files = []
    for filename in os.listdir(full_path):
        filepath = ""
        if dir != "/":
            filepath = f"{dir}/{filename}"
        else:
            filepath = f"/{filename}"
        if os.path.isdir(knowledge_base_folder + filepath):
            sub_files = get_all_files(filepath)
            files.extend(sub_files)
        else:
            files.append(filepath)
    return files

@mcp.tool()
def search_for_file(filename_query: str, limit: int) -> List[str]:
    """
    Searches for files in the knowledge base using fuzzy matching against their filenames.
    Use this when you know part of a filename but are unsure of its exact path, spelling, or extension.

    Args:
        filename_query (str): The search term or partial filename to match against.
        limit (int): The maximum number of top-matching results to return.

    Returns:
        List[Tuple[str, float]]: A sorted list of tuples containing the matched file paths and their similarity ratios (0.0 to 1.0), limited to the requested count.
    """
    results = []
    for filepath in get_all_files():
        similarity = difflib.SequenceMatcher(None, filename_query.lower(), filepath.lower()).ratio()
        results.append((filepath, similarity))
    results.sort(key=lambda x: x[1], reverse=True)
    results = results[:limit]
    return results

@mcp.tool()
def read_file(filepath: str) -> str:
    """
    Reads and returns the content of a specific file from the knowledge base.

    Args:
        filepath (str): The path of the file to read, relative to the knowledge base root (e.g., "/documents/notes.md").

    Returns:
        str: The text content of the file formatted with page details, a confirmation message for images, or an error message if the file is unsupported/missing.
    """
    if filepath.startswith('./'):
        filepath = filepath[1:]
    split_path = filepath.split("/")
    filename = split_path[-1]
    del split_path
    full_path = filepath
    full_path = f"{knowledge_base_folder}{full_path}"
    tool_output = ""
    if os.path.exists(full_path):
        if not os.path.isdir(full_path):
            file_extension = filename.split('.')[-1]
            if file_extension in ['txt', 'pdf', 'html', 'css', 'js', 'py', 'md']:
                with open(full_path, 'r', encoding='utf-8') as file:
                    tool_output = f"# page 1/1 of file \"{filename}\":\n\n{file.read()}"
            elif file_extension in ['png', 'jpg', 'jpeg']:
                tool_output = f"Succesfully displayed image: \"{filename}\""
            else:
                tool_output = f"Error, the open_file tool call does not support files of type \"{file_extension}\"."
        else:
            tool_output = f"The item \"{filename}\" is a directory, you may use the \"list_files\" tool call to view it's contents."

    else:
        tool_output = f"Error, no such path \"{filepath}\" was found in in the direcory, use the \"list_files\" tool call to find available file paths to choose from."
    return tool_output


async def initialize_tools():
    tools_list = []
    available_tools = {}
    for tool in await mcp.list_tools():
        tools_list.append({
            'type': 'function',
            'function': {
                'name': tool.name,
                'description': tool.description or f"Executes {tool.name}",
                'parameters': tool.parameters
            }
        })

    available_tools = {tool.name: tool.fn for tool in await mcp.list_tools()}
    return tools_list, available_tools


if __name__ == "__main__":
    mcp.run()