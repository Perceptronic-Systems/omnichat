import { parseMarkdown } from "../markdown.jsx";
import { UserMessage, BotMessage } from "../messages.jsx";
import { generateResponse } from "../api.jsx";
import { useState, useRef, useEffect, useCallback } from 'react';

// ─── File helpers ─────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getFileIcon(name) {
  const ext = name.split(".").pop().toLowerCase();
  if (["png","jpg","jpeg","gif","webp"].includes(ext)) return "🖼️";
  if (ext === "pdf") return "📕";
  if (["doc","docx","txt","md"].includes(ext)) return "📄";
  if (["js","py","html","css","json"].includes(ext)) return "💻";
  if (["mp3","wav","ogg","m4a","flac","aac"].includes(ext)) return "🎵";
  return "📁";
}

// ─── Directory-upload filtering ────────────────────────────────────────────────
const IGNORED_DIR_NAMES = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", "out", "target",
  "__pycache__", ".venv", "venv", "env", ".env", ".next", ".nuxt", "coverage",
  ".idea", ".vscode", "vendor", "bin", "obj", ".cache", ".parcel-cache",
  ".pytest_cache", ".mypy_cache", ".tox", ".gradle", ".terraform", "egg-info"
]);

const IGNORED_FILE_PATTERNS = [
  /^\.gitignore$/, /^\.gitattributes$/, /^\.dockerignore$/,
  /^\.env(\..*)?$/, /^\.env\.local$/,
  /^package-lock\.json$/, /^yarn\.lock$/, /^pnpm-lock\.yaml$/,
  /^Gemfile\.lock$/, /^poetry\.lock$/, /^Cargo\.lock$/,
  /^LICENSE(\.(md|txt))?$/i,
  /\.lock$/, /\.log$/, /^Thumbs\.db$/, /^\.DS_Store$/,
  /\.min\.(js|css)$/, /\.map$/
];

const BINARY_EXTENSIONS = new Set([
  "exe","dll","so","dylib","bin","o","obj","class","jar","war",
  "png","jpg","jpeg", "svg","gif","webp","bmp","ico",
  "mp3","wav","ogg","m4a","flac","aac","mp4","mov","avi","mkv","webm",
  "zip","tar","gz","tgz","rar","7z",
  "woff","woff2","ttf","eot","otf","pyc","wasm"
]);

const MAX_DIR_FILE_SIZE = 512 * 1024; 
const MAX_DIR_FILES = 400;            

function shouldIgnorePath(relPath) {
  const parts = relPath.split("/");
  const filename = parts[parts.length - 1];

  for (let i = 0; i < parts.length - 1; i++) {
    if (IGNORED_DIR_NAMES.has(parts[i])) return true;
  }
  if (IGNORED_FILE_PATTERNS.some(p => p.test(filename))) return true;

  const ext = filename.includes(".") ? filename.split(".").pop().toLowerCase() : "";
  if (BINARY_EXTENSIONS.has(ext)) return true;

  return false;
}

function filterDirectoryFiles(fileList) {
  const kept = [];
  let skippedCount = 0;

  for (const f of fileList) {
    const rel = f.webkitRelativePath || f.name;
    if (shouldIgnorePath(rel) || f.size > MAX_DIR_FILE_SIZE) {
      skippedCount++;
      continue;
    }
    kept.push(new File([f], rel, { type: f.type }));
    if (kept.length >= MAX_DIR_FILES) break;
  }
  return { kept, skippedCount };
}

export default function Chat({ SESSION_ID, messages, setMessages, setToolCalls, apiBase }) {
  const [input, setInput]       = useState("");
  const [files, setFiles]       = useState([]);

  const fileInputRef   = useRef(null);
  const folderInputRef = useRef(null);
  const chatEndRef      = useRef(null);
  const textareaRef     = useRef(null);

  useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute("webkitdirectory", "");
      folderInputRef.current.setAttribute("directory", "");
    }
  }, []);

  const prevCountRef = useRef(0);
  useEffect(() => {
    if (messages.length > prevCountRef.current) {
      prevCountRef.current = messages.length;
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

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
      if (userFiles.length > 0) {
        const fileListHtml = userFiles
          .map(f => `<li>${getFileIcon(f.name)} ${escapeHtml(f.name)}</li>`)
          .join("");
        addMessage("user", `<p><em>Attached ${userFiles.length} file(s):</em></p><ul class="attached-file-list">${fileListHtml}</ul>`);
      }
  
      const botId = addMessage("bot", "", { status: "Connecting", streaming: true });
  
      try {
        let generated = "";
        for await (const { token, status, tool_calls } of generateResponse(userText, SESSION_ID, userFiles, apiBase)) {
          generated += token;
          updateMessage(botId, { html: parseMarkdown(generated), status, streaming: true });
          if (tool_calls && tool_calls.function?.name) {
            setToolCalls(prev => [...prev, tool_calls]);
          }
        }
        updateMessage(botId, { streaming: false });
      } catch (err) {
        updateMessage(botId, { html: `<p style="color:#e05555">Error: ${err.message}</p>`, streaming: false });
      }
    }, [input, files, apiBase, addMessage, updateMessage]);
  
    const handleKeyDown    = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } };

    const handleFileChange = (e) => {
      const picked = Array.from(e.target.files); 
      e.target.value = "";                        
      if (picked.length > 0) setFiles(prev => [...prev, ...picked]);
    };

    const handleFolderChange = (e) => {
      const picked = Array.from(e.target.files);
      e.target.value = "";
      if (picked.length === 0) return;

      const { kept, skippedCount } = filterDirectoryFiles(picked);
      if (kept.length > 0) setFiles(prev => [...prev, ...kept]);
    };

    const removeFile       = (i) => setFiles(prev => prev.filter((_, idx) => idx !== i));

    // ─── Drag and Drop Handlers ───────────────────────────────────────────────
    const handleDragOver = (e) => {
      e.preventDefault(); // Required to allow dropping
    };

    const handleDrop = (e) => {
      e.preventDefault();
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const picked = Array.from(e.dataTransfer.files);
        setFiles(prev => [...prev, ...picked]);
        e.dataTransfer.clearData();
      }
    };

    // ─── Clipboard Paste Handler ─────────────────────────────────────────────
    const handlePaste = (e) => {
      if (e.clipboardData.files && e.clipboardData.files.length > 0) {
        e.preventDefault(); // Stop file binary info or name string from filling the textarea
        const picked = Array.from(e.clipboardData.files);
        setFiles(prev => [...prev, ...picked]);
      }
    };

<<<<<<< HEAD
  return <div className="column" style={{ flex: 1, minHeight:0, overflow:"hidden" }}>
=======
  return <div className="column" style={{ flex:1, minHeight:0, overflow:"hidden" }}>
>>>>>>> origin/main
    
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
              <div 
                id="user-input" 
                className="section"
                onDragOver={handleDragOver}
                onDrop={handleDrop}
              >
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
                  <div className="column" style={{ padding: 0, margin: 0, height: "100%" }}>
                    <label className="media-btn-label" htmlFor="add-media" title="Attach file" style={{ marginBottom: '4px' }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21.44 11.05l-9.19 9.19a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a1.5 1.5 0 0 1-2.12-2.12l8.49-8.48" />
                      </svg>
                    </label>
                    <input id="add-media" ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={handleFileChange} />

                    <label className="media-btn-label" htmlFor="add-folder" title="Attach directory" style={{ marginTop: '4px' }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                        <line x1="12" y1="11" x2="12" y2="17" />
                        <line x1="9" y1="14" x2="15" y2="14" />
                      </svg>
                    </label>
                    <input id="add-folder" ref={folderInputRef} type="file" multiple style={{ display: "none" }} onChange={handleFolderChange} />
                  </div>

                  <textarea
                    id="input-field"
                    ref={textareaRef}
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                  />
                  <button id="send-button" onClick={sendMessage}>Send</button>
                </div>
              </div>
    
            </div>
}