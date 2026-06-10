import { useEffect, useState } from "react";

/**
 * "What the fleet learned" — recent Honcho conclusions grouped by day.
 * Compact Live-tab digest of the memory system actually doing its job.
 */

type Conclusion = {
  id: string;
  content: string;
  observer_id?: string;
  observed_id?: string;
  created_at?: string;
};

function dayLabel(iso?: string): string {
  if (!iso) return "undated";
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(today.getTime() - 86400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "today";
  if (same(d, yest)) return "yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function peerLabel(id?: string): string {
  if (!id) return "?";
  if (/^\d+$/.test(id)) return "Brad";
  if (id === "hermes") return "Hermes";
  if (id === "user-default-hermes-agent") return "API";
  return id;
}

export default function LearnedDigest() {
  const [items, setItems] = useState<Conclusion[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/memory/conclusions?limit=24");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (!cancelled) {
          setItems(Array.isArray(d.items) ? d.items : []);
          setError(d.error ?? null);
        }
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
  }, []);

  if (error && items.length === 0) return null; // stay quiet on the Live tab if Honcho's down
  if (items.length === 0) return null;

  const groups: { day: string; items: Conclusion[] }[] = [];
  for (const c of items) {
    const day = dayLabel(c.created_at);
    const g = groups.find((x) => x.day === day);
    if (g) g.items.push(c);
    else groups.push({ day, items: [c] });
  }

  return (
    <div className="card p-4 min-w-0">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold tracking-tight">🧠 What the fleet learned</div>
        <div className="text-[10px] text-zinc-500">Honcho conclusions · latest {items.length}</div>
      </div>
      <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1">
        {groups.map((g) => (
          <div key={g.day} className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-accent-glow/70 mb-1 font-mono">
              {g.day}
            </div>
            <ul className="space-y-1">
              {g.items.map((c) => (
                <li key={c.id} className="text-xs text-zinc-300 flex gap-2 min-w-0">
                  <span className="shrink-0 text-[9px] font-mono text-zinc-600 mt-0.5 w-14 truncate" title={`${c.observer_id} about ${c.observed_id}`}>
                    {peerLabel(c.observed_id)}
                  </span>
                  <span className="[overflow-wrap:anywhere] line-clamp-2">{c.content}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
