import { useState, useRef, useEffect, useCallback } from "react";

// ─── Markdown Parser ──────────────────────────────────────────────────────────

function parseInline(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/`(.*?)`/g, "<code>$1</code>");
}

function parseMarkdown(buffer) {
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

// ─── API / SSE ────────────────────────────────────────────────────────────────

function initApi() {
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

function clearStoredApi() { localStorage.removeItem("omnichat_api_url"); }

async function* generateResponse(prompt, id, files = [], apiBase) {
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

// ─── File helpers ─────────────────────────────────────────────────────────────

function getFileIcon(name) {
  const ext = name.split(".").pop().toLowerCase();
  if (["png","jpg","jpeg","gif","webp"].includes(ext)) return "🖼️";
  if (ext === "pdf") return "📕";
  if (["doc","docx","txt","md"].includes(ext)) return "📄";
  if (["js","py","html","css","json"].includes(ext)) return "💻";
  return "📁";
}

// ─── Spinner ──────────────────────────────────────────────────────────────────

const FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

function Spinner({ active }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setFrame(f => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(id);
  }, [active]);
  return <span className="status">{active ? FRAMES[frame] : ""}</span>;
}

// ─── Taskbar Menu ─────────────────────────────────────────────────────────────

// Which items live under each top-level menu button
const MENU_TREE = {
  File: ["download_chat", "upload_chat"],
  Edit: ["change_API_link"],
  View: [],
  Help: [],
};

// Floating popup anchored to a header button
function TaskbarPopup({ items, anchorRect, onSelect, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    const onKey   = (e) => { if (e.key === "Escape") onClose(); };
    const onMouse = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener("keydown",   onKey);
    document.addEventListener("mousedown", onMouse);
    return () => {
      document.removeEventListener("keydown",   onKey);
      document.removeEventListener("mousedown", onMouse);
    };
  }, [onClose]);

  const isMobile = window.innerWidth <= 812;
  const style = {
    position: "fixed",
    zIndex: 1000,
    left: isMobile ? anchorRect.right  : anchorRect.left,
    top:  isMobile ? anchorRect.top    : anchorRect.bottom,
  };

  return (
    <div className="side-popup" ref={ref} style={style}>
      {items.length === 0
        ? <button className="task-button" disabled style={{ opacity: 0.4 }}>(empty)</button>
        : items.map(item => (
            <button key={item} className="task-button" onClick={() => onSelect(item)}>
              {item.replace(/_/g, " ")}
            </button>
          ))
      }
    </div>
  );
}

// ─── Message components ───────────────────────────────────────────────────────

function BotMessage({ html, status, streaming }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e) => {
      const btn = e.target.closest("[data-copy]");
      if (!btn) return;
      const code = btn.nextElementSibling;
      navigator.clipboard.writeText(code?.innerText || "").then(() => {
        btn.textContent = "Copied!";
        btn.classList.add("copied");
        setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 2000);
      });
    };
    el.addEventListener("click", handler);
    return () => el.removeEventListener("click", handler);
  }, []);

  return (
    <div className="message">
      <div className="bot" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
      {streaming && (
        <div className="status-container">
          <Spinner active={streaming} />
          <span className="status">{status}</span>
        </div>
      )}
    </div>
  );
}

function UserMessage({ html }) {
  return (
    <div className="message">
      <div className="user" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

const SESSION_ID = Math.floor(Math.random() * 100_000_000);

export default function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput]       = useState("");
  const [files, setFiles]       = useState([]);
  const [navOpen, setNavOpen]   = useState(false);
  const [apiBase, setApiBase]   = useState(() => initApi());
  const [popup, setPopup]       = useState(null); // { items, anchorRect }

  const fileInputRef = useRef(null);
  const chatEndRef   = useRef(null);
  const textareaRef  = useRef(null);

  // auto-scroll
  const prevCountRef = useRef(0);
  useEffect(() => {
    if (messages.length > prevCountRef.current) {
      prevCountRef.current = messages.length;
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  // responsive nav: always show on wide screens
  useEffect(() => {
    const check = () => { if (window.innerWidth > 812) setNavOpen(true); };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // mobile viewport height
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => document.documentElement.style.setProperty("--vv-height", `${vv.height}px`);
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => { vv.removeEventListener("resize", update); vv.removeEventListener("scroll", update); };
  }, []);

  // ── Taskbar helpers ──────────────────────────────────────────────────────────

  const resetApi = useCallback(() => {
    clearStoredApi();
    const newApi = initApi();
    setApiBase(newApi);
  }, []);

  const handleTaskbarClick = useCallback((label, buttonEl) => {
    const items = MENU_TREE[label];
    // If the same menu is already open, close it
    if (popup && popup.label === label) { setPopup(null); return; }

    if (items.length === 0 && label !== "View" && label !== "Help") {
      setPopup(null);
      return;
    }

    const rect = buttonEl.getBoundingClientRect();
    setPopup({ label, items, anchorRect: rect });
  }, [popup]);

  const handleMenuAction = useCallback((item) => {
    setPopup(null);
    if (item === "change_API_link") resetApi();
    else if (item === "download_chat") console.log("Development under progress, coming soon");
    else if (item === "upload_chat")   console.log("Development under progress, coming soon");
  }, [resetApi]);

  // ── Message helpers ───────────────────────────────────────────────────────────

  const addMessage = useCallback((role, html, extra = {}) => {
    const id = Date.now() + Math.random();
    setMessages(prev => [...prev, { id, role, html, ...extra }]);
    return id;
  }, []);

  const updateMessage = useCallback((id, patch) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, ...patch } : m));
  }, []);

  const sendMessage = useCallback(async () => {
    if (!input.trim() && files.length === 0) return;

    const userText  = input;
    const userFiles = [...files];
    setInput("");
    setFiles([]);

    addMessage("user", parseMarkdown(userText));
    if (userFiles.length > 0) addMessage("user", `<p><em>Attached ${userFiles.length} file(s)</em></p>`);

    const botId = addMessage("bot", "", { status: "Connecting", streaming: true });

    try {
      let generated = "";
      for await (const { token, status } of generateResponse(userText, SESSION_ID, userFiles, apiBase)) {
        generated += token;
        updateMessage(botId, { html: parseMarkdown(generated), status, streaming: true });
      }
      updateMessage(botId, { streaming: false });
    } catch (err) {
      updateMessage(botId, { html: `<p style="color:#e05555">Error: ${err.message}</p>`, streaming: false });
    }
  }, [input, files, apiBase, addMessage, updateMessage]);

  const handleKeyDown    = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } };
  const handleFileChange = (e) => { 
    const picked = Array.from(e.target.files); // snapshot synchronously
    e.target.value = "";                        // now safe to reset
    if (picked.length > 0) setFiles(prev => [...prev, ...picked]);
  };
  const removeFile       = (i) => setFiles(prev => prev.filter((_, idx) => idx !== i));

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100dvh", overflow:"hidden" }}>

      {/* Header */}
      <div id="header">
        {navOpen && (
          <div id="nav-menu">
            {Object.keys(MENU_TREE).map(label => (
              <button
                key={label}
                className="task-button"
                onClick={e => handleTaskbarClick(label, e.currentTarget)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <button id="menu-toggle" aria-label="Toggle Menu" onClick={() => setNavOpen(v => !v)}>
          <span /><span /><span />
        </button>
        <h1 style={{ marginLeft:"auto" }}>omnichat</h1>
      </div>

      {/* Floating popup */}
      {popup && (
        <TaskbarPopup
          items={popup.items}
          anchorRect={popup.anchorRect}
          onSelect={handleMenuAction}
          onClose={() => setPopup(null)}
        />
      )}

      {/* Body */}
      <div className="row" style={{ flexGrow:1, minHeight:0, overflow:"hidden" }}>

        {/* Sidebar */}
        <div id="toolbar">
          {[["S","Schedule"],["T","Tool Calls"],["K","Knowledge Base"],["G","Graph"],["C","Console"]].map(([label, title]) => (
            <button key={label} title={title}>{label}</button>
          ))}
        </div>

        {/* Main column */}
        <div className="column" style={{ flex:1, minHeight:0, overflow:"hidden" }}>

          {/* Chat history */}
          <div id="chat-history" className="section">
            <h3>this is the beginning of your conversation with omnichat</h3>
            {messages.map(m =>
              m.role === "user"
                ? <UserMessage key={m.id} html={m.html} />
                : <BotMessage  key={m.id} html={m.html} status={m.status} streaming={m.streaming} />
            )}
            <div id="eoc-spacer" ref={chatEndRef} />
          </div>

          {/* Input area */}
          <div id="user-input" className="section">
            {files.length > 0 && (
              <div id="file-preview-container">
                {files.map((f, i) => (
                  <div key={i} className="file-preview-badge">
                    <span className="file-preview-icon">{getFileIcon(f.name)}</span>
                    <span className="file-preview-name" title={f.name}>{f.name}</span>
                    <button className="file-preview-remove" onClick={() => removeFile(i)}>×</button>
                  </div>
                ))}
              </div>
            )}
            <div className="input-controls-row" style={{ display:"flex", alignItems:"center", width:"100%" }}>
              <label className="media-btn-label" htmlFor="add-media">+</label>
              <input id="add-media" type="file" multiple style={{ display:"none" }} onChange={handleFileChange} />
              <textarea
                id="input-field"
                ref={textareaRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
              />
              <button id="send-button" onClick={sendMessage}>Send</button>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
