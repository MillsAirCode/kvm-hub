// AgentStatusRail.tsx
import { useEffect, useState } from "react";
import { fetchAgents, fetchAgentStatus, type Agent, type AgentState } from "./agents";
import { Skeleton } from "./Skeleton";

const STATE_DOT: Record<AgentState, string> = {
  idle: "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]",
  thinking: "bg-amber-400 animate-pulse shadow-[0_0_8px_rgba(251,191,36,0.7)]",
  responding: "bg-sky-400 animate-pulse shadow-[0_0_8px_rgba(56,189,248,0.7)]",
  unknown: "bg-zinc-600",
};

const STATE_LABEL: Record<AgentState, string> = {
  idle: "ONLINE",
  thinking: "THINKING",
  responding: "RESPONDING",
  unknown: "OFFLINE",
};

type Row = {
  agent: Agent;
  state: AgentState;
  lastText: string | null;
  lastAt: number | null;
};

function relTime(s: number | null): string {
  if (!s) return "";
  const sec = Math.round((Date.now() / 1000) - s);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

function elide(s: string, n: number): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export default function AgentStatusRail() {
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const tick = async () => {
      try {
        const agents = await fetchAgents();
        const statuses = await Promise.all(
          agents.map((a) =>
            fetchAgentStatus(a.id).catch(() => ({
              id: a.id,
              state: "unknown" as AgentState,
              last_event_at: null,
              last_event_text: null,
            })),
          ),
        );
        if (cancelled) return;
        setRows(
          agents.map((a, i) => ({
            agent: a,
            state: statuses[i].state,
            lastText: statuses[i].last_event_text,
            lastAt: statuses[i].last_event_at,
          })),
        );
      } catch {
        /* ignore */
      }
    };
    tick();
    timer = window.setInterval(tick, 5_000);
    return () => {
      cancelled = true;
      if (timer != null) window.clearInterval(timer);
    };
  }, []);

  if (rows.length === 0) {
    return (
      <div className="card hover-phosphor-card p-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-mono font-bold tracking-tight text-zinc-100">
              <span className="text-zinc-500">[</span>
              <span className="phosphor text-accent-glow">AGENTS</span>
              <span className="text-zinc-500">]</span>
            </span>
          </div>
          <div className="text-[10px] font-mono text-zinc-500 bracket-value">live state</div>
        </div>
        <div className="space-y-2.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Skeleton className="h-2 w-2" rounded="rounded-full" />
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-2.5 w-16 ml-auto" />
              </div>
              <Skeleton className="h-2 w-full" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="card hover-phosphor-card p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-mono font-bold tracking-tight text-zinc-100">
            <span className="text-zinc-500">[</span>
            <span className="phosphor text-accent-glow">AGENTS</span>
            <span className="text-zinc-500">]</span>
          </span>
        </div>
        <div className="text-[10px] font-mono text-zinc-500 bracket-value">live state</div>
      </div>
      <div className="space-y-3">
        {rows.map(({ agent, state, lastText, lastAt }) => (
          <div key={agent.id} className="min-w-0 group">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`h-2 w-2 rounded-full shrink-0 ${STATE_DOT[state]}`} />
              <span className="text-sm font-medium text-zinc-200 font-mono bracket-value">
                {agent.name}
              </span>
              <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${
                state === "idle" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" :
                state === "thinking" ? "border-amber-500/40 bg-amber-500/10 text-amber-300 animate-pulse" :
                state === "responding" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 animate-pulse" :
                "border-zinc-600/40 bg-zinc-600/10 text-zinc-400"
              }`}>
                <span className="text-zinc-500">[</span>
                {STATE_LABEL[state]}
                <span className="text-zinc-500">]</span>
              </span>
              <span className="ml-auto shrink-0 text-[10px] font-mono text-zinc-600 tabular-nums">
                {lastAt ? `// ${relTime(lastAt)}` : ""}
              </span>
            </div>
            <div className="mt-1 text-[11px] text-zinc-500 font-mono truncate group-hover-phosphor-text">{agent.model}</div>
            {lastText && (
              <div className="mt-1 text-[11px] text-zinc-400 font-mono leading-snug [overflow-wrap:anywhere]">
                {elide(lastText, 110)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
