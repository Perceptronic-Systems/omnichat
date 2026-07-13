import { useEffect, useRef } from 'react';

export const MENU_TREE = {
  File: ["download_chat", "upload_chat"],
  Edit: ["change_API_link"],
  View: [],
  Theme: ["default", "matrix", "cyberpunk", "minimal", "solar"],
  Help: [],
};

export function TaskbarPopup({ items, anchorRect, onSelect, onClose }) {
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