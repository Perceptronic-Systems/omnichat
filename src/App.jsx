import { useState, useEffect, useCallback } from 'react';
import { TaskbarPopup, MENU_TREE } from './taskbar.jsx';
import Chat from './pages/chat.jsx';


// ─── Main App ─────────────────────────────────────────────────────────────────

const SESSION_ID = Math.floor(Math.random() * 100_000_000);
export let activePage = 'chat';

export default function App() {
  const [navOpen, setNavOpen]   = useState(false);
  const [popup, setPopup]       = useState(null); // { items, anchorRect }
  const [activePage, setActivePage] = useState('chat');
  const [messages, setMessages] = useState([]);

  const switchPage = () => {
    switch(activePage) {
      case "chat":
        return <Chat SESSION_ID={SESSION_ID} messages={messages} setMessages={setMessages} />;
        break;
      case "tools":
        return <h1>Tools</h1>
        break;
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
          ["M", "Messages", "chat"],
          ["S","Schedule", "schedule"],
          ["T","Tool Calls", "tools"],
          ["K","Knowledge Base", "knowledge_base"],
          ["G","Graph", "graph"],
          ["C","Console", "console"]
          ].map(([label, title, id]) => (
            <button key={label} title={title} onClick={() => setPage(id)}>{label}</button>
          ))}
        </div>

        {/* Main column */}
        {switchPage()}
      </div>
    </div>
  );
}
