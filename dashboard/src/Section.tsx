import { useEffect, useState, type ReactNode } from "react";

/**
 * Collapsible section header. On mobile (< 1024px aka lg breakpoint) sections
 * default to collapsed unless the caller passes `defaultOpen`. On desktop they
 * stay open by default.
 *
 * Persists user toggle to localStorage so opening a section once "remembers."
 */
export default function Section({
  id,
  title,
  hint,
  defaultOpenMobile = false,
  alwaysOpenDesktop = true,
  children,
}: {
  id: string;
  title: ReactNode;
  hint?: ReactNode;
  defaultOpenMobile?: boolean;
  alwaysOpenDesktop?: boolean;
  children: ReactNode;
}) {
  const isDesktop = useIsDesktop();
  const storageKey = `kvm-hub.section:${id}`;
  const [open, setOpen] = useState<boolean>(() => {
    const stored = localStorage.getItem(storageKey);
    if (stored != null) return stored === "1";
    return defaultOpenMobile;
  });

  useEffect(() => {
    if (isDesktop && alwaysOpenDesktop) return; // don't persist desktop state
    localStorage.setItem(storageKey, open ? "1" : "0");
  }, [open, isDesktop, alwaysOpenDesktop, storageKey]);

  // On desktop, don't render the toggle — content is always visible
  if (isDesktop && alwaysOpenDesktop) {
    return <div data-section={id}>{children}</div>;
  }

  return (
    <div data-section={id} className="rounded-xl border border-ink-700/70 bg-ink-900/30 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-ink-800/50 transition"
      >
        <svg
          viewBox="0 0 24 24"
          className={`h-3.5 w-3.5 text-zinc-500 shrink-0 transition-transform ${
            open ? "rotate-90" : ""
          }`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
        <span className="text-sm font-semibold tracking-tight">{title}</span>
        {hint && <span className="ml-auto text-[10px] text-zinc-500 truncate">{hint}</span>}
      </button>
      {/* Always mount children so their useEffect-based fetches run even
          when the section is collapsed. Hide visually with CSS rather than
          unmounting — opening the section is then instant. */}
      <div className={`px-1 sm:px-2 pb-3 ${open ? "" : "hidden"}`}>
        {children}
      </div>
    </div>
  );
}

function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.matchMedia("(min-width: 1024px)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isDesktop;
}
