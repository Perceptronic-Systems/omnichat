import time
import requests
from bs4 import BeautifulSoup
import os
import tomllib
import re

SEARXNG_API = "http://localhost:8080/"
blocked_personal = []
BANNED_WORDS = []

config_path = os.path.expanduser("~/.config/omnichat/config.toml")

if os.path.exists(config_path):
    with open(config_path, 'rb') as f:
        config = tomllib.load(f)
    try:
        SEARXNG_API = config['searxng']['api']
    except Exception as e:
        print("Missing config attribute.")
        print(e)

def _searxng_available() -> bool:
    try:
        resp = requests.get(f"{SEARXNG_API}healthz", timeout=3)
        return resp.status_code == 200
    except requests.exceptions.RequestException:
        return False


def search_searxng(query: str, limit: int = 5) -> list[dict]:
    limit = max(3, min(limit, 12))

    # --- Query filtering ---
    query_lower = query.lower()
    if any(word in query_lower for word in blocked_personal):
        print(f"WARNING: Blocked personal query: \"{query}\"")
        return []
    if any(word in query_lower for word in BANNED_WORDS):
        print(f"WARNING: Blocked banned-word query: \"{query}\"")
        return []

    # --- Fetch SearXNG results ---
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/91.0.4472.124 Safari/537.36"
        )
    }
    params = {"q": query, "pageno": "1"}

    try:
        response = requests.get(SEARXNG_API, params=params, headers=headers, timeout=10)
        response.raise_for_status()
    except requests.exceptions.RequestException as e:
        print(f"Search request failed: {e}")
        return []

    soup = BeautifulSoup(response.text, "html.parser")

    # Collect approved URLs + their titles from the SERP
    candidates = []
    for result in soup.select(".result")[:limit * 2]:  # over-fetch to account for filtered URLs
        title_el = result.select_one("h3 a")
        url_el   = result.select_one("a.url_header") or result.select_one(".result_header a")
        preview_el = result.select_one(".content")

        if not (title_el and url_el):
            continue

        url = url_el.get("href", "").strip()
        if not url or not check_url(url):
            continue

        candidates.append({
            "title":   title_el.get_text(strip=True),
            "url":     url,
            "preview": preview_el.get_text(strip=True) if preview_el else "",
        })

        if len(candidates) >= limit:
            break

    if not candidates:
        print("No approved results returned from SearXNG.")
        return []

    # --- Fetch each page and extract a useful snippet ---
    results = []
    for item in candidates:
        snippet = _extract_snippet(item["url"], headers, query)
        results.append({
            "title":   item["title"],
            "url":     item["url"],
            # Fall back to the SERP preview when the page can't be fetched
            "snippet": snippet or item["preview"],
        })

    return results

def check_url(url):
    return True


def _extract_snippet(url: str, headers: dict, query: str, max_chars: int = 1500) -> str:
    """
    Fetch a page and return a continuous, context-rich text block 
    centered around the highest concentration of query keywords.
    """
    try:
        resp = requests.get(url, headers=headers, timeout=8)
        resp.raise_for_status()
    except requests.exceptions.RequestException:
        return ""

    page_soup = BeautifulSoup(resp.text, "html.parser")

    # 1. Clean out the boilerplate noise
    for tag in page_soup(["script", "style", "nav", "header", "footer", "aside", "form"]):
        tag.decompose()

    # 2. Extract elements that actually hold textual body content
    # This expands on just <p> tags to grab lists and headings
    content_tags = page_soup.find_all(["p", "li", "h1", "h2", "h3", "h4", "td"])
    
    # Process text chunks in chronological order (maintaining document flow)
    chunks = []
    for tag in content_tags:
        text = tag.get_text(separator=" ", strip=True)
        # Filter out obvious micro-text noise like "Share", "Tweet", or single words
        if text and len(text.split()) > 3:
            chunks.append(text)

    if not chunks:
        return ""

    # Clean query words to look for matches
    query_words = [re.sub(r'[^\w\s]', '', w.lower()) for w in query.lower().split()]
    query_words = [w for w in query_words if len(w) > 2]  # ignore tiny words like 'in', 'of', '20'

    # 3. Find the best continuous text block (Sliding Window approach)
    best_window = []
    max_matches = -1

    # Look at windows of sequential paragraphs to maintain context
    for i in range(len(chunks)):
        current_window = []
        current_len = 0
        match_count = 0
        
        # Expand window until we hit the char limit
        for j in range(i, len(chunks)):
            chunk = chunks[j]
            if current_len + len(chunk) > max_chars:
                break
            
            current_window.append(chunk)
            current_len += len(chunk) + 1 # +1 for the joining space
            
            # Count keyword occurrences in this chunk
            chunk_lower = chunk.lower()
            match_count += sum(1 for w in query_words if w in chunk_lower)

        # We want the window that has the most keyword density/matches
        if match_count > max_matches:
            max_matches = match_count
            best_window = current_window

    # Return the unified block of text, keeping sentences in their proper order
    return " ".join(best_window)