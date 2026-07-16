import time
import requests
from bs4 import BeautifulSoup
import os
import tomllib
import re
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urljoin

logger = logging.getLogger(__name__)

SEARXNG_API = "http://localhost:8080/"
FETCH_TIMEOUT = 4
FETCH_WORKERS = 10
RESULTS_TO_FETCH = 10
MIN_CHUNK_CHARS = 200
MAX_CHUNK_CHARS = 1000
MAX_CHUNKS_PER_PAGE = 20

_session = requests.Session()
_session.headers.update({"User-Agent": "Mozilla/5.0 (compatible; SearchBot/1.0)"})

try:
    from rank_bm25 import BM25Okapi
    _HAS_BM25 = True
except ImportError:
    _HAS_BM25 = False

try:
    import trafilatura
    _HAS_TRAFILATURA = True
except ImportError:
    _HAS_TRAFILATURA = False
    from bs4 import BeautifulSoup

_WORD_RE = re.compile(r"[a-z0-9]+")

config_path = os.path.expanduser("/etc/omnichat/config.toml")

if os.path.exists(config_path):
    with open(config_path, 'rb') as f:
        config = tomllib.load(f)
    try:
        SEARXNG_API = config['searxng']['api']
    except Exception as e:
        print("Missing config attribute.")
        print(e)

# Normalize once: whatever shape the config value came in (with/without a
# trailing slash, with/without a stray "/search" already appended), reduce it
# to a clean base with exactly one trailing slash. Everything downstream uses
# urljoin() against this base instead of string interpolation, so it can't
# accidentally double up path segments again.
SEARXNG_API = SEARXNG_API.rstrip("/")
if SEARXNG_API.endswith("/search"):
    SEARXNG_API = SEARXNG_API[: -len("/search")]
SEARXNG_API = SEARXNG_API + "/"


def _searxng_available() -> bool:
    try:
        # Not every SearXNG deployment exposes /healthz, but /search always
        # exists (it's the endpoint we actually depend on), so check that
        # directly with a cheap throwaway query.
        resp = requests.get(
            urljoin(SEARXNG_API, "search"),
            params={"q": "ping", "format": "json"},
            timeout=3,
        )
        return resp.status_code == 200
    except requests.exceptions.RequestException:
        return False


def _tokenize(text: str) -> list[str]:
    return _WORD_RE.findall(text.lower())


def _searxng_query(query: str, num_results: int) -> list[dict]:
    resp = _session.get(
        urljoin(SEARXNG_API, "search"),
        params={"q": query, "format": "json", "language": "en"},
        timeout=5,
    )
    resp.raise_for_status()
    return resp.json().get("results", [])[:num_results]


def _fetch_page(url: str) -> str | None:
    """Download a page and return best-effort extracted body text."""
    try:
        resp = _session.get(url, timeout=FETCH_TIMEOUT)
        resp.raise_for_status()
    except requests.RequestException as e:
        logger.debug("fetch failed for %s: %s", url, e)
        return None

    ctype = resp.headers.get("content-type", "")
    if "html" not in ctype and not resp.text.strip().startswith("<"):
        return None

    if _HAS_TRAFILATURA:
        return trafilatura.extract(
            resp.text, include_comments=False, include_tables=False, favor_precision=True
        )
    soup = BeautifulSoup(resp.text, "html.parser")
    for tag in soup(["script", "style", "nav", "header", "footer", "aside"]):
        tag.decompose()
    return soup.get_text(separator="\n")


def _chunk_text(text: str) -> list[str]:
    """Split page text into paragraph-sized chunks for ranking."""
    if not text:
        return []

    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks, buffer = [], ""

    for para in paragraphs:
        if len(para) < 40:
            buffer = f"{buffer} {para}".strip()
            if len(buffer) >= MIN_CHUNK_CHARS:
                chunks.append(buffer[:MAX_CHUNK_CHARS])
                buffer = ""
            continue

        if buffer:
            para, buffer = f"{buffer} {para}".strip(), ""

        if len(para) > MAX_CHUNK_CHARS:
            sentences = re.split(r"(?<=[.!?])\s+", para)
            cur = ""
            for sent in sentences:
                if len(cur) + len(sent) > MAX_CHUNK_CHARS and cur:
                    chunks.append(cur.strip())
                    cur = sent
                else:
                    cur = f"{cur} {sent}".strip()
            if cur:
                chunks.append(cur.strip())
        else:
            chunks.append(para)

    if buffer:
        chunks.append(buffer)
    return chunks[:MAX_CHUNKS_PER_PAGE]


def _rank_bm25(query: str, chunks: list[str]) -> list[float]:
    bm25 = BM25Okapi([_tokenize(c) for c in chunks])
    return list(bm25.get_scores(_tokenize(query)))


def _rank_overlap(query: str, chunks: list[str]) -> list[float]:
    """Fallback if rank_bm25 isn't installed: normalized term overlap."""
    q_set = set(_tokenize(query))
    scores = []
    for chunk in chunks:
        terms = _tokenize(chunk)
        if not terms:
            scores.append(0.0)
            continue
        overlap = sum(1 for t in terms if t in q_set)
        score = overlap / (len(terms) ** 0.5)
        if query.lower() in chunk.lower():
            score += 2.0
        scores.append(score)
    return scores


def _rerank(query: str, candidates: list[dict], top_k: int) -> list[dict]:
    """Cheap second pass over the BM25 shortlist: rewards chunks that cover
    more distinct query terms, without the cost of an embedding model."""
    q_terms = set(_tokenize(query))

    def coverage(text: str) -> float:
        return len(q_terms & set(_tokenize(text))) / max(len(q_terms), 1)

    for c in candidates:
        c["_final_score"] = c["_score"] * 0.7 + coverage(c["text"]) * 0.3
    candidates.sort(key=lambda c: c["_final_score"], reverse=True)
    return candidates[:top_k]


def _clean_snippet(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > MAX_CHUNK_CHARS:
        text = text[:MAX_CHUNK_CHARS].rsplit(" ", 1)[0] + "…"
    return text


def search_searxng(query: str, limit: int = 8) -> list[dict]:
    """
    Search via SearXNG, fetch pages concurrently, chunk + rank + re-rank,
    and return the most relevant text chunks for the LLM.
    """
    limit = max(1, min(limit, 10))
    start = time.time()

    try:
        results = _searxng_query(query, RESULTS_TO_FETCH)
    except requests.RequestException as e:
        logger.error("SearXNG query failed: %s", e)
        return []
    if not results:
        return []

    url_meta = {r["url"]: r for r in results if r.get("url")}

    # The slow part is network I/O, so parallelize page fetches.
    page_texts: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        futures = {pool.submit(_fetch_page, url): url for url in url_meta}
        for future in as_completed(futures, timeout=FETCH_TIMEOUT + 2):
            url = futures[future]
            try:
                text = future.result()
            except Exception as e:
                logger.debug("extraction failed for %s: %s", url, e)
                text = None
            if text:
                page_texts[url] = text

    candidates: list[dict] = []
    for url, text in page_texts.items():
        meta = url_meta[url]
        for chunk in _chunk_text(text):
            candidates.append({"url": url, "title": meta.get("title", url), "text": chunk})

    if not candidates:
        # Fall back to SearXNG's own snippets if extraction yielded nothing.
        return [
            {"title": r.get("title", ""), "url": r.get("url", ""), "snippet": r.get("content", "")}
            for r in results[:limit]
        ]

    chunk_texts = [c["text"] for c in candidates]
    scores = _rank_bm25(query, chunk_texts) if _HAS_BM25 else _rank_overlap(query, chunk_texts)
    for c, s in zip(candidates, scores):
        c["_score"] = s

    candidates.sort(key=lambda c: c["_score"], reverse=True)
    shortlist = candidates[:max(limit * 4, 20)]  # re-rank only a small pool
    top = _rerank(query, shortlist, limit * 2)

    seen_urls, output = set(), []
    for cand in top:
        if cand["url"] in seen_urls:
            continue
        seen_urls.add(cand["url"])
        output.append({
            "title": cand["title"],
            "url": cand["url"],
            "snippet": _clean_snippet(cand["text"]),
        })
        if len(output) >= limit:
            break

    logger.debug(
        "search_searxng('%s'): %.2fs, %d candidates, %d results",
        query, time.time() - start, len(candidates), len(output),
    )
    return output


if __name__ == "__main__":
    import argparse
    import json

    print(f"Using SEARXNG_API = {SEARXNG_API!r}")
    print(f"Available: {_searxng_available()}")

    parser = argparse.ArgumentParser(description="Test search_searxng directly")
    parser.add_argument("query", nargs="?", default="latest python 3.13 features",
                         help="Search query to test")
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--json", action="store_true", help="print raw JSON instead of pretty text")
    args = parser.parse_args()

    t0 = time.time()
    results = search_searxng(args.query, args.limit)
    elapsed = time.time() - t0

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        print(f"\nQuery: {args.query!r}  |  {len(results)} results in {elapsed:.2f}s\n{'-'*70}")
        for i, r in enumerate(results, 1):
            print(f"[{i}] {r['title']}\n    {r['url']}\n    {r['snippet']}\n")