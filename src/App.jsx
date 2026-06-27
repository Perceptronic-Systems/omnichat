import { useState, useRef, useEffect, useCallback } from "react";
import { parseMarkdown } from "./markdown.jsx";
import { UserMessage, BotMessage } from "./messages.jsx";
import { initApi, clearStoredApi, generateResponse } from "./api.jsx";
import { TaskbarPopup, MENU_TREE } from './taskbar.jsx';

// ─── File helpers ─────────────────────────────────────────────────────────────

function getFileIcon(name) {
  const ext = name.split(".").pop().toLowerCase();
  if (["png","jpg","jpeg","gif","webp"].includes(ext)) return "🖼️";
  if (ext === "pdf") return "📕";
  if (["doc","docx","txt","md"].includes(ext)) return "📄";
  if (["js","py","html","css","json"].includes(ext)) return "💻";
  return "📁";
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
          {[
          ["S","Schedule"],
          ["T","Tool Calls"],
          ["K","Knowledge Base"],
          ["G","Graph"],
          ["C","Console"]
          ].map(([label, title]) => (
            <button key={label} title={title}>{label}</button>
          ))}
        </div>

        {/* Main column */}
        <div className="column" style={{ flex:1, minHeight:0, overflow:"hidden" }}>

          {/* Chat history */}
          <div id="chat-history" className="section">
            <h3 className="initial-message">this is the beginning of your conversation with omnichat</h3>
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
