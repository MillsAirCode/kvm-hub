// ActivityFeed.tsx
import { useEffect, useState } from "react";
import { sessionNickname } from "./sessionName";
import { Skeleton } from "./Skeleton";
import EmptyHero from "./EmptyHero";

type MsgEvent = {
  type: "message";
  ts: string;
  peer_id: string;
  session_id: string;
  content: string;
};

type TaskEvent = {
  type: "task";
  ts: string;
  task_id: number;
  title: string;
  owner_agent: string | null;
  status: string;
  created_at: string;
};

type Event = MsgEvent | TaskEvent;

function relTime(iso: string): string {
  if (!iso) return "—";
  const cleaned = iso.replace(" ", "T");
  const t = new Date(cleaned.endsWith("Z") ? cleaned : cleaned + "Z").getTime();
  if (isNaN(t)) return iso;
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 0) return "now";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

function isHumanPeer(id: string): boolean {
  return /^\d+$/.test(id);
}

function peerLabel(id: string): string {
  if (id === "hermes") return "AI";
  if (isHumanPeer(id)) return "Brad";
  if (id === "user-default-hermes-agent") return "API";
  return id.slice(0, 16);
}

function peerColors(id: string): string {
  if (id === "hermes") return "text-emerald-300 bg-emerald-500/10 border-emerald-500/30";
  if (isHumanPeer(id)) return "text-sky-300 bg-sky-500/10 border-sky-500/30";
  return "text-amber-300 bg-amber-500/10 border-amber-500/30";
}

const TASK_STATUS_COLOR: Record<string, string> = {
  pending: "text-zinc-300 bg-zinc-500/10 border-zinc-500/30",
  in_progress: "text-amber-300 bg-amber-500/10 border-amber-500/30",
  completed: "text-emerald-300 bg-emerald-500/10 border-emerald-500/30",
  cancelled: "text-rose-300 bg-rose-500/10 border-rose-500/30",
};

export default function ActivityFeed() {
  const [events, setEvents] = useState<Event[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/activity?limit=120");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (cancelled) return;
        setEvents(d.events ?? []);
        setError(null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    tick();
    const id = setInterval(tick, 7000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const toggleExpand = (key: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="card hover-phosphor-card p-5 min-w-0">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-mono font-bold tracking-tight text-zinc-100">
            <span className="text-zinc-500">[</span>
            <span className="phosphor text-accent-glow">ACTIVITY</span>
            <span className="text-zinc-500">]</span>
          </span>
          <span className="text-[10px] font-mono text-zinc-500 bracket-value">
            {events.length} events
          </span>
        </div>
        {error && <div className="text-[10px] font-mono text-rose-400">err: {error}</div>}
      </div>

      <div className="space-y-2 max-h-[560px] overflow-y-auto pr-1 font-mono text-xs">
        {loading && events.length === 0 ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="space-y-1.5 py-1.5 border-b border-ink-800/40 last:border-b-0">
              <div className="flex items-center gap-2">
                <Skeleton className="h-2 w-2" rounded="rounded-full" />
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-2.5 w-12 ml-auto" />
              </div>
              <Skeleton className="h-2 w-full" />
            </div>
          ))
        ) : events.length === 0 ? (
          <EmptyHero glyph="▼" tagline="// activity feed · waiting for workflow events" />
        ) : (
          events.map((e, i) => {
            const key = e.type === "message" ? `m-${e.session_id}-${e.ts}-${i}` : `t-${e.task_id}-${e.ts}`;
            const ex = expanded.has(key);
            if (e.type === "message") {
              const text = e.content || "";
              const truncated = text.length > 140;
              const agentColor = peerColors(e.peer_id);
              return (
                <div
                  key={key}
                  className={`group rounded border-l-2 pl-3 py-2 cursor-pointer hover:bg-ink-800/30 transition ${
                    isHumanPeer(e.peer_id) ? "border-sky-500/50" : "border-emerald-500/50"
                  }`}
                  onClick={() => truncated && toggleExpand(key)}
                >
                  <div className="flex items-center gap-2 text-[10px] text-zinc-400">
                    <span className="bracket-value text-zinc-500">{relTime(e.ts)}</span>
                    <span className={`px-1.5 py-0.5 rounded font-mono border ${agentColor} text-accent-glow`}>
                      {peerLabel(e.peer_id)}
                    </span>
                    <span className="ml-auto shrink-0 text-zinc-600 font-mono tabular-nums">
                      {sessionNickname(e.session_id)}
                    </span>
                  </div>
                  <div className="mt-1 text-zinc-300 [overflow-wrap:anywhere] whitespace-pre-wrap group-hover-phosphor-text">
                    {ex ? text : text.slice(0, 140)}
                    {truncated && !ex && <span className="text-zinc-600"> …click</span>}
                  </div>
                </div>
              );
            }
            return (
              <div
                key={key}
                className="group rounded border-l-2 pl-3 py-2 border-violet-500/50 hover:bg-ink-800/30 transition"
              >
                <div className="flex items-center gap-2 text-[10px] text-zinc-400">
                  <span className="bracket-value text-zinc-500">{relTime(e.ts)}</span>
                  <span className="px-1.5 py-0.5 rounded font-mono border border-violet-500/30 bg-violet-500/10 text-emerald-300">
                    # task
                  </span>
                  <span className={`px-1.5 py-0.5 rounded font-mono border ${TASK_STATUS_COLOR[e.status] ?? "text-zinc-300 bg-zinc-500/10 border-zinc-500/30"}`}>
                    {e.status}
                  </span>
                  {e.owner_agent && (
                    <span className="text-zinc-400">→ {e.owner_agent}</span>
                  )}
                  <span className="ml-auto shrink-0 text-zinc-600 font-mono tabular-nums">
                    #{e.task_id}
                  </span>
                </div>
                <div className="mt-1 text-zinc-300 [overflow-wrap:anywhere] group-hover-phosphor-text">
                  {e.title}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
