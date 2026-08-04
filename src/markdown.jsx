function parseInline(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/`(.*?)`/g, "<code>$1</code>")
    .replace(/!\[(.*?)\]\((.*?)\)/g, '<img src="$2" alt="$1">')
    .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank">$1</a>')
    .replace(/~~(.*?)~~/g, "<s>$1</s>")
    .replace(/\[\s\]/gi, "☐")
    .replace(/\[x\]/gi, "☑")
    // FIXED: footnote refs end in "]" not ")" — old regex could never match [^label]
    .replace(/\[\^([^\]]+)\]/g, (_match, label) => {
      return `<sup id="fnref-${label}"><a href="#fn-${label}" class="footnote-ref">${label}</a></sup>`;
    });
}

// Renders a buffered block of "|...|" lines into a <table>.
function renderTable(rows) {
  if (rows.length === 0) return "";

  const parseRow = (row) =>
    row.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

  const isSeparatorRow = (cells) =>
    cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));

  const headerCells = parseRow(rows[0]);
  let bodyRows = rows.slice(1);
  let alignments = headerCells.map(() => null);

  if (bodyRows.length > 0) {
    const maybeSeparator = parseRow(bodyRows[0]);
    if (isSeparatorRow(maybeSeparator)) {
      alignments = maybeSeparator.map((c) => {
        const left = c.startsWith(":");
        const right = c.endsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        if (left) return "left";
        return null;
      });
      bodyRows = bodyRows.slice(1);
    }
  }

  const alignAttr = (i) =>
    alignments[i] ? ` style="text-align:${alignments[i]}"` : "";

  let html = "<table class='markdown-table'><thead><tr>";
  html += headerCells
    .map((c, i) => `<th${alignAttr(i)}>${parseInline(c)}</th>`)
    .join("");
  html += "</tr></thead><tbody>";

  for (const row of bodyRows) {
    const cells = parseRow(row);
    if (cells.length === 0) continue;
    html +=
      "<tr>" +
      cells.map((c, i) => `<td${alignAttr(i)}>${parseInline(c)}</td>`).join("") +
      "</tr>";
  }

  html += "</tbody></table>";
  return html;
}

export function parseMarkdown(buffer) {
  let html = "";
  let inList = false;
  let inOrderedList = false;
  let inCodeBlock = false;
  let inTable = false;
  let inBlockquote = false;
  let tableBuffer = [];
  const footnotes = new Map(); // label -> content, in first-seen order

  const lines = buffer.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line === null) continue;
    const trimmed = line.trim();

    // --- Code Block Handling ---
    if (!inCodeBlock && trimmed.startsWith("```")) {
      inCodeBlock = true;
      html += `<pre><button class="copy-code-btn" data-copy="true">Copy</button><code>`;
      continue;
    }

    if (inCodeBlock) {
      if (trimmed.startsWith("```")) {
        inCodeBlock = false;
        html += `</code></pre>`;
      } else {
        html += line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + "\n";
      }
      continue;
    }

    // --- Footnote Definitions: [^label]: some text ---
    const footnoteDefMatch = trimmed.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
    if (footnoteDefMatch) {
      footnotes.set(footnoteDefMatch[1], footnoteDefMatch[2]);
      continue;
    }

    // --- Table Handling ---
    const isTableLine = trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 1;
    if (isTableLine) {
      inTable = true;
      tableBuffer.push(trimmed);
      continue;
    } else if (inTable) {
      html += renderTable(tableBuffer);
      tableBuffer = [];
      inTable = false;
      // no `continue` here — let this line be processed normally below
    }

    // --- Blockquote Handling ---
    if (trimmed.startsWith("> ") || trimmed === ">") {
      if (!inBlockquote) {
        inBlockquote = true;
        html += "<blockquote>";
      }
      const content = trimmed === ">" ? "" : trimmed.substring(2);
      html += content === "" ? "<br>" : parseInline(content);
      continue;
    } else if (inBlockquote) {
      html += "</blockquote>";
      inBlockquote = false;
      // fall through — this line still needs normal processing
    }

    // --- List Handling ---
    const isUnordered = trimmed.startsWith("* ") || trimmed.startsWith("- ");
    const isOrdered = /^\d+\.\s/.test(trimmed);

    if (isUnordered || isOrdered) {
      if (!inList) {
        html += isOrdered ? "<ol>" : "<ul>";
        inList = true;
        inOrderedList = isOrdered;
      }
      let content = "";
      if (isUnordered) {
        content = trimmed.substring(2);
      } else {
        content = trimmed.replace(/^\d+\.\s/, "");
      }
      html += `<li>${parseInline(content)}</li>`;
      continue;
    } else if (trimmed === "") {
      if (inList) {
        html += inOrderedList ? "</ol>" : "</ul>";
        inList = false;
        inOrderedList = false;
      }
    }

    // --- Standard Markdown Elements ---
    if (trimmed.startsWith("# ")) html += `<h1>${parseInline(trimmed.substring(2))}</h1>`;
    else if (trimmed.startsWith("## ")) html += `<h2>${parseInline(trimmed.substring(3))}</h2>`;
    else if (trimmed.startsWith("### ")) html += `<h3>${parseInline(trimmed.substring(4))}</h3>`;
    else if (trimmed.startsWith("#### ")) html += `<h4>${parseInline(trimmed.substring(5))}</h4>`;
    else if (trimmed.startsWith("##### ")) html += `<h5>${parseInline(trimmed.substring(6))}</h5>`;
    else if (trimmed.startsWith("###### ")) html += `<h6>${parseInline(trimmed.substring(7))}</h6>`;
    else if (/^(\*\*\*|---|___)$/.test(trimmed)) html += "<hr />";
    else if (trimmed !== "") html += `<p>${parseInline(trimmed)}</p>`;
  }

  // --- Final cleanup for unterminated blocks at end of buffer ---
  if (inList) html += inOrderedList ? "</ol>" : "</ul>";
  if (inBlockquote) html += "</blockquote>";
  if (inTable) html += renderTable(tableBuffer);
  if (inCodeBlock) html += "</code></pre>";

  // --- Footnotes section ---
  if (footnotes.size > 0) {
    html += `<hr /><section class="footnotes"><ol>`;
    for (const [label, content] of footnotes) {
      html += `<li id="fn-${label}">${parseInline(content)} <a href="#fnref-${label}" class="footnote-backref">↩</a></li>`;
    }
    html += `</ol></section>`;
  }

  return html;
}