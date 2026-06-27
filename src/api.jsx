export function initApi() {
  let stored = localStorage.getItem("omnichat_api_url");
  if (!stored) {
    const def = "http://127.0.0.1:5014/api/";
    let input = prompt("Please enter your API Base URL:", def);
    stored = (!input || !input.trim()) ? def : input.trim();
    if (!stored.endsWith("/")) stored += "/";
    localStorage.setItem("omnichat_api_url", stored);
  }
  return stored;
}

export function clearStoredApi() { localStorage.removeItem("omnichat_api_url"); }

export async function* generateResponse(prompt, id, files = [], apiBase) {
  const formData = new FormData();
  formData.append("id", id);
  formData.append("prompt", prompt || "");
  if (files.length > 0) {
    files.forEach(f => formData.append("files", f));
  } else {
    formData.append("files", new Blob([]), "");
  }

  const response = await fetch(`${apiBase}generate`, { method: "POST", body: formData });
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
        if (json.isDone || json.status === "Idle") return;
        yield { token: json.token || "", status: json.status || "Retrieving Data" };
      } catch { /* malformed chunk */ }
    }
  }
}