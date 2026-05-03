// PingMatrix.tsx
import { useEffect, useState } from "react";

type Endpoint = { id: string; label: string };
type Matrix = Record<string, Record<string, number | null>>;
type Data = {
  sources: Endpoint[];
  targets: Endpoint[];
  matrix: Matrix;
  captured_ts: number;
};

function cellColor(ms: number | null): string {
  if (ms == null) return "rgba(251,113,133,0.12)"; // rose
  if (ms < 5) return "rgba(52,211,153,0.25)";      // emerald
  if (ms < 20) return "rgba(52,211,153,0.12)";     // emerald-dim
  if (ms < 100) return "rgba(251,191,36,0.18)";    // amber
  return "rgba(251,113,133,0.22)";                 // rose
}

function cellGlow(ms: number | null): string {
  if (ms == null) return "0 0 6px rgba(251,113,133,0.4)";
  if (ms < 5) return "0 0 6px rgba(52,211,153,0.5)";
  if (ms < 20) return "0 0 4px rgba(52,211,153,0.3)";
  if (ms < 100) return "0 0 5px rgba(251,191,36,0.4)";
  return "0 0 6px rgba(251,113,133,0.5)";
}

function cellTextColor(ms: number | null): string {
  if (ms == null) return "text-rose-300";
  if (ms < 5) return "text-emerald-300";
  if (ms < 20) return "text-emerald-400/70";
  if (ms < 100) return "text-amber-300";
  return "text-rose-300";
}

function fmtMs(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1) return `${ms.toFixed(2)}`;
  if (ms < 10) return `${ms.toFixed(1)}`;
  return `${ms.toFixed(0)}`;
}

export default function PingMatrix() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchAll = async () => {
    setRefreshing(true);
    try {
      const r = await fetch("/api/network/ping");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 30_000);
    return () => clearInterval(id);
  }, []);

  if (error && !data) {
    return (
      <div className="card p-4 font-mono text-xs text-rose-300 phosphor">
        <span className="term-label">[ ERROR ]</span> ping fetch failed: {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="card p-4 font-mono text-xs text-zinc-500 italic">
        measuring fleet latencies… <span className="inline-block align-middle animate-pulse">▊</span>
      </div>
    );
  }

  return (
    <div className="card p-4 sm:p-5 font-mono">
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <div>
          <div className="term-label text-emerald-300 phosphor text-sm">[ NETWORK ]</div>
          <div className="text-[10px] text-zinc-500 mt-1">
            ping latency from row-host to column-host (ms)
          </div>
        </div>
        <button
          onClick={fetchAll}
          disabled={refreshing}
          className="text-[11px] text-zinc-400 hover:text-emerald-300 px-2 py-1 disabled:opacity-50 transition-colors"
        >
          {refreshing ? "↻ measuring…" : "↻ refresh"}
        </button>
      </div>

      <div className="overflow-x-auto -mx-2 px-2">
        <table className="w-full border-separate" style={{ borderSpacing: "4px 2px" }}>
          <thead>
            <tr>
              <th className="text-left text-[10px] term-label text-zinc-600 px-2 py-1 font-normal">
                from ↓ / to →
              </th>
              {data.targets.map((t) => (
                <th
                  key={t.id}
                  className="text-[10px] term-label text-zinc-500 py-1 px-2 text-center font-normal"
                >
                  {t.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.sources.map((src) => (
              <tr key={src.id}>
                <td className="text-[10px] term-label text-zinc-400 py-1 px-2 whitespace-nowrap border-r border-zinc-700/60">
                  {src.label}
                </td>
                {data.targets.map((t, idx) => {
                  const ms = data.matrix[src.id]?.[t.id] ?? null;
                  const isSelf = src.id === t.id;
                  return (
                    <td
                      key={t.id}
                      className={`text-center text-[11px] py-2 px-2 relative ${
                        isSelf ? "text-zinc-700" : cellTextColor(ms)
                      } ${idx < data.targets.length - 1 ? "border-r border-zinc-700/60" : ""}`}
                      style={{
                        background: isSelf ? "transparent" : cellColor(ms),
                        boxShadow: isSelf ? "none" : cellGlow(ms),
                      }}
                      title={
                        isSelf
                          ? "(self)"
                          : ms != null
                          ? `${ms.toFixed(2)} ms`
                          : "unreachable / timeout"
                      }
                    >
                      <span className="bracket-value">
                        {isSelf ? "·" : fmtMs(ms)}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-4 mt-4 text-[10px] text-zinc-500 flex-wrap font-mono">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded bg-emerald-300/60 shadow-[0_0_4px_rgba(52,211,153,0.6)]" />
          &lt;5 ms
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded bg-emerald-400/40 shadow-[0_0_3px_rgba(52,211,153,0.3)]" />
          5–20 ms
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded bg-amber-300/60 shadow-[0_0_4px_rgba(251,191,36,0.5)]" />
          20–100 ms
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded bg-rose-300/60 shadow-[0_0_4px_rgba(251,113,133,0.5)]" />
          &gt;100 ms
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded bg-zinc-700/60" />
          unreachable
        </span>
      </div>
    </div>
  );
}
