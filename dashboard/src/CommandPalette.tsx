/**
 * AUDIT NOTES:
 * FUNCTIONAL:
 *   - Tab navigation (setTab)
 *   - Agent chat routing + scroll-to-card
 *   - Quick prompt dispatch (POST /api/agents/:id/send)
 *   - Service restart (POST /api/services/:id/restart)
 *   - Fuzzy matching, arrow-key nav, enter-to-run, esc/click-close
 * STUBBED / FRAGILE:
 *   - /api/quickprompts & /api/services: likely 404s in dev; gracefully fallback to []
 *   - Scratchpad edit: relies on [data-scratchpad="1"] which may not exist; replaced by onOpenScratch prop
 *   - Hardcoded agent IDs for restarts: replaced with explicit POST endpoints
 */

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { fetchAgents, type Agent } from "./agents";

export type Action = {
  id: string;
  title: string;
  hint?: string;
  group: "Navigate" | "Agent" | "Prompt" | "Service" | "Action";
  icon?: string;
  /** A boost factor for ranking — higher = preferred when ties on score. */
  weight?: number;
  run: () => void | Promise<void>;
};

export type Tab = "live" | "agents" | "fleet" | "memory" | "tasks";

type QuickPrompt = {
  id: number;
  label: string;
  icon: string;
  prompt: string;
  target: string;
};

type Service = {
  id: string;
  name: string;
  host: string;
  active: boolean;
};

/** Simple fuzzy match: returns 0 if no match; else a score where lower
 *  is better. Bonus for prefix and consecutive runs. */
function fuzzyScore(query: string, text: string): number {
  if (!query) return 1; // every entry passes when no query
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) {
    return 100 + t.indexOf(q);
  }
  let i = 0;
  let lastIdx = -1;
  let gaps = 0;
  for (const ch of t) {
    if (ch === q[i]) {
      if (lastIdx >= 0) gaps += t.indexOf(ch, lastIdx + 1) - lastIdx - 1;
      lastIdx = t.indexOf(ch, lastIdx + 1);
      i += 1;
      if (i === q.length) break;
    }
  }
  if (i === q.length) return 1000 + gaps;
  return 0;
}

export default function CommandPalette({
  open,
  onClose,
  setTab,
  muted,
  setMuted,
  onOpenScratch,
}: {
  open: boolean;
  onClose: () => void;
  setTab: (t: Tab) => void;
  muted: boolean;
  setMuted: (next: boolean) => void;
  onOpenScratch: () => void;
}) {
  const [q, setQ] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [prompts, setPrompts] = useState<QuickPrompt[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Lazy-load action data only when palette opens
  useEffect(() => {
    if (!open) return;
    setQ("");
    setHighlight(0);
    inputRef.current?.focus();
    fetchAgents().then(setAgents).catch(() => {});
    fetch("/api/quickprompts")
      .then((r) => r.json())
      .then((d) => setPrompts(Array.isArray(d) ? d : []))
      .catch(() => {});
    fetch("/api/services")
      .then((r) => r.json())
      .then((d) => setServices(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, [open]);

  const actions: Action[] = useMemo(() => {
    const acts: Action[] = [];

    // Tabs
    const tabs: { id: Tab; title: string; icon: string; hint: string }[] = [
      { id: "live", title: "Live", icon: "🌐", hint: "workflow + activity" },
      { id: "agents", title: "Agents", icon: "💬", hint: "per-agent chats" },
      { id: "fleet", title: "Fleet", icon: "🛠", hint: "machines + services" },
      { id: "memory", title: "Memory", icon: "🧠", hint: "Honcho overview + search" },
      { id: "tasks", title: "Tasks", icon: "✅", hint: "kanban + schedules" },
    ];
    for (const t of tabs) {
      acts.push({
        id: `nav-${t.id}`,
        title: `Go to ${t.title}`,
        hint: t.hint,
        group: "Navigate",
        icon: t.icon,
        weight: 1,
        run: () => { setTab(t.id); onClose(); },
      });
    }

    // Agents
    for (const a of agents) {
      acts.push({
        id: `agent-${a.id}`,
        title: `Chat with ${a.name}`,
        hint: `${a.model}${a.push_only ? " · push-only" : ""}`,
        group: "Agent",
        icon: "💬",
        run: () => {
          setTab("agents");
          setTimeout(() => {
            const el = document.querySelector(`[data-agent-card="${a.id}"]`);
            el?.scrollIntoView({ behavior: "smooth", block: "center" });
          }, 50);
          onClose();
        },
      });
    }

    // Quick prompts
    for (const p of prompts) {
      acts.push({
        id: `qp-${p.id}`,
        title: `Fire: ${p.label}`,
        hint: `→ ${p.target}${p.prompt ? "  " + p.prompt.slice(0, 60) : ""}`,
        group: "Prompt",
        icon: p.icon,
        run: async () => {
          try {
            const targets =
              p.target === "broadcast"
                ? agents.filter((a) => a.can_send && !a.push_only).map((a) => a.id)
                : [p.target];
            await Promise.all(
              targets.map((id) =>
                fetch(`/api/agents/${id}/send`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ message: p.prompt, source: "palette" }),
                }),
              ),
            );
          } finally { onClose(); }
        },
      });
    }

    // Services
    for (const s of services) {
      acts.push({
        id: `svc-${s.id}`,
        title: `Restart ${s.name}`,
        hint: `${s.host}${s.active ? "" : " · DOWN"}`,
        group: "Service",
        icon: s.active ? "↻" : "⚠",
        run: async () => {
          try {
            await fetch(`/api/services/${s.id}/restart`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ confirm: true }),
            });
          } finally { onClose(); }
        },
      });
    }

    // NEW: System & Theme Actions
    acts.push({
      id: "restart-clue",
      title: "Restart Clue",
      hint: "POST /api/agents/clue/restart",
      group: "Action",
      icon: "🔁",
      run: async () => {
        try { await fetch("/api/agents/clue/restart", { method: "POST" }); }
        finally { onClose(); }
      },
    });

    acts.push({
      id: "restart-sarah",
      title: "Restart Sarah",
      hint: "POST /api/agents/sarah/restart",
      group: "Action",
      icon: "🔁",
      run: async () => {
        try { await fetch("/api/agents/sarah/restart", { method: "POST" }); }
        finally { onClose(); }
      },
    });

    acts.push({
      id: "toggle-mute",
      title: "Toggle Sound Mute",
      hint: muted ? "unmute audio" : "mute audio",
      group: "Action",
      icon: muted ? "🔊" : "🔇",
      run: () => { setMuted(!muted); onClose(); },
    });

    acts.push({
      id: "open-scratchpad",
      title: "Open Scratchpad",
      hint: "scratchpad.md",
      group: "Action",
      icon: "📝",
      run: () => { onOpenScratch(); onClose(); },
    });

    acts.push({
      id: "keyboard-help",
      title: "Show Keyboard Help",
      hint: "dispatches '?' keydown",
      group: "Action",
      icon: "⌨️",
      run: () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "?" }));
        onClose();
      },
    });

    const themes = [
      { id: "emerald", name: "Emerald", rgb: "52 211 153" },
      { id: "violet", name: "Violet", rgb: "167 139 250" },
      { id: "rose", name: "Rose", rgb: "251 113 133" },
    ];
    for (const theme of themes) {
      acts.push({
        id: `theme-${theme.id}`,
        title: `Switch Theme: ${theme.name}`,
        hint: `set --accent-rgb(${theme.rgb})`,
        group: "Action",
        icon: "🎨",
        run: () => {
          localStorage.setItem("kvm-hub.theme-accent", theme.id);
          document.documentElement.style.setProperty("--accent-rgb", theme.rgb);
          onClose();
        },
      });
    }

    return acts;
  }, [agents, prompts, services, setTab, onClose, muted, setMuted, onOpenScratch]);

  const ranked = useMemo(() => {
    if (!q.trim()) return actions;
    return actions
      .map((a) => ({ a, score: fuzzyScore(q.trim(), `${a.title} ${a.hint ?? ""}`) }))
      .filter((x) => x.score > 0)
      .sort((x, y) => x.score - y.score - (x.a.weight ?? 0) * 5)
      .map((x) => x.a)
      .slice(0, 50);
  }, [q, actions]);

  useEffect(() => {
    if (highlight >= ranked.length) setHighlight(0);
  }, [ranked, highlight]);

  useEffect(() => {
    const el = listRef.current?.querySelector(
      `[data-idx="${highlight}"]`,
    ) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const onKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") { onClose(); e.preventDefault(); }
      else if (e.key === "ArrowDown") { setHighlight((h) => Math.min(ranked.length - 1, h + 1)); e.preventDefault(); }
      else if (e.key === "ArrowUp") { setHighlight((h) => Math.max(0, h - 1)); e.preventDefault(); }
      else if (e.key === "Enter") { const a = ranked[highlight]; if (a) a.run(); e.preventDefault(); }
    },
    [ranked, highlight, onClose],
  );

  if (!open) return null;

  let lastGroup: string | null = null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm grid place-items-start pt-[10vh] p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-2xl overflow-hidden flex flex-col max-h-[70vh] bg-zinc-950 border border-zinc-800 rounded-lg shadow-2xl font-mono text-sm text-zinc-300">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800 bg-zinc-900/50">
          <span className="text-zinc-500">⌘</span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="search agents, services, prompts, tabs… (esc to close)"
            className="flex-1 bg-transparent border-none outline-none text-sm text-zinc-100 placeholder:text-zinc-600"
            style={{ fontSize: "16px" }}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck="false"
          />
          <span className="text-[10px] text-zinc-500 font-mono">
            {ranked.length} match{ranked.length === 1 ? "" : "es"}
          </span>
        </div>
        <div ref={listRef} className="flex-1 overflow-y-auto py-1 scrollbar-thin scrollbar-thumb-zinc-800 scrollbar-track-transparent">
          {ranked.length === 0 && (
            <div className="px-4 py-3 text-sm text-zinc-500 italic">No matches.</div>
          )}
          {ranked.map((a, i) => {
            const showGroup = a.group !== lastGroup;
            lastGroup = a.group;
            const active = i === highlight;
            return (
              <div key={a.id}>
                {showGroup && (
                  <div className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-widest text-zinc-500 border-b border-zinc-800/50 mb-1">
                    [ {a.group} ]
                  </div>
                )}
                <button
                  data-idx={i}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => a.run()}
                  className={`w-full flex items-center justify-between px-4 py-2 text-left transition-all duration-75 ${
                    active
                      ? "bg-accent/15 text-accent border-l-2 border-accent"
                      : "border-l-2 border-transparent text-zinc-300 hover:bg-zinc-800/40 hover:text-zinc-100"
                  }`}
                  style={active ? { boxShadow: `0 0 12px rgba(var(--accent-rgb), 0.35)` } : {}}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-base shrink-0 w-6 text-center opacity-80">{a.icon ?? "·"}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{a.title}</div>
                      {a.hint && <div className="text-[10px] text-zinc-500 truncate">{a.hint}</div>}
                    </div>
                  </div>
                  <span className={`shrink-0 text-[10px] font-mono ml-4 ${active ? "text-accent opacity-100" : "text-zinc-600"}`}>
                    {active ? "[ RUN ▶ ]" : "[   ]"}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
        <div className="border-t border-zinc-800 px-4 py-2 flex items-center gap-3 text-[10px] text-zinc-500 font-mono">
          <span>↑↓ navigate</span>
          <span>↵ execute</span>
          <span>esc close</span>
          <span className="ml-auto">⌘K to reopen</span>
        </div>
      </div>
    </div>
  );
}
