// Toast.tsx — retro phosphor notification toast (success / error / info).
// Slide-in from top-right; parent owns the dismiss timer and calls onClose.

import type { ReactNode } from "react";

export interface ToastProps {
  kind: "success" | "error" | "info";
  title: string;
  body?: string;
  onClose: () => void;
  /** When true (default), positions itself fixed top-right with slide-in.
   *  Set false when the parent already provides a positioned stack. */
  floating?: boolean;
}

const GLYPHS: Record<ToastProps["kind"], string> = {
  success: `┌───┐\n│ ✓ │\n└───┘`,
  error:   `┌───┐\n│ ✕ │\n└───┘`,
  info:    `┌───┐\n│ i │\n└───┘`,
};

const THEME: Record<ToastProps["kind"], { text: string; border: string; bg: string }> = {
  success: { text: "text-emerald-300", border: "border-emerald-500/40", bg: "bg-emerald-950/30" },
  error:   { text: "text-rose-300",    border: "border-rose-500/40",    bg: "bg-rose-950/30" },
  info:    { text: "text-sky-300",     border: "border-sky-500/40",     bg: "bg-sky-950/30" },
};

export function Toast({ kind, title, body, onClose, floating = true }: ToastProps): ReactNode {
  const t = THEME[kind];
  const glyph = GLYPHS[kind];
  const kindLabel = kind.toUpperCase();

  const wrapperClass = floating
    ? "fixed top-4 right-4 z-50 w-80 animate-toast-in"
    : "w-80 animate-toast-in";

  return (
    <div
      className={wrapperClass}
      role="alert"
      aria-live="polite"
    >
      <div
        className={`relative flex items-start gap-3 rounded-md border ${t.border} ${t.bg} bg-ink-950/80 p-3 font-mono text-sm shadow-lg backdrop-blur-sm`}
      >
        <pre className={`select-none ${t.text} leading-none font-bold m-0`}>{glyph}</pre>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h3 className={`flex items-center gap-2 font-bold ${t.text} text-xs`}>
              <span className="bracket-value">{`[${kindLabel}]`}</span>
              <span className="phosphor truncate">{title}</span>
            </h3>
            <button
              onClick={onClose}
              className="ml-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-zinc-500 hover:text-zinc-200 transition-colors focus:outline-none focus:ring-1 focus:ring-zinc-600"
              aria-label="Dismiss notification"
            >
              ✕
            </button>
          </div>
          {body && (
            <p className={`mt-1 text-xs ${t.text} phosphor-soft opacity-80 [overflow-wrap:anywhere]`}>
              {body}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
