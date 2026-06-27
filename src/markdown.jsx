function parseInline(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/`(.*?)`/g, "<code>$1</code>");
}

export function parseMarkdown(buffer) {
  let html = "";
  let inList = false;
  let inCodeBlock = false;

  for (const line of buffer.split("\n")) {
    if (line === undefined || line === null) continue;
    const trimmed = line.trim();

    if (!inCodeBlock) {
      if (trimmed.startsWith("```")) {
        inCodeBlock = true;
        html += `<pre><button class="copy-code-btn" data-copy="true">Copy</button><code>`;
        continue;
      } else if (trimmed.startsWith("* ") || trimmed.startsWith("- ")) {
        if (!inList) { html += "<ul>"; inList = true; }
        html += `<li>${parseInline(trimmed.substring(2))}</li>`;
        continue;
      } else if (trimmed === "") {
        if (inList) { html += "</ul>"; inList = false; continue; }
      }

      if (trimmed.startsWith("# "))         html += `<h1>${parseInline(trimmed.substring(2))}</h1>`;
      else if (trimmed.startsWith("## "))   html += `<h2>${parseInline(trimmed.substring(3))}</h2>`;
      else if (trimmed.startsWith("### "))  html += `<h3>${parseInline(trimmed.substring(4))}</h3>`;
      else if (trimmed.startsWith("#### ")) html += `<h4>${parseInline(trimmed.substring(5))}</h4>`;
      else if (trimmed.startsWith("> "))    html += `<blockquote>${parseInline(trimmed.substring(2))}</blockquote>`;
      else if (trimmed !== "")              html += `<p>${parseInline(trimmed)}</p>`;
    } else {
      if (trimmed.startsWith("```")) {
        inCodeBlock = false;
        html += "</code></pre>";
      } else {
        html += line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + "\n";
      }
    }
  }
  if (inList)      html += "</ul>";
  if (inCodeBlock) html += "</code></pre>";
  return html;
}