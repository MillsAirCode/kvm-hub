import { useEffect, useRef, useState } from "react";
import {
  fetchAgents,
  fetchAgentStatus,
  fetchAgentMetrics,
  logWsUrl,
  sendMessageStream,
  toolEmoji,
  type Agent,
  type AgentMetricsResponse,
  type AgentState,
} from "./agents";
// WorkflowGraph / PulseChart / Broadcast / ActivityFeed → LiveView
// HostStrip / Toolkits → FleetView
// (kept here for the FleetStrip helper which we re-export)
import ModelInspector from "./ModelInspector";
import { AgentCardSkeleton } from "./Skeleton";
import AgentBadge from "./AgentBadge";
import { CopyableText } from "./CopyableText";
import LoadingHero from "./LoadingHero";
import PerfMeter from "./PerfMeter";

function lineStyle(line: string): string {
  if (/error|exception|traceback/i.test(line)) return "text-rose-300";
  if (/warning|warn /i.test(line)) return "text-amber-300";
  if (/inbound message:/i.test(line)) return "text-sky-300";
  if (/response ready:/i.test(line)) return "text-emerald-300";
  return "text-zinc-400";
}

// ── Chat parsing ─────────────────────────────────────────────────────────

type ChatTurn = {
  role: "user" | "assistant" | "tool" | "system" | "meta";
  text: string;
  tool_name?: string;
  tool_args?: string;
  ts?: number;
  local?: boolean; // optimistic add from dashboard send
  streaming?: boolean; // currently being filled token-by-token
};

function parseHermesLine(obj: any): ChatTurn | null {
  const role = obj.role;
  if (role === "session_meta" || role === "session_start" || role === "system") {
    return { role: "meta", text: obj.content ? String(obj.content).slice(0, 200) : `(${role})` };
  }
  if (role === "user") {
    const text =
      typeof obj.content === "string"
        ? obj.content
        : Array.isArray(obj.content)
        ? obj.content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("")
        : String(obj.content ?? "");
    return { role: "user", text };
  }
  if (role === "assistant") {
    const tool_calls = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
    if (tool_calls.length > 0) {
      const tc = tool_calls[0];
      const name = tc?.function?.name ?? "?";
      const args = tc?.function?.arguments ?? "";
      const more = tool_calls.length > 1 ? ` (+${tool_calls.length - 1} more)` : "";
      return {
        role: "assistant",
        text: typeof obj.content === "string" ? obj.content : "",
        tool_name: name + more,
        tool_args: typeof args === "string" ? args : JSON.stringify(args),
      };
    }
    const text = typeof obj.content === "string" ? obj.content : String(obj.content ?? "");
    return { role: "assistant", text };
  }
  if (role === "tool") {
    const text = typeof obj.content === "string" ? obj.content : String(obj.content ?? "");
    return { role: "tool", text };
  }
  return null;
}

function parseClaudeCodeLine(obj: any): ChatTurn | null {
  // Claude Code transcript: top-level {type, message:{role, content}}
  // or various non-message events.
  const type = obj.type;
  if (type === "queue-operation" || type === "summary" || type === "compact_summary") {
    return null; // skip noise
  }
  const message = obj.message ?? {};
  const role = message.role ?? type;
  const content = message.content;

  // Helper: extract text and tool info from a content array
  const collect = (arr: any[]) => {
    let text = "";
    let tool_name: string | undefined;
    let tool_args: string | undefined;
    let tool_result: string | undefined;
    for (const c of arr) {
      if (!c || typeof c !== "object") continue;
      if (c.type === "text" && typeof c.text === "string") {
        text += (text ? "\n" : "") + c.text;
      } else if (c.type === "tool_use") {
        tool_name = c.name ?? "?";
        try {
          tool_args = typeof c.input === "string" ? c.input : JSON.stringify(c.input);
        } catch {
          tool_args = "";
        }
      } else if (c.type === "tool_result") {
        const tc = c.content;
        if (typeof tc === "string") tool_result = tc;
        else if (Array.isArray(tc))
          tool_result = tc.map((b: any) => (typeof b === "string" ? b : b?.text ?? "")).join("");
      }
    }
    return { text, tool_name, tool_args, tool_result };
  };

  if (role === "user") {
    if (typeof content === "string") return { role: "user", text: content };
    if (Array.isArray(content)) {
      const { text, tool_result } = collect(content);
      // tool_result wrapped inside a "user" message → render as tool turn
      if (tool_result !== undefined && !text) {
        return { role: "tool", text: tool_result };
      }
      if (text) return { role: "user", text };
    }
    return null;
  }
  if (role === "assistant") {
    if (typeof content === "string") return { role: "assistant", text: content };
    if (Array.isArray(content)) {
      const { text, tool_name, tool_args } = collect(content);
      if (tool_name) {
        return { role: "assistant", text, tool_name, tool_args };
      }
      if (text) return { role: "assistant", text };
    }
    return null;
  }
  return null;
}

function parseJsonlLine(raw: string, format: "hermes" | "claude_code" = "hermes"): ChatTurn | null {
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  return format === "claude_code" ? parseClaudeCodeLine(obj) : parseHermesLine(obj);
}

// Legacy chat panel kept for reference / future fallback. Not currently
// rendered — TelegramEmbed replaces it.
// @ts-ignore
function ChatPanel(props: {
  agentId: string;
  format: "hermes" | "claude_code";
  turns: ChatTurn[];
  setTurns: React.Dispatch<React.SetStateAction<ChatTurn[]>>;
}) {
  const { agentId, format, turns, setTurns } = props;
  const [connected, setConnected] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);

  const toggle = (i: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  useEffect(() => {
    let cancelled = false;
    let backoff = 500;
    let activeWs: WebSocket | null = null;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${window.location.host}/ws/agents/${agentId}/chat`;

    const connect = () => {
      if (cancelled) return;
      const ws = new WebSocket(url);
      activeWs = ws;
      ws.onopen = () => {
        backoff = 500;
        setConnected(true);
      };
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type === "backfill") {
            const parsed = (data.lines as string[])
              .map((l) => parseJsonlLine(l, format))
              .filter((t): t is ChatTurn => !!t);
            // Replace any local-only turns by what's now in the JSONL.
            setTurns((arr) => {
              const local = arr.filter((t) => t.local);
              return [...parsed.slice(-300), ...local];
            });
          } else if (data.type === "line") {
            const t = parseJsonlLine(data.line as string, format);
            if (t)
              setTurns((arr) => {
                const next = [...arr, t];
                return next.length > 600 ? next.slice(-600) : next;
              });
          }
        } catch {
          /* ignore */
        }
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
      try { activeWs?.close(); } catch { /* noop */ }
    };
  }, [agentId, format, setTurns]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && autoScrollRef.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="flex-1 rounded-lg border border-ink-700 bg-black/30 px-3 py-2 overflow-y-auto overflow-x-hidden min-w-0"
      style={{ minHeight: 220, maxHeight: 320 }}
    >
      {turns.length === 0 ? (
        <div className="text-zinc-600 italic text-xs">
          {connected ? "no messages yet — talk to the agent" : "connecting…"}
        </div>
      ) : (
        <div className="space-y-2">
          {turns.map((t, i) => {
            if (t.role === "user") {
              return (
                <div key={i} className="text-sm min-w-0">
                  <div className="text-[10px] uppercase tracking-wide text-sky-400 mb-0.5">user</div>
                  <div className="bg-sky-500/10 border border-sky-500/30 rounded-lg px-3 py-1.5 text-sky-100 whitespace-pre-wrap break-words overflow-wrap-anywhere [overflow-wrap:anywhere]">
                    {t.text}
                  </div>
                </div>
              );
            }
            if (t.role === "assistant") {
              const ex = expanded.has(i);
              const argsTruncated = t.tool_args && t.tool_args.length > 80;
              return (
                <div key={i} className="text-sm min-w-0">
                  <div className="text-[10px] uppercase tracking-wide text-emerald-400 mb-0.5 flex items-center gap-1.5">
                    assistant
                    {t.streaming && (
                      <span className="flex items-center gap-1">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        <span className="text-emerald-300/70 normal-case tracking-normal text-[9px]">
                          streaming
                        </span>
                      </span>
                    )}
                  </div>
                  <div
                    className={`bg-emerald-500/5 border ${
                      t.streaming ? "border-emerald-400/60" : "border-emerald-500/20"
                    } rounded-lg px-3 py-1.5 text-zinc-100 whitespace-pre-wrap break-words [overflow-wrap:anywhere]`}
                  >
                    {t.text || (
                      t.streaming ? (
                        <span className="italic text-zinc-500">thinking…</span>
                      ) : (
                        <span className="italic text-zinc-500">(no text)</span>
                      )
                    )}
                    {t.streaming && t.text && (
                      <span className="inline-block w-[2px] h-[1em] bg-emerald-400 ml-0.5 animate-pulse align-text-bottom" />
                    )}
                    {t.tool_name && (
                      <div
                        className="mt-1.5 text-xs font-mono text-amber-300 [overflow-wrap:anywhere] cursor-pointer hover:text-amber-200"
                        onClick={() => argsTruncated && toggle(i)}
                        title={argsTruncated ? "click to toggle full args" : undefined}
                      >
                        {toolEmoji(t.tool_name)} {t.tool_name}
                        {t.tool_args && (
                          <span className="text-zinc-500 ml-1">
                            {ex ? t.tool_args : t.tool_args.slice(0, 80)}
                            {argsTruncated && !ex && <span className="text-zinc-600"> ⋯ click</span>}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            }
            if (t.role === "tool") {
              const ex = expanded.has(i);
              const truncated = t.text.length > 200;
              return (
                <div
                  key={i}
                  className="text-xs font-mono text-zinc-500 pl-4 border-l-2 border-ink-700 [overflow-wrap:anywhere] cursor-pointer hover:text-zinc-400"
                  onClick={() => truncated && toggle(i)}
                  title={truncated ? "click to expand" : undefined}
                >
                  ↳ tool: {ex ? t.text : t.text.slice(0, 200)}
                  {truncated && !ex && <span className="text-zinc-600"> ⋯ click to expand</span>}
                </div>
              );
            }
            return (
              <div key={i} className="text-[10px] uppercase tracking-wide text-zinc-600">
                — {t.text} —
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LogPanel({ agentId }: { agentId: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    let backoff = 500;
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
          if (data.type === "backfill") setLines((data.lines as string[]).slice(-300));
          else if (data.type === "line")
            setLines((arr) => {
              const next = [...arr, data.line as string];
              return next.length > 600 ? next.slice(-600) : next;
            });
        } catch {
          /* ignore */
        }
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
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="flex-1 rounded-lg border border-ink-700 bg-black/30 px-3 py-2 font-mono text-[11px] leading-relaxed overflow-y-auto overflow-x-hidden min-w-0"
      style={{ minHeight: 220, maxHeight: 320 }}
    >
      {lines.length === 0 ? (
        <div className="text-zinc-600 italic">{connected ? "waiting for log activity…" : "connecting…"}</div>
      ) : (
        lines.map((line, i) => (
          <div key={i} className={`whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${lineStyle(line)}`}>
            {line}
          </div>
        ))
      )}
    </div>
  );
}

function AgentCard({
  agent,
  onMetrics,
}: {
  agent: Agent;
  onMetrics?: (m: AgentMetricsResponse) => void;
}) {
  const [state, setState] = useState<AgentState>("unknown");
  const [metrics, setMetrics] = useState<AgentMetricsResponse | null>(null);
  // turns kept around for the Composer's optimistic rendering even though
  // the Telegram iframe is now the primary chat UI.
  const [, setTurns] = useState<ChatTurn[]>([]);
  const [logOpen, setLogOpen] = useState(true);
  // Restart flow state — null when idle, "restarting" while SSH+systemctl
  // is in flight, "ok" / "err" briefly to flash result before clearing.
  const [restartState, setRestartState] = useState<null | "restarting" | "ok" | "err">(null);
  const [restartMsg, setRestartMsg] = useState<string>("");

  const onRestart = async () => {
    if (restartState === "restarting") return;
    setRestartState("restarting");
    setRestartMsg("");
    try {
      const r = await fetch(`/api/agents/${agent.id}/restart`, { method: "POST" });
      const data = await r.json();
      if (r.ok && data.ok) {
        setRestartState("ok");
        setRestartMsg("services back up");
      } else {
        setRestartState("err");
        setRestartMsg(data.error || data.stderr || `rc=${data.rc ?? "?"}`);
      }
    } catch (e) {
      setRestartState("err");
      setRestartMsg((e as Error).message);
    }
    // Auto-clear the result flash after 4s
    setTimeout(() => setRestartState(null), 4000);
  };

  // Status poll (every 8s)
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const s = await fetchAgentStatus(agent.id);
        if (!stopped) setState(s.state);
      } catch {
        /* leave previous */
      }
    };
    tick();
    const id = setInterval(tick, 8000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [agent.id]);

  // Metrics poll (every 30s) — log scraping is a bit pricey
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const m = await fetchAgentMetrics(agent.id);
        if (!stopped) {
          setMetrics(m);
          onMetrics?.(m);
        }
      } catch {
        /* leave previous */
      }
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [agent.id, onMetrics]);

  return (
    <div
      data-agent-card={agent.id}
      data-state={
        state === "thinking" ? "thinking"
        : state === "responding" ? "responding"
        : state === "idle" || state === "unknown" ? "idle"
        : "offline"
      }
      className="card group p-4 flex flex-col gap-3 min-w-0 overflow-hidden hover-phosphor-card relative"
    >
      <div className="-mx-4 -mt-4 mb-1">
        <AgentBadge
          agentId={agent.id}
          name={agent.name}
          role={agent.short || agent.role || agent.model}
          state={
            state === "thinking" ? "thinking"
            : state === "responding" ? "responding"
            : state === "idle" || state === "unknown" ? "online"
            : "offline"
          }
        />
      </div>
      <div className="flex items-center gap-2 text-xs text-zinc-500 min-w-0">
        <CopyableText
          value={agent.model}
          className="rounded bg-ink-800 shrink-0 !min-h-0"
          title={`copy model alias: ${agent.model}`}
        />
        <span className="truncate">{agent.role}</span>
      </div>
      <PerfMeter agentId={agent.id} />

      {/* LOG section is collapsible — keeps the card compact by default. */}
      <div className="flex items-center gap-2 text-[10px]">
        <button
          onClick={() => setLogOpen((o) => !o)}
          className="flex items-center gap-1 px-2 py-0.5 rounded transition text-zinc-500 hover:text-zinc-200"
          aria-expanded={logOpen}
        >
          <svg
            viewBox="0 0 24 24"
            className={`h-3 w-3 transition-transform ${logOpen ? "rotate-90" : ""}`}
            fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
          LOG
        </button>
        {/* Restart action — SSHes to the host and bounces hermes-gateway +
            llama-server. Only shown for non-localhost agents (we won't kill
            ourselves). */}
        {agent.host && agent.host !== "localhost" && (
          <button
            data-restart-agent
            onClick={onRestart}
            disabled={restartState === "restarting"}
            className={`ml-auto px-2 py-0.5 rounded font-mono tracking-wider transition border ${
              restartState === "restarting"
                ? "border-amber-500/40 bg-amber-500/15 text-amber-300"
                : restartState === "ok"
                ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300 phosphor"
                : restartState === "err"
                ? "border-rose-500/40 bg-rose-500/15 text-rose-300"
                : "border-ink-700 bg-ink-900/40 text-zinc-500 hover:text-zinc-200 hover:border-rose-500/40"
            }`}
            title={
              restartState === "err" ? `restart failed: ${restartMsg}` :
              restartState === "ok" ? `restart succeeded: ${restartMsg}` :
              "restart hermes-gateway + llama-server on this agent's host"
            }
          >
            {restartState === "restarting" ? "[ RESTARTING… ]"
              : restartState === "ok" ? "[ ✓ RESTARTED ]"
              : restartState === "err" ? "[ ✕ FAILED ]"
              : "[ RESTART ]"}
          </button>
        )}
      </div>

      {/* Full-card LoadingHero overlay while a restart is in flight. */}
      {restartState === "restarting" && (
        <div className="absolute inset-0 z-30 bg-ink-950/85 backdrop-blur-sm flex items-center justify-center rounded-2xl">
          <LoadingHero
            brand="RESTART"
            tagline={`// restarting ${agent.name.toLowerCase()}`}
            subtext={`hermes-gateway + llama-server on ${agent.short || agent.host}`}
            stats="ssh → systemctl → wait for is-active"
            minHeight="min-h-[12rem]"
          />
        </div>
      )}

      {/* Chat pane retired — desktop has a global Telegram sidebar.
          Mobile users open Telegram natively. AgentCard now shows logs. */}
      {logOpen && <LogPanel agentId={agent.id} />}

      {agent.can_send ? (
        <>
          {agent.push_only && (
            <div className="text-[10px] text-fuchsia-300/80 italic px-1 -mb-1">
              push-only — sends post to your Telegram chat (Claude can't reply via web)
            </div>
          )}
          <Composer agentId={agent.id} setTurns={setTurns} />
        </>
      ) : (
        <div className="text-[10px] text-zinc-600 italic px-1">
          send-from-dashboard not available — message via Telegram instead
        </div>
      )}

      {metrics && <Vitals metrics={metrics} model={agent.model} />}

      {/* Model inspector — shows llama-server runtime config */}
      <ModelInspector agentId={agent.id} />
    </div>
  );
}

function Vitals({ metrics, model }: { metrics: AgentMetricsResponse; model?: string }) {
  const buckets = metrics.activity_buckets;
  const max = Math.max(1, ...buckets);
  const cellW = `${100 / 60}%`;
  const fmtLatency = (s: number | null) => {
    if (s == null) return "—";
    if (s < 1) return `${(s * 1000).toFixed(0)}ms`;
    if (s < 60) return `${s.toFixed(1)}s`;
    return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
  };
  return (
    <div className="rounded-lg border border-ink-700/70 bg-ink-900/40 p-2 min-w-0">
      <div className="flex items-center gap-3 text-[10px] uppercase tracking-wide text-zinc-500 mb-1.5">
        <span>
          msgs <span className="text-zinc-200 font-mono ml-0.5">{metrics.msgs_today}</span>
        </span>
        <span>
          avg <span className="text-zinc-200 font-mono ml-0.5">{fmtLatency(metrics.avg_latency_s)}</span>
        </span>
        <span>
          tools <span className="text-zinc-200 font-mono ml-0.5">{metrics.tools_today}</span>
        </span>
        {model && (
          <span
            className="ml-auto max-w-[40%] truncate rounded border border-ink-700 bg-ink-900/70 px-1.5 py-0.5 font-mono text-[9px] text-accent-glow/80 normal-case"
            title={`model: ${model}`}
          >
            {model}
          </span>
        )}
        <span className={`${model ? "" : "ml-auto "}opacity-60 text-[9px]`}>last 60 min</span>
      </div>
      <div className="flex h-5 gap-px">
        {buckets.map((c, i) => {
          const intensity = c === 0 ? 0 : 0.2 + 0.8 * (c / max);
          return (
            <div
              key={i}
              className="rounded-[1px]"
              style={{
                width: cellW,
                background:
                  c === 0 ? "rgba(255,255,255,0.04)" : `rgba(124, 92, 255, ${intensity})`,
                boxShadow: c > 0 ? `0 0 4px rgba(52,211,153,${intensity * 0.6})` : "none",
              }}
              title={`min -${60 - i}: ${c} events`}
            />
          );
        })}
      </div>
    </div>
  );
}

function Composer({
  agentId,
  setTurns,
}: {
  agentId: string;
  setTurns: React.Dispatch<React.SetStateAction<ChatTurn[]>>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const msg = text.trim();
    if (!msg || sending) return;
    setSending(true);
    setError(null);
    // Optimistic: user turn + empty streaming assistant turn.
    setTurns((arr) => [
      ...arr,
      { role: "user", text: msg, local: true },
      { role: "assistant", text: "", local: true, streaming: true },
    ]);
    setText("");

    sendMessageStream(
      agentId,
      msg,
      (_delta, full) => {
        // Replace the last (streaming) turn's text with the accumulated full
        setTurns((arr) => {
          if (arr.length === 0) return arr;
          const idx = arr.length - 1;
          if (!arr[idx].streaming) return arr;
          const next = [...arr];
          next[idx] = { ...next[idx], text: full };
          return next;
        });
      },
      (full) => {
        // Mark the streaming turn done
        setTurns((arr) => {
          const idx = arr.length - 1;
          if (idx < 0 || !arr[idx].streaming) return arr;
          const next = [...arr];
          next[idx] = { ...next[idx], text: full || next[idx].text, streaming: false };
          return next;
        });
        setSending(false);
      },
      (errMsg) => {
        setError(errMsg);
        setTurns((arr) => {
          const idx = arr.length - 1;
          if (idx < 0) return arr;
          const next = [...arr];
          if (next[idx].streaming) {
            next[idx] = {
              ...next[idx],
              streaming: false,
              text: next[idx].text || `(stream error: ${errMsg})`,
            };
          }
          next.push({ role: "meta", text: `send failed: ${errMsg}`, local: true });
          return next;
        });
        setSending(false);
      },
    );
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl+Enter sends; plain Enter inserts newline (mobile-friendly).
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="relative flex items-end gap-2 min-w-0">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        rows={1}
        placeholder="message…"
        disabled={sending}
        className="flex-1 rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2
                   text-sm text-zinc-100 placeholder:text-zinc-600
                   resize-none min-h-[36px] max-h-[120px]
                   focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/30"
        style={{ fontSize: "16px" /* prevents iOS auto-zoom on focus */ }}
      />
      <button
        onClick={submit}
        disabled={sending || !text.trim()}
        className="btn-primary disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
        aria-label="Send"
        title="Cmd/Ctrl+Enter to send"
      >
        {sending ? (
          <svg viewBox="0 0 24 24" className="h-4 w-4 animate-spin" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" opacity="0.3" />
            <path d="M12 2 a10 10 0 0 1 10 10" strokeLinecap="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" />
          </svg>
        )}
      </button>
      {error && (
        <div className="absolute -bottom-5 left-0 text-[10px] text-rose-400">{error}</div>
      )}
    </div>
  );
}

export default function AgentDeck() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAgents()
      .then((a) => {
        setAgents(a);
        setLoading(false);
      })
      .catch((e: Error) => {
        setError(e.message);
        setLoading(false);
      });
  }, []);

  if (error) {
    return <div className="card p-6 text-rose-300">Failed to load agents: {error}</div>;
  }

  return (
    <div className="space-y-3 sm:space-y-5">
      {/* Per-agent deep view: chat panel, send composer, vitals, log tail.
          The high-level "what's happening" overview lives in the Live tab;
          hardware in the Fleet tab. */}
      <div className="grid gap-4 sm:gap-5 sm:grid-cols-2">
        {loading
          ? Array.from({ length: 4 }).map((_, i) => <AgentCardSkeleton key={i} />)
          : agents.map((a) => <AgentCard key={a.id} agent={a} />)}
      </div>
    </div>
  );
}

export function FleetStrip() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [metrics, setMetrics] = useState<Record<string, AgentMetricsResponse>>({});

  useEffect(() => {
    fetchAgents().then(setAgents).catch(() => {});
  }, []);

  useEffect(() => {
    if (agents.length === 0) return;
    let cancelled = false;
    const tick = async () => {
      const results = await Promise.allSettled(agents.map((a) => fetchAgentMetrics(a.id)));
      if (cancelled) return;
      const next: Record<string, AgentMetricsResponse> = {};
      for (const [i, r] of results.entries()) {
        if (r.status === "fulfilled") next[agents[i].id] = r.value;
      }
      setMetrics(next);
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [agents]);

  const agg = (key: keyof AgentMetricsResponse): number => {
    let sum = 0;
    for (const m of Object.values(metrics)) {
      const v = m[key];
      if (typeof v === "number") sum += v;
    }
    return sum;
  };
  const totalActivity = (() => {
    let total = 0;
    for (const m of Object.values(metrics)) total += (m.activity_buckets ?? []).reduce((a, b) => a + b, 0);
    return total;
  })();

  const stats = [
    { label: "Agents", value: String(agents.length) },
    { label: "Msgs today", value: String(agg("msgs_today")) },
    { label: "API calls today", value: String(agg("api_calls_today")) },
    { label: "Tools today", value: String(agg("tools_today")) },
    { label: "Activity (60m)", value: String(totalActivity) },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
      {stats.map((s) => (
        <div key={s.label} className="card p-3">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">{s.label}</div>
          <div className="mt-1 text-lg font-semibold tracking-tight">{s.value}</div>
        </div>
      ))}
    </div>
  );
}
