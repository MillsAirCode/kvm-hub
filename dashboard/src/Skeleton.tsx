import { useEffect, useState } from "react";

/**
 * Loading primitives — terminal/retro flavored. Replaced the original
 * shimmering-rectangle skeletons with ASCII-flavored placeholders so loading
 * states match the rest of the dashboard's CRT aesthetic.
 */

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function BrailleSpinner({ className = "" }: { className?: string }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setI((v) => (v + 1) % BRAILLE_FRAMES.length), 90);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span
      className={`inline-block font-mono text-emerald-400 phosphor ${className}`}
      aria-hidden="true"
    >
      {BRAILLE_FRAMES[i]}
    </span>
  );
}

/**
 * Bracket-style placeholder — looks like `[··········]` while loading.
 * Mimics the visual weight of the old skeleton block but uses dots inside
 * brackets so it reads as "data not yet arrived" rather than "broken div."
 */
export function Skeleton({
  className = "",
  // legacy `rounded` kwarg accepted for back-compat with old callers; unused
  rounded: _rounded = "",
}: {
  className?: string;
  rounded?: string;
}) {
  return (
    <span
      className={`inline-flex items-center font-mono text-emerald-700/70 ${className}`}
      style={{ minHeight: "1em" }}
      aria-hidden="true"
    >
      <span className="opacity-50">[</span>
      <span className="flex-1 overflow-hidden">
        {"·".repeat(48)}
      </span>
      <span className="opacity-50">]</span>
    </span>
  );
}

/** Card-shaped skeleton — terminal block with a faint braille spinner. */
export function AgentCardSkeleton() {
  return (
    <div className="card p-4 sm:p-5 font-mono text-emerald-700/70 text-[12px] leading-relaxed">
      <div className="flex items-center gap-2 mb-3">
        <BrailleSpinner />
        <span>booting agent…</span>
      </div>
      <div>{"NAME    : [··················]"}</div>
      <div>{"MODEL   : [··················]"}</div>
      <div>{"STATUS  : [··········]"}</div>
      <div className="mt-3">{"────────────────────────────────"}</div>
      <div>{"$ awaiting handshake…"}</div>
    </div>
  );
}

/** Kanban-column-shaped skeleton. */
export function KanbanColumnSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="card p-3 sm:p-4 space-y-2 font-mono text-emerald-700/70 text-[11px]">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5">
          <BrailleSpinner />
          <span>loading column…</span>
        </span>
        <span className="opacity-60">[--]</span>
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="border border-ink-800 rounded p-2">
          <div>{"┌─ task #" + (i + 1).toString().padStart(3, "0") + " ─┐"}</div>
          <div>{"│ [···························] │"}</div>
          <div>{"└──────────────────────────────┘"}</div>
        </div>
      ))}
    </div>
  );
}
