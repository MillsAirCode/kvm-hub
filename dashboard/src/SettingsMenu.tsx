import { useEffect, useRef, useState } from "react";
import { CopyableText } from "./CopyableText";

/**
 * Single gear button + popover that consolidates the previously-floating
 * controls (sounds mute, push permission, scratchpad) plus retro display
 * prefs (scanlines intensity, animations toggle, theme accent).
 *
 * Persisted prefs live in localStorage and apply via CSS variables /
 * documentElement classes so other components can react without prop
 * drilling. Hydration-safe — no SSR concerns since this is Vite SPA.
 *
 * Visual style matches the rest of the dashboard's terminal/phosphor
 * aesthetic — bracketed [SECTION] headers, [ON]/[OFF] pill toggles,
 * scanline overlay on the popover, emerald accent border + drop-shadow.
 */
type Accent = "EMERALD" | "VIOLET" | "ROSE";

/** Hex form for inline-style call sites (e.g. radio button selected color). */
const ACCENT_HEX: Record<Accent, string> = {
  EMERALD: "#34d399",
  VIOLET: "#a78bfa",
  ROSE: "#fb7185",
};

/** R G B triplets (space-separated, no alpha) for the three CSS vars Tailwind
 *  consumes via `rgb(var(--x) / <alpha-value>)`. Order: [base, glow, dim]. */
const ACCENT_VARS: Record<Accent, [string, string, string]> = {
  EMERALD: ["52 211 153",  "110 231 183", "16 185 129"],
  VIOLET:  ["167 139 250", "196 181 253", "124 92 255"],
  ROSE:    ["251 113 133", "253 164 175", "225 29 72"],
};

interface SettingsMenuProps {
  muted: boolean;
  setMuted: (next: boolean) => void;
  onOpenScratch: () => void;
  className?: string;
  placement?: "up" | "down";
  /** "full" = wide row with label; "icon" = compact gear-only button. */
  variant?: "full" | "icon";
}

export default function SettingsMenu({
  muted,
  setMuted,
  onOpenScratch,
  className = "",
  placement = "up",
  variant = "full",
}: SettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const [pushState, setPushState] = useState<NotificationPermission | "unsupported">(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported",
  );
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // ── Persisted retro prefs ──────────────────────────────────────────
  const [scanlines, setScanlines] = useState(1.0);
  const [animationsOn, setAnimationsOn] = useState(true);
  const [accent, setAccent] = useState<Accent>("EMERALD");

  // Load from localStorage once on mount
  useEffect(() => {
    const sl = localStorage.getItem("kvm-hub.scanlines");
    if (sl !== null) {
      const v = parseFloat(sl);
      if (!Number.isNaN(v)) setScanlines(Math.max(0, Math.min(1, v)));
    }
    const an = localStorage.getItem("kvm-hub.animations");
    if (an !== null) setAnimationsOn(an !== "false");
    const ac = localStorage.getItem("kvm-hub.theme-accent");
    if (ac === "EMERALD" || ac === "VIOLET" || ac === "ROSE") setAccent(ac);
  }, []);

  // Persist + apply CSS side effects
  useEffect(() => {
    localStorage.setItem("kvm-hub.scanlines", String(scanlines));
    document.documentElement.style.setProperty("--scanline-opacity", String(scanlines));
  }, [scanlines]);

  useEffect(() => {
    localStorage.setItem("kvm-hub.animations", String(animationsOn));
    document.documentElement.classList.toggle("reduce-motion", !animationsOn);
  }, [animationsOn]);

  useEffect(() => {
    localStorage.setItem("kvm-hub.theme-accent", accent);
    // Bump the manual-override timestamp so TimeOfDayTheme's auto-shifter
    // backs off for 5 minutes — manual click wins over the next auto tick.
    localStorage.setItem("kvm-hub.theme-manual-override-ts", String(Date.now()));
    const [base, glow, dim] = ACCENT_VARS[accent];
    document.documentElement.style.setProperty("--accent-rgb", base);
    document.documentElement.style.setProperty("--accent-glow-rgb", glow);
    document.documentElement.style.setProperty("--accent-dim-rgb", dim);
    // Hex form kept for inline-style call sites that don't go through Tailwind.
    document.documentElement.style.setProperty("--accent-color", ACCENT_HEX[accent]);
  }, [accent]);

  // Auto-shift toggle (TimeOfDayTheme reads this localStorage key).
  const [autoTheme, setAutoTheme] = useState(true);
  useEffect(() => {
    const v = localStorage.getItem("kvm-hub.theme-auto");
    if (v !== null) setAutoTheme(v !== "false");
  }, []);
  useEffect(() => {
    localStorage.setItem("kvm-hub.theme-auto", String(autoTheme));
  }, [autoTheme]);

  // Click-outside / Esc to dismiss
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!popoverRef.current) return;
      if (!popoverRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const askPushPermission = async () => {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") {
      const result = await Notification.requestPermission();
      setPushState(result);
    }
  };

  const gearIcon = (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );

  return (
    <div className={`relative ${className}`} ref={popoverRef}>
      {variant === "icon" ? (
        <button
          onClick={() => setOpen((o) => !o)}
          className="grid place-items-center h-9 w-9 rounded-lg border border-ink-700
                     bg-ink-900/60 hover:bg-ink-800 hover:border-emerald-500/40
                     text-zinc-400 hover:text-emerald-300 transition"
          title="Settings"
          aria-label="Settings"
          aria-expanded={open}
        >
          {gearIcon}
        </button>
      ) : (
        <button
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-ink-700
                     bg-ink-900/60 hover:bg-ink-800 hover:border-emerald-500/40 text-[11px]
                     font-mono text-zinc-400 hover:text-emerald-300 transition"
          title="Settings"
          aria-label="Settings"
          aria-expanded={open}
        >
          {gearIcon}
          <span className="term-label">SETTINGS</span>
          {muted && <span className="ml-auto text-[10px] text-zinc-500">muted</span>}
        </button>
      )}

      {open && (
        <div
          className={`absolute ${
            placement === "down" ? "top-full mt-2" : "bottom-full mb-2"
          } ${
            // For variant="full" (desktop sidebar), span full trigger width so the
            // popover stays inside the sidebar's overflow-auto bounds. For variant
            // ="icon" (mobile header), pin to right edge with a fixed width.
            variant === "icon" ? "right-0 w-80" : "left-0 right-0"
          } rounded-xl border border-emerald-500/30
             bg-ink-950/95 backdrop-blur shadow-[0_0_24px_rgba(16,185,129,0.15)] z-50
             overflow-hidden font-mono text-[12px] text-zinc-300`}
          role="menu"
        >
          <div className="relative">
            {/* CRT scanline overlay */}
            <div className="scanlines pointer-events-none absolute inset-0 z-10 opacity-30" />

            <div className="relative z-0 p-4 space-y-4">

              {/* ── NOTIFICATIONS ──────────────────────────────────────── */}
              <Section title="NOTIFICATIONS">
                <Row label="SOUND">
                  <Pill
                    active={!muted}
                    label={muted ? "[ MUTED ]" : "[ ON ]"}
                    onClick={() => setMuted(!muted)}
                  />
                </Row>
                {pushState !== "unsupported" && (
                  <Row label="BROWSER PUSH">
                    {pushState === "granted" ? (
                      <Pill active label="[ ALLOWED ]" />
                    ) : pushState === "denied" ? (
                      <Pill active={false} label="[ BLOCKED ]" />
                    ) : (
                      <Pill
                        active={false}
                        label="[ REQUEST ]"
                        onClick={askPushPermission}
                      />
                    )}
                  </Row>
                )}
              </Section>

              <div className="border-t border-emerald-500/15" />

              {/* ── DISPLAY ────────────────────────────────────────────── */}
              <Section title="DISPLAY">
                {/* SCANLINES — label on its own line so the slider has room to
                    grow with the popover width. */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-zinc-400 text-[11px] tracking-wide">SCANLINES</span>
                    <span className="text-zinc-500 tabular-nums text-[11px] font-mono">
                      {scanlines.toFixed(2)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={scanlines}
                    onChange={(e) => setScanlines(parseFloat(e.target.value))}
                    className="w-full h-1 bg-ink-800 rounded-full appearance-none cursor-pointer accent-emerald-500"
                    aria-label="scanline intensity"
                  />
                </div>
                <Row label="ANIMATIONS">
                  <Pill
                    active={animationsOn}
                    label={animationsOn ? "[ ON ]" : "[ OFF ]"}
                    onClick={() => setAnimationsOn(!animationsOn)}
                  />
                </Row>
                <Row label="AUTO THEME">
                  <Pill
                    active={autoTheme}
                    label={autoTheme ? "[ AUTO ]" : "[ MANUAL ]"}
                    onClick={() => setAutoTheme(!autoTheme)}
                  />
                </Row>
                {/* THEME ACCENT — buttons on their own line so they never
                    overflow the popover width. */}
                <div className="space-y-1">
                  <span className="text-zinc-400 text-[11px] tracking-wide">THEME ACCENT</span>
                  <div className="flex gap-1">
                    {(["EMERALD", "VIOLET", "ROSE"] as const).map((a) => {
                      const isActive = accent === a;
                      return (
                        <button
                          key={a}
                          onClick={() => setAccent(a)}
                          className={`flex-1 px-1.5 py-0.5 rounded-sm border text-[10px] tracking-wider font-mono transition-all ${
                            isActive
                              ? "border-emerald-500/40 bg-emerald-500/15 phosphor"
                              : "border-ink-700/60 bg-ink-900/40 text-zinc-500 hover:text-zinc-300 hover:border-ink-600"
                          }`}
                          style={{ color: isActive ? ACCENT_HEX[a] : undefined }}
                          aria-label={`accent ${a.toLowerCase()}`}
                          aria-pressed={isActive}
                        >
                          {a}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </Section>

              <div className="border-t border-emerald-500/15" />

              {/* ── TOOLS ──────────────────────────────────────────────── */}
              <Section title="TOOLS">
                <button
                  role="menuitem"
                  onClick={() => { setOpen(false); onOpenScratch(); }}
                  className="w-full flex items-center justify-between px-2 py-1 rounded-md
                             hover:bg-emerald-500/10 transition"
                >
                  <span className="text-zinc-400">SCRATCHPAD</span>
                  <span className="text-[10px] tracking-wider text-emerald-300/80 font-mono">
                    [ OPEN ]
                  </span>
                </button>
                <ApiKeyRow />
              </Section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="bracket-value term-label text-[10px] tracking-widest text-zinc-500">
        <span className="phosphor text-emerald-300">{title}</span>
      </div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-zinc-400 text-[11px] tracking-wide">{label}</span>
      {children}
    </div>
  );
}

function ApiKeyRow() {
  const [key, setKey] = useState<string>("");
  useEffect(() => {
    setKey(localStorage.getItem("kvmhub.apiKey") || "");
  }, []);
  if (!key) return null;
  const mask = key.length > 12 ? `${key.slice(0, 4)}…${key.slice(-4)}` : "•••";
  return (
    <div className="flex items-center justify-between px-2 py-1 rounded-md">
      <span className="text-zinc-400 text-[11px] tracking-wide">API KEY</span>
      <CopyableText
        value={key}
        className="!min-h-0 font-mono text-[10px]"
        title="copy KVM Hub API key"
      >
        <span className="font-mono text-[10px] text-emerald-300/80">{mask}</span>
      </CopyableText>
    </div>
  );
}

function Pill({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick?: () => void;
}) {
  const cls = active
    ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300 phosphor"
    : "border-ink-700/60 bg-ink-900/40 text-zinc-500 hover:text-zinc-300 hover:border-ink-600";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={`inline-flex items-center justify-center px-2 py-0.5 rounded-sm border
                  font-mono text-[10px] tracking-widest transition-all duration-150
                  ${cls} ${onClick ? "cursor-pointer" : "cursor-default"}`}
    >
      {label}
    </button>
  );
}
