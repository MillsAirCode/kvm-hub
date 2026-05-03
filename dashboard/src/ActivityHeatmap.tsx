import { useEffect, useState } from "react";

type Cell = { count: number; types: Record<string, number> };
type Row = { date: string; label: string; hours: Cell[] };
type Heatmap = {
  days: number;
  total_events: number;
  grid_max: number;
  rows: Row[];
};

function cellShade(count: number, max: number): string {
  if (count === 0) return "rgba(50,52,72,0.35)";
  const pct = max > 0 ? Math.min(1, count / max) : 0;
  // Violet gradient from dim → glowing
  const a = 0.18 + pct * 0.62;
  return `rgba(52,211,153,${a})`;
}

function topType(types: Record<string, number>): string {
  let best = "—";
  let bestN = 0;
  for (const [k, v] of Object.entries(types)) {
    if (v > bestN) {
      best = k;
      bestN = v;
    }
  }
  return best;
}

export default function ActivityHeatmap() {
  const [data, setData] = useState<Heatmap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(7);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/workflow/heatmap?days=${days}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (!cancelled) {
          setData(d);
          setError(null);
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
  }, [days]);

  if (error && !data) {
    return <div className="card p-4 text-rose-300 text-xs">Heatmap fetch failed: {error}</div>;
  }
  if (!data) {
    return <div className="card p-4 text-zinc-500 italic text-xs">loading heatmap…</div>;
  }

  return (
    <div className="card p-4 sm:p-5">
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <div>
          <div className="text-sm font-semibold tracking-tight">Activity heatmap</div>
          <div className="text-[10px] text-zinc-500">
            {data.total_events} workflow event{data.total_events === 1 ? "" : "s"} · last {data.days}d · max {data.grid_max}/hr
          </div>
        </div>
        <div className="flex items-center gap-1">
          {[1, 7, 14].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`text-[10px] px-2 py-1 rounded ${
                days === d
                  ? "text-accent-glow bg-accent/15 border border-accent/40"
                  : "text-zinc-500 hover:text-zinc-200 border border-transparent"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto -mx-2 px-2">
        <table className="font-mono">
          <thead>
            <tr>
              <th className="text-[9px] text-zinc-600 font-normal pr-2 sticky left-0 bg-ink-900">
                day↓ / hour→
              </th>
              {Array.from({ length: 24 }, (_, h) => (
                <th
                  key={h}
                  className="text-[9px] text-zinc-600 font-normal text-center px-0.5"
                  style={{ minWidth: 16 }}
                >
                  {h % 6 === 0 ? h : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.date}>
                <td className="text-[10px] text-zinc-400 pr-2 py-0.5 sticky left-0 bg-ink-900 whitespace-nowrap">
                  {row.label}
                </td>
                {row.hours.map((cell, h) => (
                  <td key={h} className="px-0.5 py-0.5">
                    <div
                      className="rounded-sm"
                      style={{
                        width: 14,
                        height: 14,
                        background: cellShade(cell.count, data.grid_max),
                        boxShadow:
                          cell.count > 0
                            ? `0 0 4px ${cellShade(cell.count, data.grid_max)}`
                            : "none",
                      }}
                      title={
                        cell.count === 0
                          ? `${row.label} ${h}:00 — no activity`
                          : `${row.label} ${h}:00 — ${cell.count} event${
                              cell.count === 1 ? "" : "s"
                            } (top: ${topType(cell.types)})`
                      }
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center gap-3 text-[10px] text-zinc-500">
        <span>less</span>
        {[0, 0.2, 0.4, 0.6, 0.8, 1].map((p, i) => (
          <span
            key={i}
            className="rounded-sm"
            style={{
              width: 12,
              height: 12,
              background:
                p === 0
                  ? "rgba(50,52,72,0.35)"
                  : `rgba(52,211,153,${0.18 + p * 0.62})`,
            }}
          />
        ))}
        <span>more</span>
        <span className="ml-auto">events from /api/workflow/events (kicks, replies, ssh, tools)</span>
      </div>
    </div>
  );
}
