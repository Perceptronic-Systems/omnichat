import { generateResponseWebLLM } from "./webllm-client.js";

export function initApi() {
  let stored = localStorage.getItem("omnichat_api_url");
  if (!stored) {
    const def = "browser";
    let input = prompt(
      "Type 'browser' to run the model locally (free, default), or enter a custom API Base URL:",
      def
    );
    stored = (!input || !input.trim()) ? def : input.trim();
    if (stored.toLowerCase() === "browser") {
      stored = "browser";
    } else if (!stored.endsWith("/")) {
      stored += "/";
    }
    localStorage.setItem("omnichat_api_url", stored);
  }
  return stored;
}

export function clearStoredApi() { localStorage.removeItem("omnichat_api_url"); }

// ─── Session token management ──────────────────────────────────────────────
//
// Replaces the old client-generated random integer entirely. A session
// token is minted by the SERVER (cryptographically random, capacity- and
// rate-limited -- see session_manager.py) the first time it's actually
// needed for a real send -- never on page load -- and reused from then on.
// Held in memory only, not localStorage: a page refresh means a fresh
// token gets minted on the next real send, which is intentional -- no
// server-side session (and no sandbox container) should exist for a
// visitor who never actually interacts.
let _sessionToken = null;
let _sessionTokenPromise = null; // in-flight creation, dedupes concurrent callers

export async function getSessionToken(apiBase) {
  if (apiBase === "browser") return null; // no server session needed in local mode
  if (_sessionToken) return _sessionToken;
  if (_sessionTokenPromise) return _sessionTokenPromise;

  _sessionTokenPromise = (async () => {
    try {
      const res = await fetch(`${apiBase}session/create`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      _sessionToken = data.token;
      return _sessionToken;
    } finally {
      _sessionTokenPromise = null;
    }
  })();

  return _sessionTokenPromise;
}

export function clearSessionToken() {
  _sessionToken = null;
}

/** Fetch wrapper that lazily obtains a session token and attaches it as a
 * bearer token. Use this for anything hitting an authenticated endpoint
 * (file manager, etc.) instead of building the Authorization header by hand. */
export async function authFetch(apiBase, path, options = {}) {
  const token = await getSessionToken(apiBase);
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  return fetch(`${apiBase}${path}`, { ...options, headers });
}

export async function* generateResponse(prompt, files = [], apiBase, history = [], onModelProgress, tts = false, externalSignal = null) {
  if (apiBase === "browser") {
    yield* generateResponseWebLLM(prompt, history, onModelProgress);
    return;
  }

  let token;
  try {
    token = await getSessionToken(apiBase);
  } catch (err) {
    yield {
      token: `\n\n*⚠️ Could not start a session: ${err.message}*`,
      status: "error",
      tool_calls: null,
      audio: null,
    };
    return;
  }

  const formData = new FormData();
  formData.append("prompt", prompt || "");
  formData.append("tts", tts ? "true" : "false");
  if (files.length > 0) {
    files.forEach(f => formData.append("files", f));
  } else {
    formData.append("files", new Blob([]), "");
  }

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), 180_000); // 3 min hard cap
  // Combine our own timeout with an externally-provided signal (e.g. so a
  // caller can cancel mid-response for interruption/barge-in) without
  // either one having to know about the other.
  const signal = externalSignal
    ? AbortSignal.any([timeoutController.signal, externalSignal])
    : timeoutController.signal;

  try {
    const response = await fetch(`${apiBase}generate`, {
      method: "POST",
      body: formData,
      signal,
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop();
      for (const part of parts) {
        const line = part.trim();
        if (!line || !line.startsWith("data:")) continue;
        try {
          const json = JSON.parse(line.replace(/^data:\s*/, ""));
          if (json.is_done || json.status === "idle") return;
          // audio: base64-encoded WAV for one sentence, present only when
          // tts=true was requested and that chunk carries synthesized
          // speech rather than a text token. null on every other chunk.
          yield {
            token: json.token || "",
            status: json.status || "Retrieving Data",
            tool_calls: json.tool_calls || null,
            audio: json.audio || null,
          };
        } catch { /* malformed chunk */ }
      }
    }
  } catch (err) {
    // A deliberate external cancellation (barge-in interruption) isn't a
    // failure -- don't surface a scary connection-error message for it,
    // the caller already knows it interrupted on purpose.
    if (err.name === "AbortError" && externalSignal?.aborted) {
      return;
    }
    yield {
      token: `\n\n*⚠️ Connection error: ${err.name === "AbortError" ? "request timed out" : err.message}*`,
      status: "error",
      tool_calls: null,
      audio: null,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}