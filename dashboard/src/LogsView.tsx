import { useEffect, useRef, useState, type ReactNode } from "react";
import { fetchAgents, logWsUrl, type Agent } from "./agents";
import AmbientBackground from "./AmbientBackground";
import { onWorkflow } from "./eventBus";

/**
 * Full-screen log streaming for any agent. Pick from a left rail of agents,
 * see the live tail (with backfill) on the right. Shared filter input.
 *
 * Reuses the existing /ws/agents/{id}/logs WebSocket.
 */

function lineStyle(line: string): string {
  if (/error|exception|traceback/i.test(line)) return "text-rose-300";
  if (/warning|warn /i.test(line)) return "text-amber-300";
  if (/inbound message:/i.test(line)) return "text-sky-300";
  if (/response ready:/i.test(line)) return "text-emerald-300";
  if (/Honcho dialectic/i.test(line)) return "text-zinc-600";
  return "text-zinc-300";
}

function LogStream({
  agentId,
  filter,
  showOnlyMatched,
}: {
  agentId: string;
  filter: string;
  showOnlyMatched: boolean;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;
    let backoff = 500;
    setLines([]);
    const connect = () => {
      if (cancelled) return;
      const ws = new WebSocket(logWsUrl(agentId));
      wsRef.current = ws;
      ws.onopen = () => {
        backoff = 500;
        setConnected(true);
      };
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type === "backfill") {
            setLines((data.lines as string[]).slice(-500));
          } else if (data.type === "line") {
            setLines((arr) => {
              const next = [...arr, data.line as string];
              return next.length > 1000 ? next.slice(-1000) : next;
            });
          }
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        setConnected(false);
        if (cancelled) return;
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 8000);
      };
    };
    connect();
    return () => {
      cancelled = true;
      wsRef.current?.close();
    };
  }, [agentId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && autoScrollRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const f = filter.trim().toLowerCase();
  const visible = lines
    .map((l, i) => ({ l, i }))
    .filter((x) => (showOnlyMatched && f ? x.l.toLowerCase().includes(f) : true));

  const matchCount = f ? lines.filter((l) => l.toLowerCase().includes(f)).length : 0;

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0">
      {/* Terminal session status bar */}
      <div className="flex items-center gap-3 text-[11px] font-mono px-4 py-2 border-b border-ink-800 bg-black/60">
        <span className={connected ? "text-emerald-400 phosphor" : "text-amber-400"}>
          {connected ? "[STREAMING]" : "[RECONNECTING…]"}
        </span>
        <span className="text-zinc-500">
          tail -f /var/log/agents/{agentId}.log
        </span>
        <span className="ml-auto flex items-center gap-3 text-zinc-500">
          <span>
            <span className="opacity-50">[</span>
            <span className="tabular-nums text-zinc-300">
              {visible.length}/{lines.length}
            </span>
            <span className="opacity-50">]</span> lines
          </span>
          {f && (
            <span className="text-amber-300">
              <span className="opacity-50">[</span>
              <span className="tabular-nums">{matchCount}</span>
              <span className="opacity-50">]</span> matches
            </span>
          )}
        </span>
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="relative flex-1 overflow-y-auto bg-black/70 px-4 py-3 font-mono text-[12px] leading-relaxed min-w-0 phosphor-soft"
      >
        {visible.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <AmbientBackground opacity={0.4} />
            <div className="relative text-emerald-400 phosphor italic z-[1] text-sm">
              {lines.length === 0
                ? connected
                  ? "─── waiting for first line ───"
                  : "─── connecting ───"
                : f
                ? "─── no matches ───"
                : "─── empty ───"}
              <span className="inline-block ml-2 animate-pulse text-emerald-500">▊</span>
            </div>
          </div>
        ) : (
          <>
            {visible.map(({ l, i }) => (
              <div key={i} className={`${lineStyle(l)} whitespace-pre-wrap break-all`}>
                {f && !showOnlyMatched ? <Highlight line={l} q={f} /> : l}
              </div>
            ))}
            {connected && (
              <div className="text-emerald-500">
                <span className="inline-block animate-pulse">▊</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Highlight({ line, q }: { line: string; q: string }) {
  const lower = line.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < line.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      out.push(line.slice(i));
      break;
    }
    if (idx > i) out.push(line.slice(i, idx));
    out.push(
      <mark key={key++} className="bg-amber-400/30 text-amber-100 rounded px-0.5">
        {line.slice(idx, idx + q.length)}
      </mark>,
    );
    i = idx + q.length;
  }
  return <>{out}</>;
}

export default function LogsView() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [showOnlyMatched, setShowOnlyMatched] = useState(false);
  // FOLLOW toggle: when on, auto-pin to the agent currently producing
  // workflow events (responding / agent_to_agent / tool calls).
  const [follow, setFollow] = useState(() => {
    try {
      return localStorage.getItem("kvm-hub.logs-follow") === "true";
    } catch {
      return false;
    }
  });
  const lastSwitchRef = useRef(0);

  useEffect(() => {
    fetchAgents().then((arr) => {
      setAgents(arr);
      const withLog = arr.filter((a) => a.has_log);
      if (withLog.length > 0 && !activeId) setActiveId(withLog[0].id);
    });
  }, [activeId]);

  // Subscribe to eventBus when FOLLOW is on. Switch activeId to whichever
  // agent is currently producing visible workflow events. Debounced to
  // 500ms so a rapid burst doesn't whipsaw the log pane.
  useEffect(() => {
    if (!follow) return;
    const off = onWorkflow((e) => {
      const now = performance.now();
      if (now - lastSwitchRef.current < 500) return;
      let agentId: string | undefined;
      if (e.type === "agent_to_user" || e.type === "agent_tool") agentId = e.agentId;
      else if (e.type === "agent_to_agent") agentId = e.fromId;
      if (!agentId) return;
      // Only switch to agents whose log we can actually tail.
      const a = agents.find((x) => x.id === agentId);
      if (!a || !a.has_log) return;
      setActiveId((cur) => (cur === agentId ? cur : agentId!));
      lastSwitchRef.current = now;
    });
    return off;
  }, [follow, agents]);

  // Persist toggle
  useEffect(() => {
    try { localStorage.setItem("kvm-hub.logs-follow", String(follow)); } catch { /* noop */ }
  }, [follow]);

  const withLog = agents.filter((a) => a.has_log);

  return (
    <div
      className="card overflow-hidden flex flex-col font-mono"
      style={{ minHeight: "75vh", height: "75vh" }}
    >
      {/* Top toolbar — styled as a terminal title bar */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-ink-800 bg-black/40 shrink-0">
        <div className="flex items-center gap-1.5 mr-3">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-500/80"></span>
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500/80"></span>
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/80"></span>
        </div>
        <div className="text-[12px] font-bold tracking-wider text-emerald-400 phosphor">
          LOGS
        </div>
        <div className="flex items-center gap-1.5 ml-2">
          {withLog.map((a) => {
            const active = activeId === a.id;
            return (
              <button
                key={a.id}
                onClick={() => setActiveId(a.id)}
                className={`text-[11px] px-2 py-1 transition ${
                  active
                    ? "text-emerald-400 phosphor"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                <span className="opacity-50">{active ? "[" : " "}</span>
                {a.name}
                <span className="opacity-50">{active ? "]" : " "}</span>
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-emerald-400/70 text-[11px]">$</span>
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="grep…"
            className="text-[12px] font-mono rounded-none border-0 border-b border-ink-700 bg-transparent px-1 py-1 w-56
                       focus:outline-none focus:border-emerald-500 placeholder:text-zinc-600 text-zinc-200"
          />
          <label className="flex items-center gap-1 text-[11px] text-zinc-500 cursor-pointer ml-2 select-none">
            <input
              type="checkbox"
              checked={showOnlyMatched}
              onChange={(e) => setShowOnlyMatched(e.target.checked)}
              className="accent-emerald-400"
            />
            <span>--only-matches</span>
          </label>
          <button
            onClick={() => setFollow((f) => !f)}
            className={`text-[10px] tracking-widest font-mono px-2 py-0.5 rounded border transition ${
              follow
                ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300 phosphor"
                : "border-ink-700/60 bg-ink-900/40 text-zinc-500 hover:text-zinc-300"
            }`}
            title="auto-pin log pane to whichever agent is currently producing events"
          >
            {follow ? "[ FOLLOW ]" : "[ MANUAL ]"}
          </button>
        </div>
      </div>

      {activeId ? (
        <LogStream
          key={activeId}
          agentId={activeId}
          filter={filter}
          showOnlyMatched={showOnlyMatched}
        />
      ) : (
        <div className="p-6 text-emerald-700 italic text-sm bg-black/70 flex-1">
          {agents.length === 0 ? "─── loading agents ───" : "─── no log-streaming agents available ───"}
        </div>
      )}
    </div>
  );
}
