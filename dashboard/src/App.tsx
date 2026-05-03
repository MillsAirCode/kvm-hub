import { useEffect, useRef, useState, type ReactNode } from "react";
import AgentDeck from "./AgentDeck";
import LiveView from "./LiveView";
import FleetView from "./FleetView";
import LogsView from "./LogsView";
import MemoryView from "./MemoryView";
import Tasks from "./Tasks";
import CommandPalette from "./CommandPalette";
import TelegramSidebar from "./TelegramSidebar";
import Notifications, { MUTE_KEY } from "./Notifications";
import ScratchDrawer from "./ScratchDrawer";
import SettingsMenu from "./SettingsMenu";
import BootSequence from "./BootSequence";
import Screensaver from "./Screensaver";
import { Toast } from "./Toast";
import KeyboardHelp from "./KeyboardHelp";
import MobileBottomTabBar from "./MobileBottomTabBar";
import TimeOfDayTheme from "./TimeOfDayTheme";

export type Tab = "live" | "agents" | "fleet" | "logs" | "memory" | "tasks";

const TABS: Tab[] = ["live", "agents", "fleet", "logs", "memory", "tasks"];

const TAB_HINTS: Record<Tab, string> = {
  live: "workflow + activity stream",
  agents: "per-agent control panels",
  fleet: "machines + hosts + toolkits",
  logs: "live log tail · filter · per-agent",
  memory: "Honcho shared memory",
  tasks: "shared task queue",
};

export const TAB_ICONS: Record<Tab, ReactNode> = {
  live: (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 5v.01M12 19v.01M5 12h.01M19 12h.01M7.05 7.05l.01.01M16.94 16.94l.01.01M7.05 16.94l.01.01M16.94 7.05l.01.01" />
    </svg>
  ),
  agents: (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="8" r="3" />
      <circle cx="17" cy="10" r="2" />
      <path d="M3 20c.5-3 3-5 6-5s5.5 2 6 5M14 20c.3-2 1.5-3 3-3s2.7 1 3 3" />
    </svg>
  ),
  fleet: (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01M11 7h6M11 17h6" />
    </svg>
  ),
  logs: (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5h16M4 9h12M4 13h16M4 17h10" />
    </svg>
  ),
  memory: (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 4a3.5 3.5 0 0 0-3.5 3.5v.5a3 3 0 0 0-2 5.5 3 3 0 0 0 2 5.5V20a3 3 0 0 0 6 0V4.5A.5.5 0 0 0 11.5 4z" />
      <path d="M14.5 4a3.5 3.5 0 0 1 3.5 3.5v.5a3 3 0 0 1 2 5.5 3 3 0 0 1-2 5.5V20a3 3 0 0 1-6 0" />
    </svg>
  ),
  tasks: (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </svg>
  ),
};


type FleetSummary = { total: number; online: number };

type Summary = { fleet: FleetSummary; agents: number; tasks_in_flight: number };

async function fetchSummary(): Promise<Summary | null> {
  try {
    const r = await fetch("/api/summary");
    if (!r.ok) return null;
    return (await r.json()) as Summary;
  } catch {
    return null;
  }
}

function StatusPills({ fleet, agents, tasks }: { fleet: FleetSummary; agents: number; tasks: number }) {
  const allOnline = fleet.online === fleet.total && fleet.total > 0;
  return (
    <div className="flex items-center gap-3 flex-wrap font-mono text-[11px]">
      <span className="inline-flex items-center gap-1.5 text-zinc-400">
        <span className={allOnline ? "text-emerald-400 phosphor" : "text-amber-400"}>
          {allOnline ? "[OK]" : "[!!]"}
        </span>
        <span className="tabular-nums text-zinc-200">
          {fleet.online}/{fleet.total}
        </span>
        <span className="text-zinc-500 uppercase tracking-wider">hosts</span>
      </span>
      <span className="text-ink-700">·</span>
      <span className="inline-flex items-center gap-1.5 text-zinc-400">
        <span className="text-emerald-400 phosphor">[ON]</span>
        <span className="tabular-nums text-zinc-200">{agents}</span>
        <span className="text-zinc-500 uppercase tracking-wider">agents</span>
      </span>
      {tasks > 0 && (
        <>
          <span className="text-ink-700">·</span>
          <span className="inline-flex items-center gap-1.5 text-zinc-400">
            <span className="text-sky-400 animate-pulse">[•••]</span>
            <span className="tabular-nums text-zinc-200">{tasks}</span>
            <span className="text-zinc-500 uppercase tracking-wider">in flight</span>
          </span>
        </>
      )}
    </div>
  );
}

export default function App() {
  const [booted, setBooted] = useState<boolean>(
    () => typeof sessionStorage !== "undefined" && !!sessionStorage.getItem("kvmhub.bootSeen"),
  );
  const [tab, setTab] = useState<Tab>(() => {
    const h = window.location.hash.replace("#", "");
    if ((TABS as string[]).includes(h)) return h as Tab;
    return "live";
  });
  const [fleet, setFleet] = useState<FleetSummary>({ total: 0, online: 0 });
  const [agentCount, setAgentCount] = useState(0);
  const [activeTasks, setActiveTasks] = useState(0);
  const [toast, setToast] = useState<{ msg: string; kind: "ok" | "err" } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [scratchOpen, setScratchOpen] = useState(false);
  const [muted, setMutedState] = useState<boolean>(() => {
    try { return localStorage.getItem(MUTE_KEY) === "1"; } catch { return false; }
  });
  const setMuted = (next: boolean) => {
    setMutedState(next);
    try { localStorage.setItem(MUTE_KEY, next ? "1" : "0"); } catch { /* noop */ }
  };

  // ⌘K / Ctrl+K opens the command palette
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((p) => !p);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Vim-style sequence shortcuts: G then [letter] switches tabs.
  // Mirrors what KeyboardHelp documents. Skips when focus is in an editable
  // field so we don't hijack the user's typing.
  useEffect(() => {
    let primed = 0; // performance.now() of the last "g" keypress, 0 = not primed
    const PRIME_WINDOW_MS = 1500;
    const TAB_FOR_LETTER: Record<string, Tab> = {
      l: "live", a: "agents", f: "fleet", o: "logs", m: "memory", t: "tasks",
    };
    const handler = (e: KeyboardEvent) => {
      // Skip if focus is inside an editable element
      const t = e.target as HTMLElement | null;
      if (t && (
        t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.isContentEditable
      )) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "g") {
        primed = performance.now();
        return;
      }
      if (primed && (performance.now() - primed) < PRIME_WINDOW_MS) {
        const tab = TAB_FOR_LETTER[k];
        if (tab) {
          e.preventDefault();
          setTab(tab);
        }
        primed = 0;
        return;
      }
      // `/` focuses the broadcast composer if mounted (Live tab has it).
      if (k === "/" && !e.shiftKey) {
        const composer = document.querySelector<HTMLTextAreaElement>(
          'textarea[data-broadcast-composer], textarea[placeholder*="message" i]'
        );
        if (composer) {
          e.preventDefault();
          composer.focus();
        }
        return;
      }
      // `m` toggles sound mute (mirrors the SettingsMenu toggle).
      if (k === "m" && !e.shiftKey) {
        e.preventDefault();
        setMuted(!mutedRef.current);
        return;
      }
      // `r` restarts the agent whose card is currently hovered.
      // We find the topmost element under the mouse via :hover; on touch
      // devices :hover may not match — that's fine, R is a desktop nicety.
      if (k === "r" && !e.shiftKey) {
        const hovered = document.querySelector<HTMLElement>(
          "[data-agent-card]:hover"
        );
        if (hovered) {
          const restartBtn = hovered.querySelector<HTMLButtonElement>(
            "button[data-restart-agent]"
          );
          if (restartBtn && !restartBtn.disabled) {
            e.preventDefault();
            restartBtn.click();
          }
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Stable ref to muted so the keyboard handler reads the latest value
  // without re-binding on every state change.
  const mutedRef = useRef(muted);
  useEffect(() => { mutedRef.current = muted; }, [muted]);

  useEffect(() => {
    window.location.hash = tab === "live" ? "" : tab;
  }, [tab]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const tick = async () => {
      const s = await fetchSummary();
      if (cancelled || !s) return;
      setFleet(s.fleet);
      setAgentCount(s.agents);
      setActiveTasks(s.tasks_in_flight);
    };

    const start = () => {
      if (timer != null) return;
      tick();
      timer = window.setInterval(tick, 10_000);
    };
    const stop = () => {
      if (timer != null) {
        window.clearInterval(timer);
        timer = null;
      }
    };

    // Pause polling while the tab is hidden — saves bandwidth on a
    // backgrounded dashboard, and tick() re-runs immediately on focus
    // so counts are fresh when the user comes back.
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    document.addEventListener("visibilitychange", onVisibility);
    if (!document.hidden) start();

    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const showToast = (msg: string, kind: "ok" | "err") => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 3500);
  };

  const content = (
    <main className="px-5 lg:px-8 xl:px-10 py-6 sm:py-10 pb-24 lg:pb-10 min-w-0">
      <div key={tab} className="animate-tab-wipe">
        {tab === "live" && <LiveView />}
        {tab === "agents" && <AgentDeck />}
        {tab === "fleet" && <FleetView onToast={showToast} />}
        {tab === "logs" && <LogsView />}
        {tab === "memory" && <MemoryView />}
        {tab === "tasks" && <Tasks />}
      </div>
      <footer className="mt-10 text-xs text-zinc-600">
        Tailscale-only · {window.location.host}
      </footer>
    </main>
  );

  return (
    <>
      {!booted && <BootSequence onComplete={() => setBooted(true)} />}
    <div className="min-h-screen dot-grid overflow-x-clip scanlines crt-vignette">
      {/* MOBILE / TABLET (< lg): identity + status only — tab nav lives in
          MobileBottomTabBar. The safe-area region (Dynamic Island / notch)
          gets a solid ink-950 backing and a faint accent gradient so the
          header theme reads as continuous all the way to the top of the
          physical screen rather than fading into the page texture. */}
      <div className="lg:hidden">
        <header
          className="border-b border-ink-800/80 backdrop-blur sticky top-0 z-10 bg-ink-950/70"
          style={{ paddingTop: "max(0px, calc(env(safe-area-inset-top) - 8px))" }}
        >
          <div className="px-4 sm:px-6 py-1.5 sm:py-2 flex flex-wrap items-center gap-3 sm:gap-5">
            <div className="flex items-center gap-3 mr-auto min-w-0">
              <div className="grid h-8 w-8 sm:h-9 sm:w-9 place-items-center rounded-xl bg-gradient-to-br from-accent to-accent-dim shadow-[0_0_24px_rgba(var(--accent-rgb)/0.4)] shrink-0">
                <svg viewBox="0 0 24 24" className="h-4 w-4 sm:h-5 sm:w-5 text-white" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 4h16v5H4zM4 15h16v5H4zM8 9v6M16 9v6" />
                </svg>
              </div>
              <div className="min-w-0">
                <div className="text-base sm:text-lg font-mono font-bold tracking-wider phosphor text-accent-glow">KVM_HUB</div>
                <div className="text-[10px] sm:text-xs text-zinc-500 truncate max-w-[60vw]">
                  {TAB_HINTS[tab]}
                </div>
              </div>
            </div>
            <SettingsMenu
              muted={muted}
              setMuted={setMuted}
              onOpenScratch={() => setScratchOpen(true)}
              variant="icon"
              placement="down"
              className="order-2"
            />
            <div className="order-3 w-full sm:w-auto sm:order-2 justify-center sm:justify-end flex">
              <StatusPills fleet={fleet} agents={agentCount} tasks={activeTasks} />
            </div>
          </div>
        </header>
        {content}
      </div>

      {/* DESKTOP (≥ lg): persistent left sidebar nav, slim top bar with status pills,
          right-side Telegram sidebar (TelegramSidebar component). Pad right by
          --tg-sidebar-w so content doesn't slide under it. */}
      <div className="hidden lg:flex" style={{ paddingRight: "var(--tg-sidebar-w, 380px)" }}>
        <aside className="w-60 xl:w-64 shrink-0 border-r border-ink-800/80 bg-ink-950/60 backdrop-blur h-screen sticky top-0 self-start py-6 flex flex-col overflow-y-auto">
          <div className="px-5 mb-4 flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-accent to-accent-dim shadow-[0_0_24px_rgba(52,211,153,0.4)]">
              <svg viewBox="0 0 24 24" className="h-5 w-5 text-white" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 4h16v5H4zM4 15h16v5H4zM8 9v6M16 9v6" />
              </svg>
            </div>
            <div className="min-w-0">
              <div className="text-base font-mono font-bold tracking-wider phosphor text-accent-glow">KVM_HUB</div>
              <div className="text-[10px] text-zinc-500 truncate font-mono">brad's fleet ops console</div>
            </div>
          </div>
          <div className="px-3 mb-3">
            <button
              onClick={() => setPaletteOpen(true)}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-ink-800/60 hover:bg-ink-800 border border-ink-700 hover:border-accent/40 text-[11px] text-zinc-400 transition"
            >
              <span>🔍</span>
              <span>Search…</span>
              <span className="ml-auto font-mono text-[10px] text-zinc-500">⌘K</span>
            </button>
          </div>

          <nav className="px-3 space-y-1">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition capitalize ${
                  tab === t
                    ? "bg-accent/15 text-accent-glow border border-accent/30 shadow-[0_0_16px_rgba(52,211,153,0.15)]"
                    : "text-zinc-400 hover:text-zinc-100 hover:bg-ink-800/40 border border-transparent"
                }`}
              >
                <span className={tab === t ? "text-accent-glow" : "text-zinc-500"}>
                  {TAB_ICONS[t]}
                </span>
                <span>{t}</span>
                {t === "tasks" && activeTasks > 0 && (
                  <span className="ml-auto badge bg-sky-500/15 text-sky-300 border-sky-500/30 text-[10px] py-0.5">
                    {activeTasks}
                  </span>
                )}
              </button>
            ))}
          </nav>

          <div className="mt-auto px-3 pt-6 space-y-3">
            <div className="px-2">
              <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-2">Status</div>
              <div className="flex flex-col gap-1.5">
                <StatusPills fleet={fleet} agents={agentCount} tasks={activeTasks} />
              </div>
            </div>
            <SettingsMenu
              muted={muted}
              setMuted={setMuted}
              onOpenScratch={() => setScratchOpen(true)}
            />
          </div>
        </aside>

        <div className="flex-1 min-w-0">
          <div className="border-b border-ink-800/40 bg-ink-950/40 backdrop-blur px-8 xl:px-10 py-3 flex items-center gap-4 sticky top-0 z-10">
            <div className="text-sm font-semibold tracking-tight capitalize">{tab}</div>
            <div className="text-[11px] text-zinc-500">{TAB_HINTS[tab]}</div>
          </div>
          {content}
        </div>
      </div>

      {toast && (
        <Toast
          kind={toast.kind === "ok" ? "success" : "error"}
          title={toast.msg}
          onClose={() => setToast(null)}
        />
      )}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        setTab={setTab}
        muted={muted}
        setMuted={setMuted}
        onOpenScratch={() => setScratchOpen(true)}
      />
      <TelegramSidebar />
      <Notifications muted={muted} />
      <ScratchDrawer open={scratchOpen} setOpen={setScratchOpen} />
      <KeyboardHelp />
      <MobileBottomTabBar tab={tab} setTab={setTab} />
      <TimeOfDayTheme />
    </div>
    {booted && <Screensaver />}
    </>
  );
}
