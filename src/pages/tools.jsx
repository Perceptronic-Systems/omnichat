import { useState } from 'react';

function ArgTable({ args }) {
  if (!args || typeof args !== 'object' || Object.keys(args).length === 0) {
    return <span className="tc-no-args">no arguments</span>;
  }
  return (
    <table className="tc-arg-table">
      <tbody>
        {Object.entries(args).map(([k, v]) => (
          <tr key={k}>
            <td className="tc-arg-key">{k}</td>
            <td className="tc-arg-val">
              {typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ToolCallCard({ call, index }) {
  const [open, setOpen] = useState(false);
  const args = call.function?.arguments ?? {};

  return (
    <div className="tc-card">
      <button className="tc-card-header" onClick={() => setOpen(v => !v)}>
        <span className="tc-index">#{index + 1}</span>
        <span className="tc-name">{call.function?.name ?? 'unknown'}</span>
        <span className="tc-arg-count">
          {Object.keys(args).length} arg{Object.keys(args).length !== 1 ? 's' : ''}
        </span>
        <span className="tc-chevron">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="tc-body">
          <ArgTable args={args} />
        </div>
      )}
    </div>
  );
}

export default function Tools({ toolCalls = [] }) {
  return (
    <div className="column tc-panel" style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
      <div className="tc-header-bar">
        <span className="tc-title">Tool Calls</span>
        <span className="tc-count">{toolCalls.length}</span>
      </div>

      <div className="tc-list">
        {toolCalls.length === 0 ? (
          <p className="tc-empty">No tool calls yet. Send a message that requires tool use to see them here.</p>
        ) : (
          toolCalls.map((call, i) => (
            <ToolCallCard key={i} call={call} index={i} />
          ))
        )}
      </div>

      <style>{`
        .tc-panel {
          display: flex;
          flex-direction: column;
        }

        .tc-header-bar {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 16px;
          border-bottom: 1px solid var(--border, #333);
          flex-shrink: 0;
        }

        .tc-title {
          font-size: 0.75rem;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          opacity: 0.6;
        }

        .tc-count {
          font-size: 0.7rem;
          background: var(--accent, #4a9eff);
          color: #fff;
          border-radius: 10px;
          padding: 1px 7px;
          font-weight: 700;
        }

        .tc-list {
          flex: 1;
          overflow-y: auto;
          padding: 10px 12px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .tc-empty {
          font-size: 0.82rem;
          opacity: 0.45;
          text-align: center;
          margin-top: 40px;
          line-height: 1.6;
        }

        .tc-card {
          border: 1px solid var(--border, #333);
          border-radius: 6px;
          overflow: hidden;
        }

        .tc-card-header {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 12px;
          background: var(--surface, #1e1e1e);
          border: none;
          cursor: pointer;
          text-align: left;
          font-family: inherit;
          color: inherit;
        }

        .tc-card-header:hover {
          background: var(--surface-hover, #2a2a2a);
        }

        .tc-index {
          font-size: 0.68rem;
          opacity: 0.35;
          min-width: 24px;
          font-variant-numeric: tabular-nums;
        }

        .tc-name {
          flex: 1;
          font-size: 0.83rem;
          font-family: monospace;
          font-weight: 600;
          color: var(--accent, #4a9eff);
        }

        .tc-arg-count {
          font-size: 0.7rem;
          opacity: 0.45;
        }

        .tc-chevron {
          font-size: 0.75rem;
          opacity: 0.5;
        }

        .tc-body {
          padding: 10px 12px;
          border-top: 1px solid var(--border, #333);
          background: var(--bg, #141414);
        }

        .tc-no-args {
          font-size: 0.75rem;
          opacity: 0.35;
          font-style: italic;
        }

        .tc-arg-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.78rem;
        }

        .tc-arg-table tr + tr td {
          padding-top: 5px;
        }

        .tc-arg-key {
          font-family: monospace;
          color: var(--accent-soft, #7ec8e3);
          padding-right: 14px;
          vertical-align: top;
          white-space: nowrap;
          opacity: 0.85;
          width: 1%;
        }

        .tc-arg-val {
          font-family: monospace;
          color: var(--text, #ddd);
          word-break: break-all;
          white-space: pre-wrap;
          opacity: 0.9;
        }
      `}</style>
    </div>
  );
}