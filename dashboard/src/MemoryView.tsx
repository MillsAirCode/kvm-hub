import { useEffect, useState, type ReactNode } from "react";
import { sessionNickname } from "./sessionName";
import { CopyableText } from "./CopyableText";
import EmptyHero from "./EmptyHero";

type Peer = {
  id: string;
  workspace_id: string;
  created_at: string;
};

type Session = {
  id: string;
  is_active: boolean;
  workspace_id: string;
  created_at: string;
};

type Message = {
  id?: string;
  peer_id?: string;
  content: string;
  created_at?: string;
  _session?: string;
};

type Overview = {
  workspace: string;
  peers: Peer[];
  peer_cards: Record<string, string>;
  sessions: Session[];
  recent_messages: Message[];
  queue_status: Record<string, unknown>;
  errors: Record<string, string>;
};

function relTime(iso?: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  const now = Date.now();
  const sec = Math.round((now - t) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

function isHumanPeer(id: string): boolean {
  // Brad's peer ID is his Telegram chat_id (numeric).
  return /^\d+$/.test(id);
}

function peerLabel(id: string): string {
  if (id === "hermes") return "AI (Hermes)";
  if (isHumanPeer(id)) return "Brad";
  if (id === "user-default-hermes-agent") return "API caller";
  if (id === "clue") return "Clue";
  if (id === "sarah") return "Sarah";
  if (id === "claude-natalie" || id === "claude_natalie") return "Claude";
  return id;
}

function peerColor(id: string): string {
  if (id === "hermes") return "text-emerald-300 bg-emerald-500/10 border-emerald-500/30";
  if (isHumanPeer(id)) return "text-sky-300 bg-sky-500/10 border-sky-500/30";
  if (id === "clue") return "text-violet-300 bg-violet-500/10 border-violet-500/30";
  if (id === "sarah") return "text-rose-300 bg-rose-500/10 border-rose-500/30";
  if (id === "claude-natalie" || id === "claude_natalie") return "text-emerald-300 bg-emerald-500/10 border-emerald-500/30";
  return "text-amber-300 bg-amber-500/10 border-amber-500/30";
}

type SearchHit = {
  id?: string;
  session_id: string;
  peer_id?: string;
  content: string;
  created_at?: string;
};

type Conclusion = {
  id: string;
  content: string;
  observer_id?: string;
  observed_id?: string;
  session_id?: string;
  created_at?: string;
};

function highlight(text: string, needle: string): ReactNode {
  if (!needle) return text;
  const lower = text.toLowerCase();
  const n = needle.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const idx = lower.indexOf(n, i);
    if (idx === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark key={key++} className="bg-accent/30 text-accent-glow rounded px-0.5">
        {text.slice(idx, idx + n.length)}
      </mark>,
    );
    i = idx + n.length;
  }
  return parts;
}

export default function MemoryView() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);

  // Search state
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Conclusions state
  const [conclusions, setConclusions] = useState<Conclusion[]>([]);
  const [conclusionsTotal, setConclusionsTotal] = useState(0);
  const [conclusionsScope, setConclusionsScope] = useState<"me" | "all">("me");
  const [conclusionsError, setConclusionsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/memory/overview");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = (await r.json()) as Overview;
        if (cancelled) return;
        setData(d);
        setLastFetch(new Date());
        setError(null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    tick();
    const id = setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Conclusions fetch — refresh every 15s, refetch when scope toggles
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const params = new URLSearchParams({ limit: "60" });
        if (conclusionsScope === "me") params.set("observed_id", "5913219338");
        const r = await fetch(`/api/memory/conclusions?${params}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = (await r.json()) as { items: Conclusion[]; total: number; error?: string };
        if (cancelled) return;
        if (d.error) {
          setConclusionsError(d.error);
        } else {
          setConclusions(d.items);
          setConclusionsTotal(d.total);
          setConclusionsError(null);
        }
      } catch (e) {
        if (!cancelled) setConclusionsError((e as Error).message);
      }
    };
    tick();
    const id = setInterval(tick, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [conclusionsScope]);

  // Debounced search
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      setActiveQuery("");
      setSearchError(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/memory/search?q=${encodeURIComponent(q)}&limit=100`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = (await r.json()) as { hits: SearchHit[]; query: string };
        if (cancelled) return;
        setHits(d.hits);
        setActiveQuery(q);
        setSearchError(null);
      } catch (e) {
        if (!cancelled) setSearchError((e as Error).message);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  if (error && !data) {
    return <div className="card p-6 text-rose-300">Honcho fetch failed: {error}</div>;
  }
  if (!data) {
    return (
      <div className="card overflow-hidden">
        <EmptyHero
          glyph="[ ]"
          tagline="honcho memory · decoding state"
          opacity={0.45}
          minHeight="min-h-[40vh]"
          loading
        />
      </div>
    );
  }

  const cardCount = Object.values(data.peer_cards).filter((c) => c && c !== '{"peer_card": null}').length;

  return (
    <div className="space-y-5">
      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Workspace" value={data.workspace} />
        <StatCard label="Peers" value={String(data.peers.length)} />
        <StatCard label="Sessions" value={String(data.sessions.length)} />
        <StatCard label="Recent messages" value={String(data.recent_messages.length)} />
      </div>

      {/* Search */}
      <div className="card p-4 sm:p-5 min-w-0">
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <div>
            <div className="text-sm font-semibold tracking-tight">Search</div>
            <div className="text-[10px] text-zinc-500">
              substring match across every stored Honcho message
            </div>
          </div>
          {hits != null && (
            <div className="text-[10px] text-zinc-500">
              {searching ? "searching…" : `${hits.length} hit${hits.length === 1 ? "" : "s"}`}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search memory…"
            className="flex-1 rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2
                       text-sm text-zinc-100 placeholder:text-zinc-600
                       focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/30"
            style={{ fontSize: "16px" }}
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="text-[11px] text-zinc-500 hover:text-zinc-300 px-2 py-1"
            >
              clear
            </button>
          )}
        </div>
        {searchError && (
          <div className="mt-2 text-xs text-rose-300">{searchError}</div>
        )}
        {hits != null && hits.length > 0 && (
          <div className="mt-3 space-y-2 max-h-[420px] overflow-y-auto pr-1">
            {hits.map((h, i) => (
              <div
                key={h.id ?? `${h.session_id}-${i}`}
                className="rounded-lg border border-ink-700 bg-ink-900/40 p-3 min-w-0"
              >
                <div className="flex items-center gap-2 text-[10px] text-zinc-500 mb-1">
                  <span className={`px-1.5 py-0.5 rounded font-mono border ${peerColor(h.peer_id ?? "")}`}>
                    {peerLabel(h.peer_id ?? "?")}
                  </span>
                  <span className="font-mono truncate text-accent-glow/80">
                    {sessionNickname(h.session_id)}
                  </span>
                  <span className="ml-auto shrink-0 font-mono">{relTime(h.created_at)}</span>
                </div>
                <div className="text-xs text-zinc-300 whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {highlight(h.content, activeQuery)}
                </div>
              </div>
            ))}
          </div>
        )}
        {hits != null && hits.length === 0 && !searching && (
          <div className="mt-3 text-xs text-zinc-600 italic">
            no matches for "{activeQuery}"
          </div>
        )}
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        {/* Peers + cards */}
        <div className="card p-5 min-w-0">
          <div className="flex items-center justify-between mb-4">
            <div className="text-sm font-semibold tracking-tight">Peers</div>
            <div className="text-[10px] text-zinc-500">
              {cardCount > 0 ? `${cardCount} with cards` : "no cards yet (dialectic off)"}
            </div>
          </div>
          <div className="space-y-3">
            {data.peers.map((p) => {
              const card = data.peer_cards[p.id];
              const hasCard = card && card !== '{"peer_card": null}';
              return (
                <div
                  key={p.id}
                  className={`rounded-lg border px-3 py-2 ${peerColor(p.id)} min-w-0`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-semibold truncate">{peerLabel(p.id)}</div>
                    <div className="text-[10px] font-mono text-zinc-500 shrink-0">
                      {relTime(p.created_at)}
                    </div>
                  </div>
                  <CopyableText
                    value={p.id}
                    className="!min-h-0 text-[10px] font-mono text-zinc-500"
                    title={`copy peer id: ${p.id}`}
                  />
                  {hasCard ? (
                    <div className="mt-2 text-xs text-zinc-300 [overflow-wrap:anywhere]">{card}</div>
                  ) : (
                    <div className="mt-1 text-[10px] text-zinc-600 italic">
                      no card yet — Honcho derives these via dialectic LLM
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Recent messages */}
        <div className="card p-5 min-w-0">
          <div className="flex items-center justify-between mb-4">
            <div className="text-sm font-semibold tracking-tight">Recent messages</div>
            <div className="text-[10px] text-zinc-500">
              {lastFetch && `refreshed ${lastFetch.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`}
            </div>
          </div>
          <div className="space-y-2 max-h-[480px] overflow-y-auto pr-1">
            {data.recent_messages.length === 0 ? (
              <div className="text-zinc-600 italic text-xs">no messages stored yet</div>
            ) : (
              data.recent_messages.map((m, i) => (
                <div key={m.id ?? i} className="text-xs min-w-0">
                  <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                    <span className={`px-1.5 py-0.5 rounded font-mono ${peerColor(m.peer_id ?? "")}`}>
                      {peerLabel(m.peer_id ?? "?")}
                    </span>
                    <span className="font-mono truncate text-accent-glow/80">
                      {sessionNickname(m._session ?? "")}
                    </span>
                    <span className="ml-auto shrink-0">{relTime(m.created_at)}</span>
                  </div>
                  <div className="mt-1 text-zinc-300 whitespace-pre-wrap [overflow-wrap:anywhere]">
                    {m.content}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Conclusions */}
      <div className="card p-5 min-w-0">
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <div>
            <div className="text-sm font-semibold tracking-tight">Conclusions</div>
            <div className="text-[10px] text-zinc-500">
              durable insights agents have written via Honcho
              {conclusionsTotal > 0 && ` · ${conclusionsTotal} total`}
            </div>
          </div>
          <div className="flex items-center gap-1">
            {(["me", "all"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setConclusionsScope(s)}
                className={`text-[10px] px-2 py-1 rounded border transition ${
                  conclusionsScope === s
                    ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-200 phosphor"
                    : "border-ink-700 text-zinc-400 hover:text-zinc-100"
                }`}
              >
                {s === "me" ? "[ about me ]" : "[ all peers ]"}
              </button>
            ))}
          </div>
        </div>
        {conclusionsError && (
          <div className="text-xs text-rose-300 mb-2">honcho: {conclusionsError}</div>
        )}
        {conclusions.length === 0 && !conclusionsError ? (
          <div className="text-xs text-zinc-600 italic">no conclusions yet</div>
        ) : (
          <div className="space-y-2 max-h-[480px] overflow-y-auto pr-1">
            {conclusions.map((c) => (
              <div
                key={c.id}
                className="rounded-lg border border-ink-700 bg-ink-900/40 p-3 min-w-0"
              >
                <div className="flex items-center gap-2 text-[10px] text-zinc-500 mb-1 flex-wrap">
                  {c.observer_id && (
                    <span
                      className={`px-1.5 py-0.5 rounded font-mono border ${peerColor(c.observer_id)}`}
                      title="observer (who wrote it)"
                    >
                      {peerLabel(c.observer_id)} →
                    </span>
                  )}
                  {c.observed_id && c.observed_id !== c.observer_id && (
                    <span
                      className={`px-1.5 py-0.5 rounded font-mono border ${peerColor(c.observed_id)}`}
                      title="observed (who it's about)"
                    >
                      {peerLabel(c.observed_id)}
                    </span>
                  )}
                  {c.session_id && (
                    <span className="font-mono truncate text-accent-glow/70">
                      {sessionNickname(c.session_id)}
                    </span>
                  )}
                  <span className="ml-auto shrink-0 font-mono">{relTime(c.created_at)}</span>
                </div>
                <div className="text-xs text-zinc-300 whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {c.content}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Sessions table */}
      <div className="card p-5 min-w-0">
        <div className="text-sm font-semibold tracking-tight mb-3">Sessions</div>
        <div className="space-y-1 text-xs">
          {data.sessions.map((s) => (
            <div key={s.id} className="flex items-center gap-3 py-1 border-b border-ink-700/50 last:border-0 min-w-0">
              <span
                className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                  s.is_active ? "bg-emerald-400" : "bg-zinc-600"
                }`}
              />
              <span className="font-medium text-accent-glow shrink-0">{sessionNickname(s.id)}</span>
              <CopyableText
                value={s.id}
                className="!min-h-0 font-mono text-zinc-500 truncate flex-1 text-[10px]"
                title={`copy session id: ${s.id}`}
              />
              <span className="text-[10px] text-zinc-500 shrink-0">{relTime(s.created_at)}</span>
            </div>
          ))}
        </div>
      </div>

      {Object.keys(data.errors).length > 0 && (
        <div className="card p-4 text-xs text-amber-300">
          Partial fetch errors: {JSON.stringify(data.errors)}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 text-xl font-semibold tracking-tight truncate">{value}</div>
    </div>
  );
}
