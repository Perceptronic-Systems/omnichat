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

export async function* generateResponse(prompt, id, files = [], apiBase, history = [], onModelProgress, tts = false, externalSignal = null) {
  if (apiBase === "browser") {
    yield* generateResponseWebLLM(prompt, history, onModelProgress);
    return;
  }
  const formData = new FormData();
  formData.append("id", id);
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
    const response = await fetch(`${apiBase}generate`, { method: "POST", body: formData, signal });
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