import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchAgents, toolColor, type Agent } from "./agents";
import NeuralNetMini from "./NeuralNetMini";
import { emitWorkflow as emitWorkflowFromBus, onWorkflow, type WorkflowEvent } from "./eventBus";

/**
 * Workflow graph: Brad node anchored at the bottom, agents in a row above,
 * connected by curved arcs. Particles travel ALONG the arcs in either
 * direction:
 *   - Brad → agent: incoming user message (sky)
 *   - agent → Brad: assistant response (emerald)
 *   - tool calls: amber particles orbit the agent
 *
 * Even when the fleet is silent, ambient particles drift along every
 * connection and a slow breath animates each node.
 */

type AgentActivity = "idle" | "receiving" | "thinking" | "responding";

const ACTIVITY_COLOR: Record<AgentActivity, string> = {
  idle: "#3b3f57",
  receiving: "#38bdf8",
  thinking: "#fbbf24",
  responding: "#34d399",
};

/** Per-agent accent color for idle/baseline. Activity colors take over when busy. */
const AGENT_TINT: Record<string, string> = {
  clue: "#a78bfa",          // violet — matches Toolkits/Tasks per-agent coding
  sarah: "#fb7185",         // rose
  claude: "#34d399",        // emerald — Anthropic-ish
  claude_natalie: "#34d399",
};
function agentTint(id: string): string {
  return AGENT_TINT[id] ?? "#6ee7b7"; // fallback emerald
}


type Stream = {
  id: string;
  // For user↔agent streams, only agentId is set.
  // For agent↔agent streams, both fromId and toId are set.
  agentId?: string;
  fromId?: string;
  toId?: string;
  // For user↔agent: direction along the brad-arc
  direction: "to_agent" | "to_user" | "agent_to_agent";
  color: string;
  startTs: number;
  count: number;
};

type ToolBurst = {
  id: string;
  agentId: string;
  name: string;
  startTs: number;
};

type SshFlow = {
  id: string;
  fromId: string;
  toId: string;
  startTs: number;
};

type Arc = { from: { x: number; y: number }; to: { x: number; y: number }; mid: { x: number; y: number } };

function elide(s: string, n: number): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

const SSH_FLAGS_WITH_ARG = new Set([
  "-i", "-p", "-l", "-o", "-F", "-E", "-L", "-R", "-D", "-W",
  "-c", "-m", "-e", "-B", "-b", "-J", "-Q", "-S", "-w", "-Y",
]);

function extractSshTarget(cmd: string): string | null {
  const m = cmd.match(/(?:^|[\s;&|`(])ssh\b\s+([^\n]+)/);
  if (!m) return null;
  const tokens = m[1].split(/\s+/);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (!t) { i++; continue; }
    if (t.startsWith("-")) {
      if (SSH_FLAGS_WITH_ARG.has(t)) i += 2;
      else i += 1;
      continue;
    }
    const at = t.indexOf("@");
    return (at >= 0 ? t.slice(at + 1) : t).replace(/[",;'`]/g, "");
  }
  return null;
}

// Hoisted to module scope so the array isn't reallocated every render frame
// when the radiating burst glyphs are rendered.
const BURST_GLYPHS = ["+", "*", "·", "◇", "×"] as const;

/** Quadratic-bezier point at parameter t (0–1). */
function bezier(arc: Arc, t: number): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * arc.from.x + 2 * u * t * arc.mid.x + t * t * arc.to.x,
    y: u * u * arc.from.y + 2 * u * t * arc.mid.y + t * t * arc.to.y,
  };
}

function useAgentEvents(
  agentId: string,
  format: "hermes" | "claude_code",
  onUserToAgent: (text: string) => void,
  onAgentToUser: (text: string) => void,
  onTool: (name: string) => void,
  onSshTarget: (host: string, cmd: string) => void,
) {
  const [activity, setActivity] = useState<AgentActivity>("idle");
  const decayTimerRef = useRef<number | null>(null);

  // Stash callbacks in refs so the WS effect doesn't re-run when the parent
  // re-creates inline closures — that previously leaked a fresh WebSocket
  // every render and DDoS'd the browser's renderer process.
  const cbRef = useRef({ onUserToAgent, onAgentToUser, onTool, onSshTarget });
  cbRef.current = { onUserToAgent, onAgentToUser, onTool, onSshTarget };

  useEffect(() => {
    let cancelled = false;
    let backoff = 500;
    let activeWs: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${window.location.host}/ws/agents/${agentId}/chat`;

    const trigger = (a: AgentActivity) => {
      setActivity(a);
      if (decayTimerRef.current) window.clearTimeout(decayTimerRef.current);
      decayTimerRef.current = window.setTimeout(() => setActivity("idle"), 5000);
    };

    const connect = () => {
      if (cancelled) return;
      const ws = new WebSocket(url);
      activeWs = ws;
      ws.onopen = () => { backoff = 500; };
      let backfilled = false;
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type === "backfill") {
            backfilled = true;
            return;
          }
          if (!backfilled || data.type !== "line") return;
          const line = data.line as string;
          let obj: any;
          try {
            obj = JSON.parse(line);
          } catch {
            return;
          }

          if (format === "claude_code") {
            const m = obj.message ?? {};
            const role = m.role ?? obj.type;
            const content = m.content;
            if (role === "user") {
              if (typeof content === "string" && content.trim()) {
                trigger("receiving");
                cbRef.current.onUserToAgent(elide(content, 70));
              } else if (Array.isArray(content)) {
                const text = content
                  .filter((b: any) => b?.type === "text" && typeof b.text === "string")
                  .map((b: any) => b.text)
                  .join(" ");
                if (text.trim()) {
                  trigger("receiving");
                  cbRef.current.onUserToAgent(elide(text, 70));
                }
              }
            } else if (role === "assistant") {
              if (typeof content === "string" && content.trim()) {
                trigger("responding");
                cbRef.current.onAgentToUser(elide(content, 70));
              } else if (Array.isArray(content)) {
                let text = "";
                let toolName: string | undefined;
                for (const b of content) {
                  if (!b || typeof b !== "object") continue;
                  if (b.type === "text" && typeof b.text === "string") text += b.text + " ";
                  else if (b.type === "tool_use") {
                    toolName = b.name;
                    // Sniff Bash commands for SSH calls so we can animate
                    // cross-machine flow on the workflow graph.
                    if (b.name === "Bash" && typeof b.input?.command === "string") {
                      const target = extractSshTarget(b.input.command);
                      if (target) cbRef.current.onSshTarget(target, b.input.command);
                    }
                  }
                }
                if (text.trim()) {
                  trigger("responding");
                  cbRef.current.onAgentToUser(elide(text, 70));
                }
                if (toolName) {
                  trigger("thinking");
                  cbRef.current.onTool(toolName);
                }
              }
            }
          } else {
            // hermes
            const role = obj.role;
            const content = typeof obj.content === "string" ? obj.content : "";
            if (role === "user" && content.trim()) {
              trigger("receiving");
              cbRef.current.onUserToAgent(elide(content, 70));
            } else if (role === "assistant") {
              const tcs = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
              if (tcs.length > 0) {
                trigger("thinking");
                cbRef.current.onTool(tcs[0]?.function?.name ?? "tool");
                for (const tc of tcs) {
                  const fn = tc?.function ?? {};
                  let argText = "";
                  try {
                    const args = typeof fn.arguments === "string"
                      ? JSON.parse(fn.arguments)
                      : (fn.arguments ?? {});
                    argText = args.command ?? args.cmd ?? args.script ?? "";
                  } catch { /* ignore */ }
                  if (typeof argText === "string" && argText) {
                    const target = extractSshTarget(argText);
                    if (target) cbRef.current.onSshTarget(target, argText);
                  }
                }
              } else if (content.trim()) {
                trigger("responding");
                cbRef.current.onAgentToUser(elide(content, 70));
              }
            }
          }
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (cancelled) return;
        reconnectTimer = window.setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 8000);
      };
      ws.onerror = () => {
        // onclose will fire next; nothing extra to do here.
      };
    };
    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
      if (decayTimerRef.current) window.clearTimeout(decayTimerRef.current);
      try { activeWs?.close(); } catch { /* noop */ }
    };
  }, [agentId, format]);

  return activity;
}

type TaskInfo = {
  id: number;
  title: string;
  owner_agent: string | null;
  status: string;
  updated_at: string;
};

type HistoryEvent = {
  _ts: number;
  type: string;
  agentId?: string;
  fromId?: string;
  toId?: string;
  tool?: string;
};

export default function WorkflowGraph() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [bursts, setBursts] = useState<ToolBurst[]>([]);
  const [sshFlows, setSshFlows] = useState<SshFlow[]>([]);
  const [taskCounts, setTaskCounts] = useState<Record<string, number>>({});
  const [activities, setActivities] = useState<Record<string, AgentActivity>>({});
  // Per-agent timer that resets externally-pushed activity back to idle so a
  // single workflow event doesn't pin an agent to "thinking" forever.
  const activityDecayRef = useRef<Map<string, number>>(new Map());
  const ACTIVITY_DECAY_MS = 6000;
  // useCallback so the reference is stable across renders — the onWorkflow
  // effect captures it in a `[]`-deps closure and we don't want it stale.
  // setActivities + activityDecayRef are both stable refs from React, so
  // empty deps are safe here.
  const bumpActivity = useCallback((agentId: string, act: AgentActivity) => {
    setActivities((m) => (m[agentId] === act ? m : { ...m, [agentId]: act }));
    const timers = activityDecayRef.current;
    const existing = timers.get(agentId);
    if (existing) window.clearTimeout(existing);
    if (act === "idle") {
      timers.delete(agentId);
      return;
    }
    const t = window.setTimeout(() => {
      setActivities((m) => (m[agentId] && m[agentId] !== "idle" ? { ...m, [agentId]: "idle" } : m));
      timers.delete(agentId);
    }, ACTIVITY_DECAY_MS);
    timers.set(agentId, t);
  }, []);
  useEffect(() => () => {
    for (const t of activityDecayRef.current.values()) window.clearTimeout(t);
    activityDecayRef.current.clear();
  }, []);
  const [now, setNow] = useState(() => performance.now());
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 720, h: 380 });

  // Replay scrubber state
  const [replayMode, setReplayMode] = useState(false);
  const [history, setHistory] = useState<HistoryEvent[]>([]);
  const [replayPos, setReplayPos] = useState(1); // 0..1 along the timeline
  const [playing, setPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(2);
  const lastDispatchedTsRef = useRef<number | null>(null);

  useEffect(() => {
    fetchAgents().then(setAgents).catch(() => {});
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      const w = Math.max(280, r.width);
      const h = w < 600 ? 360 : 400;
      setSize({ w, h });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // animation clock
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setNow(performance.now());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // GC
  useEffect(() => {
    const id = setInterval(() => {
      const cutoff = performance.now();
      setStreams((arr) => arr.filter((s) => cutoff - s.startTs < 2400));
      setBursts((arr) => arr.filter((b) => cutoff - b.startTs < 2200));
      setSshFlows((arr) => arr.filter((s) => cutoff - s.startTs < 2400));
    }, 700);
    return () => clearInterval(id);
  }, []);

  // Backend SSE: any /send or /stream call emits user_to_agent / agent_to_user
  // here, regardless of whether the source is the dashboard or external curl.
  // Disabled while in replay mode so live events don't pollute the playback.
  useEffect(() => {
    if (replayMode) return;
    const proto = window.location.protocol;
    const url = `${proto}//${window.location.host}/api/workflow/events`;
    let cancelled = false;
    let es: EventSource | null = null;
    const connect = () => {
      if (cancelled) return;
      es = new EventSource(url);
      es.onmessage = (ev) => {
        try {
          const obj = JSON.parse(ev.data);
          if (obj.type === "user_to_agent" && obj.agentId) {
            emitWorkflowFromBus({
              type: "user_to_agent",
              agentId: obj.agentId,
              text: "",
              ts: performance.now(),
            });
          } else if (obj.type === "agent_to_user" && obj.agentId) {
            emitWorkflowFromBus({
              type: "agent_to_user",
              agentId: obj.agentId,
              text: "",
              ts: performance.now(),
            });
          } else if (obj.type === "agent_to_agent" && obj.fromId && obj.toId) {
            emitWorkflowFromBus({
              type: "agent_to_agent",
              fromId: obj.fromId,
              toId: obj.toId,
              text: "",
              ts: performance.now(),
            });
          } else if (obj.type === "agent_tool" && obj.agentId) {
            emitWorkflowFromBus({
              type: "agent_tool",
              agentId: obj.agentId,
              tool: obj.tool || "tool",
              ts: performance.now(),
            });
          }
        } catch {
          /* ignore */
        }
      };
      es.onerror = () => {
        es?.close();
        if (!cancelled) setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      cancelled = true;
      es?.close();
    };
  }, [replayMode]);

  // Load history when entering replay mode
  useEffect(() => {
    if (!replayMode) {
      setHistory([]);
      setPlaying(false);
      lastDispatchedTsRef.current = null;
      return;
    }
    fetch("/api/workflow/history?minutes=120")
      .then((r) => r.json())
      .then((d) => setHistory(Array.isArray(d) ? d : []))
      .catch(() => setHistory([]));
  }, [replayMode]);

  // Replay clock — advances playback time when "playing", dispatching events
  // whose ts crossed into the playback window since the last tick.
  useEffect(() => {
    if (!replayMode || history.length === 0) return;
    const tStart = history[0]._ts;
    const tEnd = history[history.length - 1]._ts;
    const span = Math.max(1, tEnd - tStart);

    // Compute current playback ts from replayPos
    const playbackTs = tStart + replayPos * span;

    // Dispatch any events between lastDispatched and playbackTs
    const lastTs = lastDispatchedTsRef.current ?? playbackTs - 0.001;
    if (playbackTs >= lastTs) {
      for (const e of history) {
        if (e._ts > lastTs && e._ts <= playbackTs) {
          if (e.type === "user_to_agent" && e.agentId) {
            emitWorkflowFromBus({
              type: "user_to_agent", agentId: e.agentId, text: "", ts: performance.now(),
            });
          } else if (e.type === "agent_to_user" && e.agentId) {
            emitWorkflowFromBus({
              type: "agent_to_user", agentId: e.agentId, text: "", ts: performance.now(),
            });
          } else if (e.type === "agent_to_agent" && e.fromId && e.toId) {
            emitWorkflowFromBus({
              type: "agent_to_agent", fromId: e.fromId, toId: e.toId, text: "", ts: performance.now(),
            });
          } else if (e.type === "agent_tool" && e.agentId) {
            emitWorkflowFromBus({
              type: "agent_tool", agentId: e.agentId, tool: e.tool || "tool", ts: performance.now(),
            });
          }
        }
      }
    }
    lastDispatchedTsRef.current = playbackTs;
  }, [replayMode, history, replayPos]);

  // Auto-advance the slider while playing
  useEffect(() => {
    if (!replayMode || !playing || history.length === 0) return;
    const tStart = history[0]._ts;
    const tEnd = history[history.length - 1]._ts;
    const span = Math.max(1, tEnd - tStart);
    const id = setInterval(() => {
      setReplayPos((p) => {
        const np = p + (playSpeed * 0.1) / span;
        if (np >= 1) {
          setPlaying(false);
          return 1;
        }
        return np;
      });
    }, 100);
    return () => clearInterval(id);
  }, [replayMode, playing, playSpeed, history]);

  // External event bus (Broadcast composer → workflow)
  useEffect(() => {
    const off = onWorkflow((e: WorkflowEvent) => {
      const ts = performance.now();
      if (e.type === "user_to_agent") {
        setStreams((arr) =>
          [
            ...arr,
            {
              id: `stream-${e.agentId}-${ts}-${Math.random().toString(36).slice(2, 6)}`,
              agentId: e.agentId,
              direction: "to_agent" as const,
              color: "#38bdf8",
              startTs: ts,
              count: 28,
            },
          ].slice(-40),
        );
        bumpActivity(e.agentId, "receiving");
      } else if (e.type === "agent_to_user") {
        setStreams((arr) =>
          [
            ...arr,
            {
              id: `stream-${e.agentId}-${ts}-${Math.random().toString(36).slice(2, 6)}`,
              agentId: e.agentId,
              direction: "to_user" as const,
              color: "#34d399",
              startTs: ts,
              count: 28,
            },
          ].slice(-40),
        );
        bumpActivity(e.agentId, "responding");
      } else if (e.type === "agent_to_agent") {
        setStreams((arr) =>
          [
            ...arr,
            {
              id: `stream-${e.fromId}-${e.toId}-${ts}-${Math.random().toString(36).slice(2, 6)}`,
              fromId: e.fromId,
              toId: e.toId,
              direction: "agent_to_agent" as const,
              color: "#f0abfc",
              startTs: ts,
              count: 24,
            },
          ].slice(-40),
        );
        bumpActivity(e.fromId, "responding");
        bumpActivity(e.toId, "receiving");
      } else if (e.type === "agent_tool") {
        setBursts((arr) =>
          [
            ...arr,
            {
              id: `burst-${e.agentId}-${ts}-${Math.random().toString(36).slice(2, 6)}`,
              agentId: e.agentId,
              name: e.tool,
              startTs: ts,
            },
          ].slice(-30),
        );
        bumpActivity(e.agentId, "thinking");
      }
    });
    return off;
  }, []);

  // Tasks: just track per-agent in_progress counts (drives badge)
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/tasks");
        if (!r.ok) return;
        const tasks = (await r.json()) as TaskInfo[];
        if (stopped) return;
        const counts: Record<string, number> = {};
        for (const t of tasks) {
          if (t.status === "in_progress" && t.owner_agent) {
            counts[t.owner_agent] = (counts[t.owner_agent] ?? 0) + 1;
          }
        }
        setTaskCounts(counts);
      } catch {
        /* noop */
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  // Layout: agents in a horizontal row at top, Brad bottom-center
  const userPos = { x: size.w / 2, y: size.h - 64 };
  const agentPositions = useMemo(() => {
    if (agents.length === 0) return [] as { x: number; y: number }[];
    const margin = 70;
    const usable = Math.max(1, size.w - margin * 2);
    const step = agents.length === 1 ? 0 : usable / (agents.length - 1);
    const cy = 80;
    const offsetX = agents.length === 1 ? size.w / 2 : margin;
    return agents.map((_, i) => ({ x: offsetX + step * i, y: cy }));
  }, [agents, size.w]);

  const arcs = useMemo<Arc[]>(() => {
    return agentPositions.map((p) => {
      // Curve mid-point, biased toward each side so arcs don't all overlap
      const dx = p.x - userPos.x;
      const midX = userPos.x + dx * 0.55;
      const midY = (userPos.y + p.y) / 2 - Math.abs(dx) * 0.15 - 30;
      return { from: userPos, to: p, mid: { x: midX, y: midY } };
    });
  }, [agentPositions, userPos.x, userPos.y]);

  // Inter-agent arcs (agent ↔ agent). Bowed UP, above the agent row.
  const peerArcs = useMemo(() => {
    const out: { fromIdx: number; toIdx: number; arc: Arc }[] = [];
    for (let i = 0; i < agentPositions.length; i++) {
      for (let j = i + 1; j < agentPositions.length; j++) {
        const a = agentPositions[i];
        const b = agentPositions[j];
        const midX = (a.x + b.x) / 2;
        // Bow upward: stronger when agents are far apart
        const sep = Math.abs(b.x - a.x);
        const midY = a.y - 32 - sep * 0.18;
        out.push({ fromIdx: i, toIdx: j, arc: { from: a, to: b, mid: { x: midX, y: midY } } });
      }
    }
    return out;
  }, [agentPositions]);

  const peerArcByPair = useMemo(() => {
    const m = new Map<string, { arc: Arc; reverse: boolean }>();
    for (const pa of peerArcs) {
      const a = agents[pa.fromIdx]?.id;
      const b = agents[pa.toIdx]?.id;
      if (!a || !b) continue;
      m.set(`${a}|${b}`, { arc: pa.arc, reverse: false });
      m.set(`${b}|${a}`, { arc: pa.arc, reverse: true });
    }
    return m;
  }, [peerArcs, agents]);

  // Memoized so we don't allocate new arrays via Object.values + filter on
  // every animation-frame `now` update — only recompute when activities change.
  const overallActivity = useMemo(
    () => Object.values(activities).filter((a) => a !== "idle").length,
    [activities],
  );
  const auroraIntensity = Math.min(1, overallActivity / Math.max(1, agents.length));

  return (
    <div ref={containerRef} className="card p-4 w-full overflow-hidden relative">
      {/* aurora background */}
      <div
        className="absolute inset-0 pointer-events-none transition-opacity duration-700"
        style={{
          background:
            "radial-gradient(ellipse 130% 100% at 50% 110%, rgba(52,211,153,0.22), transparent 65%)," +
            "radial-gradient(ellipse 50% 50% at 20% 0%, rgba(56,189,248,0.10), transparent 70%)," +
            "radial-gradient(ellipse 50% 50% at 80% 0%, rgba(52,211,153,0.10), transparent 70%)",
          opacity: 0.45 + auroraIntensity * 0.55,
        }}
      />

      <div className="relative flex items-center justify-between mb-3 gap-2">
        <div className="text-sm font-semibold tracking-tight">Workflow</div>
        <div className="flex items-center gap-2">
          <div className="text-[10px] text-zinc-500">
            {replayMode ? "replay mode" : "live"} · {agents.length} agents · {streams.length + bursts.length} active
          </div>
          <button
            onClick={() => {
              setReplayMode((r) => !r);
              if (!replayMode) {
                setReplayPos(0);
                setPlaying(false);
              }
            }}
            className={`text-[10px] px-2 py-1 rounded border transition ${
              replayMode
                ? "bg-fuchsia-500/15 border-fuchsia-500/40 text-fuchsia-200"
                : "border-ink-700 text-zinc-400 hover:text-zinc-100 hover:border-accent/40"
            }`}
            title="Replay the last 2 hours of fleet activity"
          >
            {replayMode ? "● live" : "⏪ replay"}
          </button>
        </div>
      </div>

      <svg width={size.w} height={size.h} className="block max-w-full relative">
        <defs>
          <linearGradient id="arc-grad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#7c5cff" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.30" />
          </linearGradient>
          <radialGradient id="user-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#a78bfa" stopOpacity="0.7" />
            <stop offset="100%" stopColor="#7c5cff" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Inter-agent arcs (mesh, bowed upward) */}
        {peerArcs.map((pa, k) => {
          const fromId = agents[pa.fromIdx]?.id ?? "";
          const toId = agents[pa.toIdx]?.id ?? "";
          const fromAct = activities[fromId] ?? "idle";
          const toAct = activities[toId] ?? "idle";
          const lit = fromAct !== "idle" || toAct !== "idle";
          return (
            <path
              key={`peer-arc-${k}`}
              d={`M ${pa.arc.from.x} ${pa.arc.from.y} Q ${pa.arc.mid.x} ${pa.arc.mid.y} ${pa.arc.to.x} ${pa.arc.to.y}`}
              fill="none"
              stroke={lit ? "#f0abfc" : "#3b3f57"}
              strokeWidth={lit ? 1.4 : 0.8}
              strokeDasharray="2 4"
              opacity={lit ? 0.55 : 0.25}
              style={{
                filter: lit ? "drop-shadow(0 0 4px #f0abfc)" : "none",
                transition: "all 250ms ease",
              }}
            />
          );
        })}

        {/* Ambient drift along inter-agent arcs */}
        {peerArcs.flatMap((pa, ai) => {
          const els: any[] = [];
          const cycle = 9000;
          const N = 4;
          for (let i = 0; i < N; i++) {
            const phase = ((now + i * (cycle / N) + ai * 1900) % cycle) / cycle;
            const p = bezier(pa.arc, phase);
            const opacity = Math.sin(phase * Math.PI) * 0.22;
            const r = 0.9 + Math.sin(phase * Math.PI) * 0.5;
            els.push(
              <circle
                key={`peer-drift-${ai}-${i}`}
                cx={p.x}
                cy={p.y}
                r={r}
                fill="#f0abfc"
                opacity={opacity}
              />,
            );
          }
          return els;
        })}

        {/* Connection arcs (one per agent) */}
        {arcs.map((arc, i) => {
          const a = agents[i];
          const act = activities[a?.id ?? ""] ?? "idle";
          const stroke =
            act === "idle" ? "url(#arc-grad)" : ACTIVITY_COLOR[act];
          const opacity = act === "idle" ? 0.35 : 0.7;
          return (
            <g key={`arc-${a?.id ?? i}`}>
              <path
                d={`M ${arc.from.x} ${arc.from.y} Q ${arc.mid.x} ${arc.mid.y} ${arc.to.x} ${arc.to.y}`}
                fill="none"
                stroke={stroke}
                strokeWidth={act === "idle" ? 1.2 : 2}
                opacity={opacity}
                style={{
                  filter: act === "idle" ? "none" : `drop-shadow(0 0 6px ${ACTIVITY_COLOR[act]})`,
                  transition: "all 250ms ease",
                }}
              />
            </g>
          );
        })}

        {/* Ambient drift along each arc (always-on slow shimmer) */}
        {arcs.flatMap((arc, ai) => {
          const els: any[] = [];
          const cycle = 7000;
          const N = 6;
          for (let i = 0; i < N; i++) {
            const phase = ((now + i * (cycle / N) + ai * 1500) % cycle) / cycle;
            const p = bezier(arc, phase);
            const opacity = Math.sin(phase * Math.PI) * 0.3;
            const r = 1.0 + Math.sin(phase * Math.PI) * 0.6;
            els.push(
              <circle
                key={`drift-${ai}-${i}`}
                cx={p.x}
                cy={p.y}
                r={r}
                fill="#a78bfa"
                opacity={opacity}
              />
            );
          }
          return els;
        })}

        {/* Active streams along arcs */}
        {streams.flatMap((s) => {
          let arc: Arc | undefined;
          let reverse = false;
          if (s.direction === "agent_to_agent" && s.fromId && s.toId) {
            const found = peerArcByPair.get(`${s.fromId}|${s.toId}`);
            if (!found) return [];
            arc = found.arc;
            reverse = found.reverse;
          } else if (s.agentId) {
            const idx = agents.findIndex((a) => a.id === s.agentId);
            if (idx < 0) return [];
            arc = arcs[idx];
          }
          if (!arc) return [];
          const els: any[] = [];
          const seed = parseInt(s.id.slice(-6) || "0", 36);
          for (let i = 0; i < s.count; i++) {
            const rand = (n: number) => {
              const x = Math.sin(seed + i * 13.37 + n) * 10000;
              return x - Math.floor(x);
            };
            const emitDelay = i * 26;
            const elapsed = (now - s.startTs - emitDelay) / 1700;
            if (elapsed < 0 || elapsed >= 1) continue;
            const ease = 1 - Math.pow(1 - elapsed, 1.4);
            let t: number;
            if (s.direction === "to_agent") t = ease;
            else if (s.direction === "to_user") t = 1 - ease;
            else t = reverse ? 1 - ease : ease;
            const p = bezier(arc, t);
            const lateral = (rand(1) - 0.5) * 8 * Math.sin(elapsed * Math.PI);
            const r = 1.2 + rand(2) * 1.4;
            const opacity = (1 - Math.abs(elapsed - 0.5) * 1.6) * 0.95;
            els.push(
              <circle
                key={`${s.id}-${i}`}
                cx={p.x + lateral}
                cy={p.y + lateral * 0.4}
                r={r}
                fill={s.color}
                opacity={Math.max(0, opacity)}
                style={{ filter: `drop-shadow(0 0 ${3 + r * 2}px ${s.color})` }}
              />
            );
          }
          return els;
        })}

        {/* SSH flows: terminal-green particles travel along the peer arc */}
        {sshFlows.flatMap((s) => {
          const found = peerArcByPair.get(`${s.fromId}|${s.toId}`);
          if (!found) return [];
          const arc = found.arc;
          const reverse = found.reverse;
          const els: any[] = [];
          const N = 22;
          const seed = parseInt(s.id.slice(-6) || "0", 36);
          for (let i = 0; i < N; i++) {
            const rand = (n: number) => {
              const x = Math.sin(seed + i * 11.11 + n) * 10000;
              return x - Math.floor(x);
            };
            const emitDelay = i * 28;
            const elapsed = (now - s.startTs - emitDelay) / 1700;
            if (elapsed < 0 || elapsed >= 1) continue;
            const ease = 1 - Math.pow(1 - elapsed, 1.3);
            const tt = reverse ? 1 - ease : ease;
            const p = bezier(arc, tt);
            const lateral = (rand(1) - 0.5) * 6 * Math.sin(elapsed * Math.PI);
            const r = 1.4 + rand(2) * 1.2;
            const opacity = (1 - Math.abs(elapsed - 0.5) * 1.6) * 0.95;
            els.push(
              <circle
                key={`${s.id}-${i}`}
                cx={p.x + lateral}
                cy={p.y + lateral * 0.4}
                r={r}
                fill="#5eead4"
                opacity={Math.max(0, opacity)}
                style={{ filter: `drop-shadow(0 0 ${3 + r * 2}px #5eead4)` }}
              />
            );
          }
          // SSH badge near the arc midpoint
          const elapsed = (now - s.startTs) / 1700;
          if (elapsed < 0.6) {
            const labelOp = elapsed < 0.18 ? elapsed / 0.18 : 1 - Math.max(0, (elapsed - 0.4) / 0.2);
            els.push(
              <text
                key={`${s.id}-label`}
                x={arc.mid.x}
                y={arc.mid.y - 4}
                textAnchor="middle"
                fontSize="10"
                fontFamily="ui-monospace, monospace"
                fontWeight="700"
                fill="#5eead4"
                opacity={labelOp}
                style={{ filter: "drop-shadow(0 0 4px #5eead4)", pointerEvents: "none" }}
              >
                $ ssh
              </text>
            );
          }
          return els;
        })}

        {/* Tool-call burst: shockwave ring + radiating ASCII glyphs +
            tool-tinted orbit. Color is keyed off tool category. */}
        {bursts.flatMap((b) => {
          const idx = agents.findIndex((a) => a.id === b.agentId);
          if (idx < 0) return [];
          const pos = agentPositions[idx];
          if (!pos) return [];
          const elapsed = (now - b.startTs) / 1900;
          if (elapsed >= 1) return [];
          const color = toolColor(b.name);
          const els: any[] = [];

          // Shockwave: expanding stroked rings, fade fast
          const shockE = Math.min(1, elapsed * 2.2);
          const shockR = 26 + shockE * 38;
          const shockOp = (1 - shockE) * 0.55;
          if (shockOp > 0.01) {
            els.push(
              <circle
                key={`${b.id}-shock`}
                cx={pos.x}
                cy={pos.y}
                r={shockR}
                fill="none"
                stroke={color}
                strokeWidth={1.2}
                opacity={shockOp}
              />,
            );
            // Inner shockwave for double-ring effect
            els.push(
              <circle
                key={`${b.id}-shock2`}
                cx={pos.x}
                cy={pos.y}
                r={shockR * 0.72}
                fill="none"
                stroke={color}
                strokeWidth={0.6}
                opacity={shockOp * 0.5}
              />,
            );
          }

          // Radiating ASCII glyphs: shoot outward from agent
          // (BURST_GLYPHS hoisted to module scope, see top of file)
          const RADIATE_N = 8;
          const seedBase = parseInt(b.id.slice(-6) || "0", 36);
          for (let i = 0; i < RADIATE_N; i++) {
            const angle = (i / RADIATE_N) * Math.PI * 2 + (seedBase % 7) * 0.13;
            const dist = 18 + elapsed * 60;
            const gx = pos.x + Math.cos(angle) * dist;
            const gy = pos.y + Math.sin(angle) * dist;
            const op = (1 - elapsed) * 0.9;
            const glyph = BURST_GLYPHS[(i + seedBase) % BURST_GLYPHS.length];
            els.push(
              <text
                key={`${b.id}-glyph-${i}`}
                x={gx}
                y={gy}
                textAnchor="middle"
                fontSize="11"
                fontFamily="JetBrains Mono, ui-monospace, monospace"
                fontWeight="700"
                fill={color}
                opacity={op}
                style={{ pointerEvents: "none" }}
              >
                {glyph}
              </text>,
            );
          }

          // Tool-tinted orbit (fast inner ring)
          const N = 12;
          const orbitR = 22 + elapsed * 14;
          for (let i = 0; i < N; i++) {
            const angle = (i / N) * Math.PI * 2 + elapsed * 5;
            const x = pos.x + Math.cos(angle) * orbitR;
            const y = pos.y + Math.sin(angle) * orbitR;
            const opacity = (1 - elapsed) * 0.8;
            // Use a halo (larger faded circle behind a brighter dot) instead
            // of a drop-shadow filter — same look, much cheaper on iGPU.
            els.push(
              <circle
                key={`${b.id}-halo-${i}`}
                cx={x}
                cy={y}
                r={3.2}
                fill={color}
                opacity={opacity * 0.25}
              />,
              <circle
                key={`${b.id}-${i}`}
                cx={x}
                cy={y}
                r={1.4}
                fill={color}
                opacity={opacity}
              />,
            );
          }

          // Tool name badge — terminal-style with `> ` prefix
          const labelOp = elapsed < 0.18 ? elapsed / 0.18 : 1 - Math.max(0, (elapsed - 0.55) / 0.45);
          els.push(
            <text
              key={`${b.id}-label-bg`}
              x={pos.x}
              y={pos.y - 50}
              textAnchor="middle"
              fontSize="10"
              fontFamily="JetBrains Mono, ui-monospace, monospace"
              fontWeight="700"
              fill="#0a0a0d"
              opacity={labelOp}
              stroke="#0a0a0d"
              strokeWidth="3"
              style={{ pointerEvents: "none" }}
            >
              &gt; {b.name}
            </text>,
            <text
              key={`${b.id}-label`}
              x={pos.x}
              y={pos.y - 50}
              textAnchor="middle"
              fontSize="10"
              fontFamily="JetBrains Mono, ui-monospace, monospace"
              fontWeight="700"
              fill={color}
              opacity={labelOp}
              style={{ pointerEvents: "none" }}
            >
              &gt; {b.name}
            </text>,
          );
          return els;
        })}

        {/* Brad node */}
        <UserNode cx={userPos.x} cy={userPos.y} now={now} />

        {/* Agent nodes */}
        {agents.map((a, i) => {
          const pos = agentPositions[i];
          if (!pos) return null;
          return (
            <AgentSlot
              key={a.id}
              agent={a}
              cx={pos.x}
              cy={pos.y}
              now={now}
              index={i}
              taskCount={taskCounts[a.id] ?? 0}
              currentActivity={activities[a.id] ?? "idle"}
              onActivity={(act) => bumpActivity(a.id, act)}
              onUserToAgent={() => {
                setStreams((arr) =>
                  [
                    ...arr,
                    {
                      id: `stream-${a.id}-${performance.now()}-${Math.random().toString(36).slice(2, 6)}`,
                      agentId: a.id,
                      direction: "to_agent" as const,
                      color: "#38bdf8",
                      startTs: performance.now(),
                      count: 28,
                    },
                  ].slice(-40),
                );
              }}
              onAgentToUser={() => {
                setStreams((arr) =>
                  [
                    ...arr,
                    {
                      id: `stream-${a.id}-${performance.now()}-${Math.random().toString(36).slice(2, 6)}`,
                      agentId: a.id,
                      direction: "to_user" as const,
                      color: "#34d399",
                      startTs: performance.now(),
                      count: 28,
                    },
                  ].slice(-40),
                );
              }}
              onTool={(name) => {
                setBursts((arr) =>
                  [
                    ...arr,
                    {
                      id: `burst-${a.id}-${performance.now()}-${Math.random().toString(36).slice(2, 6)}`,
                      agentId: a.id,
                      name,
                      startTs: performance.now(),
                    },
                  ].slice(-30),
                );
              }}
              onSshTarget={(host) => {
                // Map the SSH destination (host or IP) to a known agent.
                // Match if any agent's host string contains the target or
                // vice-versa (handles 10.0.0.x ↔ Tailscale IPs ↔ hostnames).
                const target = agents.find(
                  (x) =>
                    x.id !== a.id &&
                    x.host &&
                    (x.host === host ||
                      x.host.includes(host) ||
                      host.includes(x.host)),
                );
                if (!target) return;
                setSshFlows((arr) =>
                  [
                    ...arr,
                    {
                      id: `ssh-${a.id}-${target.id}-${performance.now()}-${Math.random().toString(36).slice(2, 6)}`,
                      fromId: a.id,
                      toId: target.id,
                      startTs: performance.now(),
                    },
                  ].slice(-20),
                );
                bumpActivity(a.id, "responding");
                bumpActivity(target.id, "receiving");
              }}
            />
          );
        })}
      </svg>

      {replayMode && (
        <div className="relative mt-3 px-1">
          {(() => {
            const tStart = history[0]?._ts;
            const tEnd = history[history.length - 1]?._ts;
            const playbackTs = tStart != null && tEnd != null
              ? tStart + replayPos * (tEnd - tStart)
              : null;
            return (
              <>
                <div className="flex items-center gap-2 text-[10px] mb-1">
                  <button
                    onClick={() => setPlaying((p) => !p)}
                    disabled={history.length === 0}
                    className="px-2 py-0.5 rounded border border-ink-700 hover:border-accent/40 text-zinc-300"
                  >
                    {playing ? "⏸ pause" : "▶ play"}
                  </button>
                  <button
                    onClick={() => {
                      setReplayPos(0);
                      lastDispatchedTsRef.current = null;
                    }}
                    className="px-2 py-0.5 rounded border border-ink-700 hover:border-accent/40 text-zinc-300"
                  >
                    ⏮ start
                  </button>
                  <span className="text-zinc-500">speed</span>
                  {[1, 2, 4, 10].map((s) => (
                    <button
                      key={s}
                      onClick={() => setPlaySpeed(s)}
                      className={`px-1.5 py-0.5 rounded border ${
                        playSpeed === s
                          ? "bg-fuchsia-500/15 border-fuchsia-500/40 text-fuchsia-200"
                          : "border-ink-700 text-zinc-400 hover:text-zinc-100"
                      }`}
                    >
                      {s}×
                    </button>
                  ))}
                  <span className="ml-auto font-mono text-zinc-400 tabular-nums">
                    {playbackTs
                      ? new Date(playbackTs * 1000).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })
                      : "—"}
                    {" "}
                    <span className="text-zinc-600">
                      ({history.length} events)
                    </span>
                  </span>
                </div>
                <ReplayScrubber
                  pos={replayPos}
                  setPos={(np) => {
                    setReplayPos(np);
                    lastDispatchedTsRef.current = null;
                  }}
                  tStart={tStart}
                  tEnd={tEnd}
                  disabled={history.length === 0}
                />
              </>
            );
          })()}
        </div>
      )}

      <div className="relative mt-2 flex items-center gap-4 text-[10px] text-zinc-500 flex-wrap">
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-sky-400" /> you → agent
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> agent → you
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-300" /> agent ↔ agent
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-teal-300" /> ssh
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> tool call
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> ambient
        </span>
      </div>
    </div>
  );
}

function UserNode({ cx, cy, now }: { cx: number; cy: number; now: number }) {
  const breath = Math.sin(now / 900);
  const radius = 28 + breath * 1.2;
  const glow = 10 + breath * 2;
  return (
    <g style={{ pointerEvents: "none" }}>
      {/* Outer halo */}
      <circle cx={cx} cy={cy} r={radius + 14} fill="url(#user-glow)" opacity={0.7} />
      {/* Main disc */}
      <circle
        cx={cx}
        cy={cy}
        r={radius}
        fill="#11121a"
        stroke="#a78bfa"
        strokeWidth="2.5"
        style={{ filter: `drop-shadow(0 0 ${glow}px #7c5cff)` }}
      />
      {/* Person glyph */}
      <g transform={`translate(${cx}, ${cy})`}>
        <circle cx="0" cy="-6" r="6" fill="#a78bfa" />
        <path d="M -10 10 Q 0 -2 10 10 L 10 12 L -10 12 Z" fill="#a78bfa" />
      </g>
      <text
        x={cx}
        y={cy + radius + 16}
        textAnchor="middle"
        fontSize="11"
        fontWeight="700"
        fill="#e5e7eb"
        style={{ letterSpacing: "0.5px" }}
      >
        Brad
      </text>
      <text
        x={cx}
        y={cy + radius + 30}
        textAnchor="middle"
        fontSize="9"
        fill="#7c5cff"
        fontFamily="ui-monospace, monospace"
        style={{ letterSpacing: "1px" }}
      >
        you
      </text>
    </g>
  );
}

/** Agent-specific bright/glow color for the neural-net canvas inside the orb.
 *  Falls back to the activity color when busy so the orb visually shifts state. */
const AGENT_NET_GLOW: Record<string, string> = {
  clue: "#c4b5fd",
  sarah: "#fda4af",
  claude: "#6ee7b7",
  claude_natalie: "#6ee7b7",
};

function AgentNode({
  agent,
  cx,
  cy,
  activity,
  breathPhase,
}: {
  agent: Agent;
  cx: number;
  cy: number;
  activity: AgentActivity;
  breathPhase: number;
}) {
  // Tint = idle resting color, activity color takes over when busy.
  const tint = agentTint(agent.id);
  const color = activity === "idle" ? tint : ACTIVITY_COLOR[activity];
  const glowTint = AGENT_NET_GLOW[agent.id] ?? "#a7f3d0";
  const baseRadius = 30;
  const radius = baseRadius * (1 + 0.04 * Math.sin(breathPhase));
  const glow = (activity === "idle" ? 6 : 16) + 2 * Math.sin(breathPhase);
  const netActive = activity !== "idle";
  const fo = radius * 2;

  return (
    <g style={{ transition: "all 200ms ease" }}>
      {/* Filled background disc behind the canvas — keeps the orb opaque. */}
      <circle cx={cx} cy={cy} r={radius} fill="#0a0a0d" />
      {/* Neural-net canvas clipped to a circle via foreignObject + border-radius. */}
      <foreignObject x={cx - radius} y={cy - radius} width={fo} height={fo}>
        <div
          style={{
            width: "100%",
            height: "100%",
            borderRadius: "50%",
            overflow: "hidden",
            position: "relative",
          }}
        >
          <NeuralNetMini color={tint} glowColor={glowTint} active={netActive} />
        </div>
      </foreignObject>
      {/* Stroked border ring on top — color shifts with activity. */}
      <circle
        cx={cx}
        cy={cy}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth="2"
        style={{ filter: `drop-shadow(0 0 ${glow}px ${color})` }}
      />
      {/* Agent name BELOW the orb (was inside, but the canvas takes the interior). */}
      <text
        x={cx}
        y={cy + radius + 14}
        textAnchor="middle"
        fontSize="11"
        fontWeight="700"
        fill="#e5e7eb"
        fontFamily="JetBrains Mono, ui-monospace, monospace"
        style={{ pointerEvents: "none", letterSpacing: "0.5px" }}
      >
        {agent.name.length > 11 ? agent.name.slice(0, 11) : agent.name}
      </text>
      {/* Activity word ABOVE the orb. */}
      <text
        x={cx}
        y={cy - radius - 16}
        textAnchor="middle"
        fontSize="9"
        fill="#71717a"
        fontFamily="JetBrains Mono, ui-monospace, monospace"
        style={{ pointerEvents: "none" }}
      >
        {agent.model.slice(0, 22)}
      </text>
      <text
        x={cx}
        y={cy - radius - 4}
        textAnchor="middle"
        fontSize="9"
        fill={color}
        fontWeight="700"
        fontFamily="JetBrains Mono, ui-monospace, monospace"
        style={{ pointerEvents: "none", letterSpacing: "1px" }}
      >
        {activity.toUpperCase()}
      </text>
    </g>
  );
}

function AgentSlot({
  agent,
  cx,
  cy,
  now,
  index,
  taskCount,
  currentActivity,
  onActivity,
  onUserToAgent,
  onAgentToUser,
  onTool,
  onSshTarget,
}: {
  agent: Agent;
  cx: number;
  cy: number;
  now: number;
  index: number;
  taskCount: number;
  currentActivity: AgentActivity;
  onActivity: (a: AgentActivity) => void;
  onUserToAgent: (text: string) => void;
  onAgentToUser: (text: string) => void;
  onTool: (name: string) => void;
  onSshTarget: (host: string, cmd: string) => void;
}) {
  const activity = useAgentEvents(
    agent.id,
    agent.chat_format,
    onUserToAgent,
    onAgentToUser,
    onTool,
    onSshTarget,
  );

  const breathPhase = (now / 1000) * 1.2 + index * 0.7;

  const lastActRef = useRef<AgentActivity>("idle");
  useEffect(() => {
    if (activity !== lastActRef.current) {
      lastActRef.current = activity;
      onActivity(activity);
    }
  }, [activity, onActivity]);

  // Use the more-recent of WS-derived activity vs externally-pushed activity
  const displayActivity =
    activity !== "idle" ? activity : currentActivity;

  return (
    <>
      <AgentNode
        agent={agent}
        cx={cx}
        cy={cy}
        activity={displayActivity}
        breathPhase={breathPhase}
      />
      {taskCount > 0 && (
        <g style={{ pointerEvents: "none" }}>
          <circle
            cx={cx + 24}
            cy={cy - 22}
            r="10"
            fill="#7c5cff"
            stroke="#0a0a0d"
            strokeWidth="2"
            style={{ filter: "drop-shadow(0 0 6px rgba(52,211,153,0.8))" }}
          />
          <text
            x={cx + 24}
            y={cy - 18}
            textAnchor="middle"
            fontSize="11"
            fontWeight="700"
            fill="#fff"
          >
            {taskCount}
          </text>
        </g>
      )}
    </>
  );
}

// Replay scrubber: accent-themed range input with a hover tooltip that shows
// the playback time at the cursor's position. Native <input type=range> already
// supports click-to-seek; we layer the tooltip + custom styling on top.
function ReplayScrubber({
  pos,
  setPos,
  tStart,
  tEnd,
  disabled,
}: {
  pos: number;
  setPos: (p: number) => void;
  tStart: number | undefined;
  tEnd: number | undefined;
  disabled: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverPos, setHoverPos] = useState<number | null>(null);

  const fmt = (ts: number) =>
    new Date(ts * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

  const hoverTs =
    hoverPos != null && tStart != null && tEnd != null
      ? tStart + hoverPos * (tEnd - tStart)
      : null;

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (disabled) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const p = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHoverPos(p);
  };

  return (
    <div
      ref={wrapRef}
      className="relative"
      onMouseMove={onMove}
      onMouseLeave={() => setHoverPos(null)}
    >
      {hoverTs != null && (
        <div
          className="absolute -top-7 px-1.5 py-0.5 rounded font-mono text-[10px] tabular-nums bg-ink-900 border border-accent/40 text-accent-glow phosphor-soft pointer-events-none whitespace-nowrap -translate-x-1/2"
          style={{ left: `${(hoverPos ?? 0) * 100}%` }}
        >
          {fmt(hoverTs)}
        </div>
      )}
      <input
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={pos}
        onChange={(e) => setPos(parseFloat(e.target.value))}
        disabled={disabled}
        className="replay-scrubber w-full h-1.5 cursor-pointer disabled:cursor-not-allowed"
        style={{ ["--rs-pct" as string]: `${pos * 100}%` }}
      />
    </div>
  );
}
