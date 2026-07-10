import { useState, useEffect, useCallback } from 'react';
import { TaskbarPopup, MENU_TREE } from './taskbar.jsx';
import Chat from './pages/chat.jsx';
import Tools from './pages/tools.jsx';
import Files from './pages/files.jsx';
import { initApi, clearStoredApi } from './api.jsx';


// ─── Main App ─────────────────────────────────────────────────────────────────

const SESSION_ID = Math.floor(Math.random() * 100_000_000);
export let activePage = 'chat';

export default function App() {
  const [navOpen, setNavOpen]   = useState(false);
  const [popup, setPopup]       = useState(null); // { items, anchorRect }
  const [activePage, setActivePage] = useState('chat');
  const [messages, setMessages] = useState([]);
  const [toolCalls, setToolCalls] = useState([]);
  const [apiBase, setApiBase]   = useState(() => initApi());

  const switchPage = () => {
    switch(activePage) {
      case "chat":
        return (
          <Chat
            SESSION_ID={SESSION_ID}
            messages={messages}
            setMessages={setMessages}
            setToolCalls={setToolCalls}
            apiBase={apiBase}              // <-- new
          />
        );
      case "tools":
        return <Tools toolCalls={toolCalls} />;
        break;
      case "files":
        return <Files apiBase={apiBase} />;
    }
  }

  const setPage = (newPage) => {
    setActivePage(newPage);
  }

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
          ["icons/chat.svg", "Chat", "chat"],
          ["icons/voice.svg", "Voice Chat", "voice"],
          ["icons/folders.svg", "Files", "files"],
          ["icons/calendar.svg","Schedule", "schedule"],
          ["icons/wrench.svg","Tool Calls", "tools"]
          ].map(([path, title, id]) => (
            <button key={id} title={title} onClick={() => setPage(id)}><img src={path} style={{width: '1.8rem', height: '1.8rem', filter: 'invert(100%)', opacity: "30%"}} alt={title} /></button>
          ))}
        </div>

        {/* Main column */}
        {switchPage()}
      </div>
    </div>
  );
}
