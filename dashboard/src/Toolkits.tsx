import { useEffect, useState } from "react";
import { fetchAgents, type Agent } from "./agents";

type Toolkit = {
  id: string;
  enabled: boolean;
  name: string;
  key: string;
};

const AGENT_ACCENT: Record<string, string> = {
  clue: "border-violet-500/40 bg-violet-500/5 text-violet-200",
  sarah: "border-rose-500/40 bg-rose-500/5 text-rose-200",
  claude_natalie: "border-cyan-500/40 bg-cyan-500/5 text-cyan-200",
};

const AGENT_DISPLAY: Record<string, string> = {
  clue: "CLUE",
  sarah: "SARAH",
  claude_natalie: "CLAUDE",
};

const AGENT_PHOSPHOR: Record<string, string> = {
  clue: "text-violet-300",
  sarah: "text-rose-300",
  claude_natalie: "text-cyan-300",
};

function AgentToolkit({ agent }: { agent: Agent }) {
  const [toolkits, setToolkits] = useState<Toolkit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/agents/${agent.id}/toolkits`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as Toolkit[];
        if (cancelled) return;
        setToolkits(data);
        setError(null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [agent.id]);

  const accentClass = AGENT_ACCENT[agent.id] ?? "border-zinc-500/30 bg-zinc-500/5 text-zinc-300";
  const enabled = (toolkits ?? []).filter((t) => t.enabled);
  const disabled = (toolkits ?? []).filter((t) => !t.enabled);
  const borderOnly = accentClass.split(" ").find((c) => c.startsWith("border-")) ?? "";
  const phosphorColor = AGENT_PHOSPHOR[agent.id] ?? "text-zinc-300";
  const displayName = AGENT_DISPLAY[agent.id] ?? agent.name.toUpperCase();

  return (
    <div className={`min-w-0 border ${borderOnly} bg-ink-900/60 p-4 relative overflow-hidden`}>
      <div className="relative z-10">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className={`text-sm phosphor tracking-wide ${phosphorColor}`}>
              [{displayName}]
            </div>
            <div className="text-[10px] text-zinc-500 truncate font-mono">
              {agent.short} · {enabled.length} enabled / {(toolkits ?? []).length} total
            </div>
          </div>
        </div>

        {error && <div className="text-[10px] text-rose-400 font-mono mb-2">err: {error}</div>}

        {toolkits === null ? (
          <div className="text-[11px] text-zinc-600 italic font-mono">loading…</div>
        ) : toolkits.length === 0 ? (
          <div className="text-[11px] text-zinc-600 italic font-mono">
            {agent.id === "claude_natalie"
              ? "Claude Code orchestrator (no Hermes toolsets)"
              : "no toolkits exposed"}
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {enabled.map((t) => (
              <div
                key={t.id}
                className="text-[11px] rounded px-2 py-1 border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 phosphor-soft bracket-value font-mono"
                title={`${t.key} · enabled`}
              >
                {t.name}
              </div>
            ))}
            {disabled.map((t) => (
              <div
                key={t.id}
                className="text-[11px] rounded px-2 py-1 border border-zinc-700/50 bg-zinc-800/30 text-zinc-500 bracket-value font-mono opacity-60"
                title={`${t.key} · disabled`}
              >
                {t.name}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Toolkits() {
  const [agents, setAgents] = useState<Agent[]>([]);
  useEffect(() => {
    fetchAgents().then(setAgents).catch(() => {});
  }, []);
  if (agents.length === 0) {
    return (
      <div className="p-4 text-xs text-zinc-500 italic font-mono relative overflow-hidden">
        <span className="relative">loading toolkits…</span>
      </div>
    );
  }
  return (
    <div className="p-4 sm:p-5 font-mono text-sm bg-ink-900/60 border border-ink-700 relative overflow-hidden">
      <div className="relative z-10">
        <div className="flex items-center gap-3 mb-4">
          <span className="text-base phosphor text-emerald-300 tracking-wide">[ TOOLKITS ]</span>
          <span className="text-xs text-zinc-500">{agents.length} agents</span>
        </div>
        <div className="grid gap-4 sm:gap-5 lg:grid-cols-3">
          {agents.map((a) => (
            <AgentToolkit key={a.id} agent={a} />
          ))}
        </div>
      </div>
    </div>
  );
}
