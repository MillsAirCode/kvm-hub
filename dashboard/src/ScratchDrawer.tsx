import { useEffect } from "react";
import ScratchPad from "./ScratchPad";

/**
 * Slide-in scratchpad drawer. Open state lives in App so the Settings menu
 * can trigger it; we no longer render a floating button (it overlapped
 * other UI). Esc closes.
 */
export default function ScratchDrawer({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: (next: boolean) => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px]"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        className="absolute left-0 bottom-0 top-0 w-full sm:w-[440px] bg-ink-950
                   border-r border-ink-800 shadow-2xl flex flex-col animate-[slideIn_180ms_ease-out]"
        style={{ animation: "slideIn 180ms ease-out" }}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-ink-800">
          <span className="text-base">📝</span>
          <div className="text-sm font-semibold tracking-tight">Scratchpad</div>
          <button
            onClick={() => setOpen(false)}
            className="ml-auto text-zinc-500 hover:text-zinc-100 px-2 py-1"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <ScratchPad />
        </div>
        <div className="text-[10px] text-zinc-600 font-mono px-4 py-2 border-t border-ink-800">
          /home/remote/kvm-hub/scratchpad.md · esc to close
        </div>
      </div>
    </div>
  );
}
