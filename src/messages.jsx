import { useRef, useEffect, useState } from 'react';

export function BotMessage({ html, status, streaming }) {
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

export function UserMessage({ html }) {
  return (
    <div className="message">
      <div className="user" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

// ------ Spinner ------

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