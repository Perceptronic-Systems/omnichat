import os
from vector import retriever, query_pages
from sympy import sympify
import difflib
import requests
from bs4 import BeautifulSoup
import ipaddress
from urllib.parse import urlparse
import time

knowledge_base_folder = "knowledge_base"

# Any web queries with the following words will be blocked, this ensures that Jarvis doesn't accidentally query for personal information or return harmful content.
blocked_personal = []
BANNED_WORDS = []

def get_files(path):
    if path == "/":
        path = ""
    paths = []
    for filename in os.listdir(f"{knowledge_base_folder}{path}"):
        file_path = f"{path}/{filename}"
        paths.append(file_path)
    return paths

def calculator(equation: str):
    """
    Calculates the resulting value of a mathematical equation.

    Args:
        equation (str): A simple plain text equation as a string. Only numbers and operation symbols may be used, not variables or unknowns. Example: "53.1 / ( sqrt(2) * 3^2 )"
    Returns:
        float: The output value of the equation as a float
    """
    tool_output = sympify(equation).evalf()
    return tool_output, {}

def check_url(url):
    try:
        parsed = urlparse(url)

        if parsed.scheme not in ('https'):
            print(f"Unsafe scheme \"{str(parsed.scheme)}\" was used in link \"{url}\".")
            return False

        if parsed.hostname:
            try:
                ip_addr = ipaddress.ip_address(parsed.hostname)
                if ip_addr.is_private or ip_addr.is_loopback:
                    print(f"Link \"{url}\" was denied. Access to a private or loopback IP is not permitted.")
                    return False
            except ValueError:
                for word in BANNED_WORDS:
                    if word in url.lower():
                        print(f"URL \"{url}\" denied since it contains a word from the \"BANNED_WORDS\" list.")
                        return False
                pass
        return True
    except Exception as e:
        print(f"URL parsing failed: {e}")
        return False

def search_web(query: str, limit: int):
    """
    Finds the top search results of "query" on the web.

    Args:
        query (str): The search query. Include the year in the query for the most up to date results.
        limit (int): The number of results to retrieve, between 3 and 10, default 4

    Returns:
        str: the search results, where each result contains the link followed by some content from the web-page
    """
    total_timer = time.time()
    if limit > 10:
        limit = 10
    elif limit < 3:
        limit = 3
    # Replace with the URL of your local SearXNG instance
    searxng_url = 'http://localhost:8080/search'
    params = {
        'q': query,
        'pageno': '1'
    }
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }

    try:
        contains_personal = False
        contains_banned = False
        for word in blocked_personal:
            if word in query.lower():
                contains_personal = True
        for word in BANNED_WORDS:
            if word in query.lower():
                contains_banned = True
        if contains_personal:
            print(f"WARNING: Jarvis made web query \"{query}\", which contains a word from the \"blocked_personal\" words list.")
            return "No results.", {}
        elif contains_banned:
            print(f"WARNING: Jarvis made web query \"{query}\", which contains a word from the \"BANNED_WORDS\" words list.")
            return "No results.", {}
        else:
            timer1 = time.time()
            response = requests.get(searxng_url, params=params, headers=headers)
            response.raise_for_status()
            print(f"   search response time: {time.time() - timer1}")
            timer1 = time.time()
            soup = BeautifulSoup(response.text, 'html.parser')
            print(f"   bs4 parse time: {time.time() - timer1}")

            links = []
            for i, result in enumerate(soup.select('.result')[:limit]): 
                title_element = result.select_one('h3 a')
                link_element = result.select_one('.url_header')
                preview_element = result.select_one('.content')

                if link_element:
                    title = title_element.get_text(strip=True)
                    link = link_element['href']
                    preview = preview_element.get_text(strip=True)
                    if check_url(link):
                        links.append(link)
            if links == []:
                print("Error: Either no results were retrieved from Searxng, or none were approved.")
                return "An error occured while retrieving search results.", {}

            results = f"# Search results for \"{query}\":\n\n\n" + '\n\n\n'.join(query_pages(links, query, int(limit)))
            tool_output = results
            print(f"Total web-search time: {time.time() - total_timer}")
            return tool_output, {}
    except requests.exceptions.RequestException as e:
        print(f"An error occurred: {e}")
        return "An error occured on our side of things, we apologize for the inconvenience."

def search_database(query: str):
    """
    Searches local database for "query" for possibly relevant information.

    Args:
        query (str): Query compared against information in local database
    Returns:
        str: List of possibly relevant information from the local database
    """
    #self.messages = [message for message in self.messages if not message.get("content").startswith("Database")]
    results = '\n'.join([document.page_content for document in retriever.invoke(query)])
    tool_output = f"Database results for query \"{query}\":\n\n{results}"
    return tool_output, {}

def list_files(path: str = "/"):
    """
    Lists contents of directory "path". The function will list all available folders/files within the "path". Any file without an extension is a folder/sub-directory which may contain more files.

    Args:
        path (str): directory of the desired folder, e.g. "/example_folder/sub_folder". Use "/" (default) to list the folders in the root directory.
    Returns:
        str: list of file paths within directory "path"
    """
    full_path = path
    if full_path == "/":
        full_path = knowledge_base_folder
    else:
        full_path = f"{knowledge_base_folder}{full_path}"
    if os.path.exists(full_path):
        if os.path.isdir(full_path):
            available_filepaths = get_files(path)
            if available_filepaths == []:
                tool_output = f"Directory \"{path}\" is empty, it has no contents."
            else:
                files_list = '\n'.join([f"* {f_path}" for f_path in available_filepaths])
                tool_output = f"## Contents of folder \"{path}\":\n\n{files_list}\n\nYou may use the \"open_file\" tool call to open a file path, or the \"list_files\" again tool call again in order to open a sub-directories."
        else:
            tool_output = f"The path \"{path}\" is not a directory and therefor cannot be opened as a folder."
    else:
        tool_output = f"The path \"{path}\" does not exist."
    return tool_output, {}

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

def search_for_file(filename_query: str, limit: int):
    """
    Lists paths to closest file matches to the filename query.

    Args:
        filename_query (str): query to be searched, e.g. "example.txt"
        limit (int): number of paths to return, e.g. 5
    Returns:
        str: "limit" number of file paths to search results for "filename_query"
    """
    results = []
    for filepath in get_all_files():
        similarity = difflib.SequenceMatcher(None, filename_query.lower(), filepath.lower()).ratio()
        results.append((filepath, similarity))
    results.sort(key=lambda x: x[1], reverse=True)
    results = results[:limit]
    joined_results = '\n'.join([f"* {result[0]}" for result in results])
    tool_output = f"## Search results for query \"{filename_query}\"\n\n{joined_results}"
    return tool_output, {}

def read_file(filepath: str):
    """
    Reads content of the file designated by "filepath". Use the "list_files" tool call in order to browse available files.

    Args:
        filepath (str): the full path of the file to be opened, e.g. "/example_folder/test.txt"
    Returns:
        str: contents of file "filepath"
    """
    split_path = filepath.split("/")
    filename = split_path[-1]
    del split_path
    full_path = filepath
    full_path = f"{knowledge_base_folder}{full_path}"
    tool_output = ""
    if os.path.exists(full_path):
        if not os.path.isdir(full_path):
            file_extension = filename.split('.')[-1]
            if file_extension in ['txt', 'pdf', 'html', 'css', 'js', 'py']:
                with open(full_path, 'r', encoding='utf-8') as file:
                    tool_output = f"# page 1/1 of file \"{filename}\":\n\n{file.read()}"
            elif file_extension in ['png', 'jpg', 'jpeg']:
                tool_output = f"Succesfully displayed image: \"{filename}\""
            else:
                tool_output = f"Error, the open_file tool call does not support files of type \"{file_extension}\"."
        else:
            tool_output = f"The item \"{filename}\" is a folder not a file, you may use the \"list_files\" tool call to view it's contents."

    else:
        tool_output = f"Error, no such file \"{filepath}\" was found in in the direcory, try using the \"list_files\" tool call to find available files to choose from."
    return tool_output, {}

def write_file(filepath: str, content: str):
    """
    Writes a file to "filepath" containing the text content of "content".

    Args:
        filepath (str): the full path of the file to be created or replaced, e.g. "/example_folder/test.txt" or "/test/code.py"
        content (str): the string content of the file to be created
    Returns:
        str: status of created file
    """
    if not filepath.startswith("/"):
        filepath = "/" + filepath
    split_path = filepath.split("/")
    filename = split_path[-1]
    parent = '/'.join(split_path[:-1])
    if not filename.startswith("rw_"):
        filename = f"rw_{filename}"
        split_path[-1] = filename
        filepath = '/'.join(split_path)
    del split_path
    full_path = filepath
    full_path = f"{knowledge_base_folder}{full_path}"
    tool_output = ""
    file_extension = filename.split('.')[-1]
    if file_extension in ['txt', 'html', 'css', 'js', 'py', 'cpp', 'csv']:
        os.makedirs(f"{knowledge_base_folder}{parent}", exist_ok=True)
        with open(full_path, 'w', encoding='utf-8') as file:
            file.write(content)
        tool_output = f"Succesfully wrote {len(content)} characters at position \"{filepath}\"."
    else:
        tool_output = f"Cannot create file since extension {file_extension} is not supported."
    return tool_output, {}