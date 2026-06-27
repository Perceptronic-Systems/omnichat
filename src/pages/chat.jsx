import { parseMarkdown } from "../markdown.jsx";
import { UserMessage, BotMessage } from "../messages.jsx";
import { initApi, clearStoredApi, generateResponse } from "../api.jsx";
import { useState, useRef, useEffect, useCallback } from 'react';

// ─── File helpers ─────────────────────────────────────────────────────────────

function getFileIcon(name) {
  const ext = name.split(".").pop().toLowerCase();
  if (["png","jpg","jpeg","gif","webp"].includes(ext)) return "🖼️";
  if (ext === "pdf") return "📕";
  if (["doc","docx","txt","md"].includes(ext)) return "📄";
  if (["js","py","html","css","json"].includes(ext)) return "💻";
  return "📁";
}

export default function Chat({ SESSION_ID, messages, setMessages, setToolCalls}) {
  const [apiBase, setApiBase]   = useState(() => initApi());
  const [input, setInput]       = useState("");
  const [files, setFiles]       = useState([]);

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
      const picked = Array.from(e.target.files); // snapshot synchronously
      e.target.value = "";                        // now safe to reset
      if (picked.length > 0) setFiles(prev => [...prev, ...picked]);
    };
    const removeFile       = (i) => setFiles(prev => prev.filter((_, idx) => idx !== i));

  return <div className="column" style={{ flex:1, minHeight:0, overflow:"hidden" }}>
    
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
}