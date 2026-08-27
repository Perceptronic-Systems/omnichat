import { useState, useEffect, useCallback, useRef } from 'react';

function formatSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

function formatDate(epochSeconds) {
  if (!epochSeconds) return "—";
  return new Date(epochSeconds * 1000).toLocaleString();
}

function fileIcon(entry) {
  if (entry.type === "directory") return " ";  /* nf-fa-folder */
  if (entry.type === "symlink") return " ";    /* nf-fa-link */
  
  const ext = entry.name.includes(".") ? entry.name.split(".").pop().toLowerCase() : "";
  
  if (["png","jpg","jpeg","gif","webp","bmp","svg"].includes(ext)) return "󰋩 "; /* nf-md-image */
  if (ext === "pdf") return " ";                                              /* nf-fa-file_pdf_o */
  if (["doc","docx","txt","md"].includes(ext)) return " ";                     /* nf-fa-file_text_o */
  if (["js","py","html","css","json","sh","ts","jsx"].includes(ext)) return " ";/* nf-fa-code */
  if (["mp3","wav","ogg","m4a","flac","aac"].includes(ext)) return " ";      /* nf-fa-file_audio_o */
  
  return " "; /* nf-fa-file_o (default) */
}

const WORKSPACE_ROOT = "/workspace";

function joinPath(base, name) {
  return base === "/" ? "/" + name : base.replace(/\/$/, "") + "/" + name;
}

function parentPath(path) {
  if (path === WORKSPACE_ROOT) return WORKSPACE_ROOT;
  const trimmed = path.replace(/\/$/, "");
  const idx = trimmed.lastIndexOf("/");
  const parent = idx <= 0 ? "/" : trimmed.slice(0, idx);
  // Never surface anything above the workspace root -- matches the
  // backend's own confinement in mcp_server.py's _confine_to_workspace.
  return parent.length < WORKSPACE_ROOT.length ? WORKSPACE_ROOT : parent;
}

function breadcrumbParts(path) {
  if (path === WORKSPACE_ROOT) return [];
  const rel = path.startsWith(WORKSPACE_ROOT + "/") ? path.slice(WORKSPACE_ROOT.length) : path;
  return rel.split("/").filter(Boolean);
}

export default function Files({ apiBase, sessionId = 0 }) { 
  const [path, setPath] = useState(WORKSPACE_ROOT);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const uploadInputRef = useRef(null);

  // Declare browserMode at the top of the component scope so all callbacks can access it
  const browserMode = apiBase === "browser";

  const load = useCallback(async (targetPath) => {
    if (browserMode) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}files/list?session_id=${sessionId}&path=${encodeURIComponent(targetPath)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setEntries(data.entries || []);
    } catch (e) {
      setError(e.message);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [apiBase, browserMode, sessionId]);

  useEffect(() => { load(path); }, [path, load]);

  const openEntry = useCallback(async (entry) => {
    const fullPath = joinPath(path, entry.name);
    if (entry.type === "directory") { setPath(fullPath); return; }
    setPreviewLoading(true);
    setPreview({ name: entry.name, path: fullPath });
    try {
      const res = await fetch(`${apiBase}files/read?session_id=${sessionId}&path=${encodeURIComponent(fullPath)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setPreview({ name: entry.name, path: fullPath, ...data });
    } catch (e) {
      setPreview({ name: entry.name, path: fullPath, error: e.message });
    } finally {
      setPreviewLoading(false);
    }
  }, [apiBase, path, sessionId]);

  const downloadEntry = useCallback((entry) => {
    const fullPath = joinPath(path, entry.name);
    window.open(`${apiBase}files/download?session_id=${sessionId}&path=${encodeURIComponent(fullPath)}`, "_blank");
  }, [apiBase, path, sessionId]);

  const deleteEntry = useCallback(async (entry) => {
    const fullPath = joinPath(path, entry.name);
    if (!window.confirm(`Delete "${entry.name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`${apiBase}files/delete?session_id=${sessionId}&path=${encodeURIComponent(fullPath)}`, { method: "DELETE" });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      load(path);
      if (preview?.path === fullPath) setPreview(null);
    } catch (e) {
      alert(`Could not delete: ${e.message}`);
    }
  }, [apiBase, path, load, preview, sessionId]);

  const makeFolder = useCallback(async () => {
    const name = window.prompt("New folder name:");
    if (!name) return;
    try {
      const form = new FormData();
      form.append("session_id", sessionId);
      form.append("path", joinPath(path, name));
      const res = await fetch(`${apiBase}files/mkdir`, { method: "POST", body: form });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      load(path);
    } catch (e) {
      alert(`Could not create folder: ${e.message}`);
    }
  }, [apiBase, path, load, sessionId]);

  const handleUpload = useCallback(async (e) => {
    const picked = Array.from(e.target.files || []);
    e.target.value = "";
    for (const file of picked) {
      const form = new FormData();
      form.append("session_id", sessionId);
      form.append("path", path);
      form.append("file", file);
      try {
        const res = await fetch(`${apiBase}files/upload`, { method: "POST", body: form });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
      } catch (err) {
        alert(`Could not upload "${file.name}": ${err.message}`);
      }
    }
    load(path);
  }, [apiBase, path, load, sessionId]);

  const crumbs = breadcrumbParts(path);

  if (browserMode) {
    return (
      <div className="column" style={{ flex: 1, minHeight: 0, overflow: "hidden", padding: "2rem" }}>
        <h3>File manager unavailable</h3>
        <p>The file manager browses files inside the connected Omnichat server's sandbox
           container, so it isn't available in local browser mode. Use "Change API Link" to
           connect to a server.</p>
      </div>
    );
  }

  return (
    <div className="row" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
      <div className="column" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <div className="section file-manager-toolbar" style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <button onClick={() => setPath(WORKSPACE_ROOT)} title="Root"> </button>
          <button onClick={() => setPath(parentPath(path))} disabled={path === WORKSPACE_ROOT} title="Up one level"> </button>
          <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
            <span style={{ cursor: "pointer" }} onClick={() => setPath(WORKSPACE_ROOT)}>root</span>
            {crumbs.map((part, i) => {
              const crumbPath = WORKSPACE_ROOT + "/" + crumbs.slice(0, i + 1).join("/");
              return (
                <span key={crumbPath}>
                  {" / "}
                  <span style={{ cursor: "pointer" }} onClick={() => setPath(crumbPath)}>{part}</span>
                </span>
              );
            })}
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: "0.5rem" }}>
            <button onClick={() => load(path)} title="Refresh"> </button>
            <button onClick={makeFolder} title="New folder">  </button>
            <label style={{ cursor: "pointer" }} title="Upload files">
                Upload
              <input ref={uploadInputRef} type="file" multiple style={{ display: "none" }} onChange={handleUpload} />
            </label>
          </div>
        </div>

        <div className="section" style={{ flex: 1, overflow: "auto" }}>
          {loading && <p>Loading…</p>}
          {error && <p style={{ color: "#e05555" }}>Error: {error}</p>}
          {!loading && !error && entries.length === 0 && <p>This folder is empty.</p>}
          {!loading && !error && entries.length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left" }}>
                  <th></th><th>Name</th><th>Size</th><th>Modified</th><th></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.name}>
                    <td style={{ cursor: "pointer" }} onClick={() => openEntry(entry)}>{fileIcon(entry)}</td>
                    <td style={{ cursor: "pointer" }} onClick={() => openEntry(entry)}>{entry.name}</td>
                    <td>{entry.type === "directory" ? "—" : formatSize(entry.size)}</td>
                    <td>{formatDate(entry.mtime)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {entry.type !== "directory" && (
                        <button className="download-file" onClick={() => downloadEntry(entry)} title="Download"> </button>
                      )}
                      <button className="delete-file" onClick={() => deleteEntry(entry)} title="Delete"> </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {preview && (
        <div className="column" style={{ width: "40%", minWidth: "280px", borderLeft: "1px solid rgba(255,255,255,0.1)", overflow: "auto" }}>
          <div className="section" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong>{preview.name}</strong>
            <button className='hide-file-preview' onClick={() => setPreview(null)}> </button>
          </div>
          <div className="section" style={{ flex: 1, overflow: "auto" }}>
            {previewLoading && <p>Loading preview…</p>}
            {!previewLoading && preview.error && <p style={{ color: "#e05555" }}>Error: {preview.error}</p>}
            {!previewLoading && !preview.error && preview.binary && (
              <p>This is a binary file and can't be previewed. Use the download button instead.</p>
            )}
            {!previewLoading && !preview.error && !preview.binary && (
              <>
                {preview.truncated && <p><em>Preview truncated — download for full contents.</em></p>}
                <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{preview.content}</pre>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}