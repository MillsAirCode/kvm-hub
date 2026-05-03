import { useEffect, useState } from "react";

/**
 * Persistent right-side Telegram Web pane, desktop-only. Toggle to
 * collapse to a thin tab handle. Mobile users open Telegram natively;
 * this component renders nothing on small screens.
 *
 * State (open + width) persists in localStorage so it survives reloads.
 */

const STORAGE_KEY = "kvm-hub.telegram-sidebar";
const DEFAULT_WIDTH = 380;

type State = { open: boolean; width: number };

function readState(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        open: typeof p.open === "boolean" ? p.open : true,
        width: typeof p.width === "number" ? Math.max(280, Math.min(720, p.width)) : DEFAULT_WIDTH,
      };
    }
  } catch { /* noop */ }
  return { open: true, width: DEFAULT_WIDTH };
}

export default function TelegramSidebar() {
  const [state, setState] = useState<State>(() => readState());
  const [reload, setReload] = useState(0);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch { /* noop */ }
    // Notify the rest of the app so the main content can adjust its right
    // padding to avoid sliding under the sidebar.
    document.documentElement.style.setProperty(
      "--tg-sidebar-w",
      state.open ? `${state.width}px` : "44px",
    );
  }, [state]);

  // Drag-to-resize on the left edge handle. The iframe would otherwise
  // capture mousemove/mouseup events when the cursor crosses it during
  // the drag — making the resize "latch" and only grow. We flip
  // `resizing` to render an overlay that blocks the iframe and sets
  // pointer-events: none on it.
  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = state.width;
    setResizing(true);
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(280, Math.min(720, startW + (startX - ev.clientX)));
      setState((s) => ({ ...s, width: next }));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setResizing(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  if (!state.open) {
    return (
      <button
        onClick={() => setState((s) => ({ ...s, open: true }))}
        className="hidden lg:flex fixed right-0 top-1/2 -translate-y-1/2 z-30
                   bg-ink-900/90 border border-r-0 border-accent/40 text-accent-glow
                   px-2 py-4 rounded-l-lg flex-col items-center gap-2 shadow-[0_0_20px_rgba(52,211,153,0.25)]
                   hover:bg-ink-800 hover:border-accent/70 transition"
        title="Open Telegram"
      >
        <span className="text-[10px] [writing-mode:vertical-rl] tracking-wider">Telegram</span>
        <span className="text-base">💬</span>
      </button>
    );
  }

  return (
    <aside
      className="hidden lg:flex fixed right-0 top-0 bottom-0 z-30 bg-ink-950/95 backdrop-blur
                 border-l border-ink-800 flex-col"
      style={{ width: state.width }}
    >
      {/* Resize handle */}
      <div
        onMouseDown={onDragStart}
        className="absolute top-0 left-0 w-1 h-full cursor-col-resize hover:bg-accent/40 transition"
        title="Drag to resize"
      />

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-ink-800 shrink-0">
        <span className="text-base">💬</span>
        <div className="text-sm font-semibold tracking-tight">Telegram</div>
        <div className="text-[10px] text-zinc-500 ml-auto">embedded · {state.width}px</div>
        <button
          onClick={() => setReload((r) => r + 1)}
          className="text-[10px] text-zinc-500 hover:text-zinc-200 px-1.5 py-0.5 rounded border border-ink-700"
          title="Reload"
        >
          ↻
        </button>
        <a
          href="/tg/"
          target="_blank"
          rel="noreferrer"
          className="text-[10px] text-zinc-500 hover:text-zinc-200 px-1.5 py-0.5 rounded border border-ink-700"
          title="Open in new tab"
        >
          ↗
        </a>
        <button
          onClick={() => setState((s) => ({ ...s, open: false }))}
          className="text-[10px] text-zinc-400 hover:text-zinc-100 px-1.5 py-0.5 rounded border border-ink-700"
          title="Collapse sidebar"
        >
          →
        </button>
      </div>

      {/* Iframe — pointer events suppressed during drag so resize works */}
      <iframe
        key={reload}
        src="/tg/"
        title="Telegram Web"
        className="flex-1 w-full"
        style={{ border: 0, pointerEvents: resizing ? "none" : "auto" }}
        sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-modals allow-downloads"
        allow="clipboard-read; clipboard-write; camera; microphone"
      />

      {/* Drag overlay covers the entire sidebar while resizing so the
          mouseup never gets stolen by the iframe. */}
      {resizing && (
        <div className="absolute inset-0 z-50 cursor-col-resize select-none" />
      )}
    </aside>
  );
}
