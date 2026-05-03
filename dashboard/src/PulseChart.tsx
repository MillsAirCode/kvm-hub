// PulseChart.tsx
import { useEffect, useMemo, useState } from "react";
import { fetchAgents, fetchAgentMetrics, type Agent, type AgentMetricsResponse } from "./agents";

const AGENT_COLORS: Record<string, string> = {
  clue: "#a78bfa",          // violet
  sarah: "#fb7185",         // rose
  claude: "#34d399",        // emerald
  claude_natalie: "#34d399", // emerald
};

function colorFor(id: string): string {
  return AGENT_COLORS[id] ?? "#6ee7b7";
}

export default function PulseChart() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [metrics, setMetrics] = useState<Record<string, AgentMetricsResponse>>({});
  const [size, setSize] = useState({ w: 720, h: 140 });

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
    const id = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [agents]);

  // Canvas size from a ResizeObserver on the wrapping div
  const wrapRef = useMemo(() => {
    return (el: HTMLDivElement | null) => {
      if (!el) return;
      const ro = new ResizeObserver((entries) => {
        const r = entries[0].contentRect;
        setSize({ w: Math.max(280, r.width), h: r.width < 600 ? 120 : 150 });
      });
      ro.observe(el);
    };
  }, []);

  // Compute per-agent SVG path (smooth area fill)
  const padX = 12;
  const padTop = 14;
  const padBottom = 22;
  const innerW = size.w - padX * 2;
  const innerH = size.h - padTop - padBottom;
  const N = 60;
  const stepX = innerW / Math.max(1, N - 1);

  // Find max bucket across all agents to normalize
  const maxBucket = useMemo(() => {
    let m = 1;
    for (const r of Object.values(metrics)) {
      for (const c of r.activity_buckets ?? []) m = Math.max(m, c);
    }
    return m;
  }, [metrics]);

  const totals = useMemo(() => {
    let total = 0;
    for (const r of Object.values(metrics)) total += (r.activity_buckets ?? []).reduce((a, b) => a + b, 0);
    return total;
  }, [metrics]);

  const buildPath = (buckets: number[]): string => {
    if (!buckets || buckets.length === 0) return "";
    const points = buckets.map((c, i) => {
      const x = padX + i * stepX;
      const y = padTop + innerH - (c / maxBucket) * innerH;
      return [x, y] as const;
    });
    let d = `M ${points[0][0]} ${padTop + innerH} L ${points[0][0]} ${points[0][1]}`;
    for (let i = 1; i < points.length; i++) {
      const [px, py] = points[i - 1];
      const [x, y] = points[i];
      // smooth quadratic curve
      const cx = (px + x) / 2;
      d += ` Q ${cx} ${py} ${x} ${y}`;
    }
    d += ` L ${points[points.length - 1][0]} ${padTop + innerH} Z`;
    return d;
  };

  return (
    <div ref={wrapRef} className="card p-4 w-full overflow-hidden font-mono">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="term-label text-emerald-300 phosphor text-sm">[ PULSE ]</div>
          <div className="text-[10px] text-zinc-500 mt-1">last 60 min · {totals} events</div>
        </div>
        <div className="flex items-center gap-3 text-[10px]">
          {agents.map((a) => (
            <span key={a.id} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: colorFor(a.id) }} />
              <span className="bracket-value text-zinc-400">{a.name}</span>
            </span>
          ))}
        </div>
      </div>
      <svg width={size.w} height={size.h} className="block max-w-full">
        {/* Grid baseline */}
        <line
          x1={padX}
          y1={padTop + innerH}
          x2={padX + innerW}
          y2={padTop + innerH}
          stroke="#3f3f46"
          strokeWidth="1"
          opacity="0.6"
        />
        {/* Per-agent areas */}
        {agents.map((a) => {
          const m = metrics[a.id];
          if (!m) return null;
          const path = buildPath(m.activity_buckets ?? []);
          if (!path) return null;
          const color = colorFor(a.id);
          return (
            <g key={a.id}>
              <path
                d={path}
                fill={color}
                fillOpacity="0.15"
                stroke={color}
                strokeWidth="1.5"
                strokeLinejoin="round"
                style={{ filter: `drop-shadow(0 0 6px ${color}66)` }}
              />
            </g>
          );
        })}
        {/* X-axis ticks */}
        {[0, 15, 30, 45, 59].map((t) => {
          const x = padX + t * stepX;
          return (
            <g key={t}>
              <line x1={x} y1={padTop + innerH} x2={x} y2={padTop + innerH + 4} stroke="#52525b" strokeWidth="1" />
              <text x={x} y={padTop + innerH + 14} textAnchor="middle" fontSize="9" fill="#71717a" fontFamily="ui-monospace, monospace">
                {t === 59 ? "now" : `-${59 - t}m`}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
