import { useEffect, useState } from "react";
import { Skeleton } from "./Skeleton";
import HostAgentBar from "./HostAgentBar";

type GpuProc = { pid: number; name: string; vram_mib: number };
type GpuStats = {
  available: boolean;
  name?: string | null;
  vram_used_mib?: number | null;
  vram_total_mib?: number | null;
  util_pct?: number | null;
  temp_c?: number | null;
  processes?: GpuProc[];
};

type HostStats = {
  host: string;
  label: string;
  available: boolean;
  cpu_pct?: number | null;
  ram_used_gb?: number | null;
  ram_total_gb?: number | null;
  load_1m?: number | null;
  uptime_days?: number | null;
  gpu?: GpuStats | null;
  error?: string | null;
};

const HOST_IDS = ["bradbigdesktop", "junior", "natalie"];

function fmtMb(n?: number | null): string {
  if (n == null) return "—";
  if (n >= 1024) return `${(n / 1024).toFixed(1)} GB`;
  return `${n} MB`;
}
function tempColor(c?: number | null): string {
  if (c == null) return "#71717a";
  if (c < 50) return "#34d399";
  if (c < 70) return "#fbbf24";
  return "#fb7185";
}
function pctColor(p?: number | null, soft = 60, hard = 85): string {
  if (p == null) return "#71717a";
  if (p < soft) return "#7c5cff";
  if (p < hard) return "#fbbf24";
  return "#fb7185";
}

function Bar({
  pct,
  color,
}: {
  pct: number;
  color: string;
}) {
  return (
    <div className="h-2 rounded-full bg-ink-800 overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-700"
        style={{
          width: `${Math.min(100, Math.max(0, pct))}%`,
          background: `linear-gradient(90deg, ${color}, ${color}cc)`,
          boxShadow: `0 0 8px ${color}88`,
        }}
      />
    </div>
  );
}

type Sample = {
  ts: number;
  cpu_pct: number | null;
  ram_used_gb: number | null;
  ram_total_gb: number | null;
  load_1m: number | null;
  gpu_util_pct: number | null;
  gpu_temp_c: number | null;
  vram_used_mib: number | null;
  vram_total_mib: number | null;
};

function Sparkline({
  values,
  color,
  yMin,
  yMax,
  width = 100,
  height = 28,
}: {
  values: (number | null)[];
  color: string;
  /** Hard floor of the chart's y-axis (e.g. 0 for percentages). */
  yMin: number;
  /** Hard ceiling. Required so flat traces don't wiggle dramatically. */
  yMax: number;
  width?: number;
  height?: number;
}) {
  const real = values.filter((v): v is number => v != null);
  if (real.length === 0) {
    return (
      <div className="text-[9px] text-zinc-600 italic" style={{ width, height }}>
        gathering…
      </div>
    );
  }

  const span = Math.max(0.001, yMax - yMin);
  const padTop = 2;
  const padBottom = 2;
  const usableH = height - padTop - padBottom;
  const norm = (v: number) =>
    padTop + (1 - Math.min(1, Math.max(0, (v - yMin) / span))) * usableH;

  // Right-align the trace if we have fewer samples than the chart width
  // wants — that way a young buffer stays readable on the right.
  const N = values.length;
  const stepX = N > 1 ? width / (N - 1) : 0;

  // Build the line path + a matching filled area below it.
  let line = "";
  let area = "";
  let lineStarted = false;
  let firstX: number | null = null;
  values.forEach((v, i) => {
    if (v == null) {
      lineStarted = false;
      return;
    }
    const x = i * stepX;
    const y = norm(v);
    if (!lineStarted) {
      line += `M ${x.toFixed(1)} ${y.toFixed(1)}`;
      if (area === "") area += `M ${x.toFixed(1)} ${(height - padBottom).toFixed(1)} L ${x.toFixed(1)} ${y.toFixed(1)}`;
      else area += ` M ${x.toFixed(1)} ${(height - padBottom).toFixed(1)} L ${x.toFixed(1)} ${y.toFixed(1)}`;
      if (firstX == null) firstX = x;
      lineStarted = true;
    } else {
      line += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
      area += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
    }
  });
  // close the area down to the baseline at the rightmost x
  const lastIdx = (() => {
    for (let i = values.length - 1; i >= 0; i--) {
      if (values[i] != null) return i;
    }
    return -1;
  })();
  if (lastIdx >= 0) {
    const lx = lastIdx * stepX;
    area += ` L ${lx.toFixed(1)} ${(height - padBottom).toFixed(1)} Z`;
  }
  const lastVal = lastIdx >= 0 ? (values[lastIdx] as number) : null;
  const dotX = lastIdx >= 0 ? lastIdx * stepX : 0;
  const dotY = lastVal != null ? norm(lastVal) : 0;

  // unique gradient id per render so multiple sparks can coexist with
  // their own colors. Use a hash of the color string.
  const gid = `spk-${color.replace(/[^a-z0-9]/gi, "")}`;

  return (
    <svg width={width} height={height} className="block">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* Baseline gridline at the bottom for visual anchor */}
      <line
        x1="0"
        y1={height - padBottom + 0.5}
        x2={width}
        y2={height - padBottom + 0.5}
        stroke="#3b3f57"
        strokeWidth="0.5"
        opacity="0.5"
      />
      <path d={area} fill={`url(#${gid})`} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        style={{ filter: `drop-shadow(0 0 2px ${color}aa)` }}
      />
      {lastVal != null && (
        <circle cx={dotX} cy={dotY} r="1.8" fill={color} />
      )}
    </svg>
  );
}

function MetricRow({
  label,
  value,
  spark,
  bar,
  subtle,
}: {
  label: string;
  value: React.ReactNode;
  spark: React.ReactNode;
  bar?: React.ReactNode;
  subtle?: string;
}) {
  return (
    <div className="space-y-1 min-w-0">
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500 w-10 shrink-0">
          {label}
        </span>
        <span className="shrink-0">{spark}</span>
        <span className="ml-auto font-mono text-[11px] text-zinc-300 truncate">
          {value}
        </span>
      </div>
      {bar}
      {subtle && (
        <div className="text-[10px] text-zinc-500 truncate pl-[3.25rem]">{subtle}</div>
      )}
    </div>
  );
}

function HostThumbnail({ host }: { host: string }) {
  // Seed bust with Date.now() so every page load picks up a fresh URL —
  // otherwise the browser image cache can serve a stale 200 from before a
  // server-side change (e.g. when we recently dropped placeholder images).
  const [bust, setBust] = useState(() => Date.now());
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setBust(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  // Reset visibility on bust so the next refresh gets a fresh chance to load.
  useEffect(() => {
    setHidden(false);
  }, [bust]);
  // <img> tags bypass the window.fetch monkey-patch in main.tsx, so we need to
  // pass the API key on the URL. Middleware already accepts ?api_key=… query
  // for the same reason WebSocket clients can't set headers.
  const apiKey = localStorage.getItem("kvmhub.apiKey") || "";
  const auth = apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : "";
  if (hidden) return null;
  return (
    <div className="relative -mx-4 -mt-4 mb-3 overflow-hidden border-b border-ink-800">
      <img
        src={`/api/hosts/${host}/thumbnail?b=${bust}${auth}`}
        alt=""
        className="w-full h-24 object-cover opacity-80 group-hover-phosphor-thumb"
        loading="lazy"
        onError={() => setHidden(true)}
        onLoad={(e) => {
          // Server returns a 1×1 transparent PNG when no real screenshot is
          // available (quieter than 404). Hide the block in that case.
          const img = e.currentTarget;
          if (img.naturalWidth <= 1 && img.naturalHeight <= 1) {
            setHidden(true);
          }
        }}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-ink-950/80 via-ink-950/10 to-transparent pointer-events-none" />
      <div className="absolute bottom-1 right-2 text-[9px] text-zinc-500 font-mono">
        live
      </div>
    </div>
  );
}

function HostCard({ stats, history }: { stats: HostStats; history: Sample[] }) {
  if (!stats.available) {
    return (
      <div className="card p-4 text-xs text-zinc-500 min-w-0">
        <div className="font-semibold tracking-tight text-sm text-zinc-300">{stats.label || stats.host}</div>
        <div className="mt-1 [overflow-wrap:anywhere]">{stats.error || "unavailable"}</div>
      </div>
    );
  }
  const ramPct =
    stats.ram_used_gb != null && stats.ram_total_gb
      ? (stats.ram_used_gb / stats.ram_total_gb) * 100
      : 0;
  const cpu = stats.cpu_pct ?? 0;
  const cpuColor = pctColor(cpu, 50, 80);
  const ramColor = pctColor(ramPct, 70, 90);

  const gpu = stats.gpu;
  const vramPct =
    gpu?.vram_used_mib != null && gpu?.vram_total_mib
      ? (gpu.vram_used_mib / gpu.vram_total_mib) * 100
      : 0;
  const vramColor = pctColor(vramPct, 60, 85);

  return (
    <div className="card group p-4 min-w-0 flex flex-col gap-3 overflow-hidden hover-phosphor-card">
      {/* Unified Hermes-style nameplate — animated decode reveal of agent
          name + model + host label + uptime/load. Renders nothing if the
          host has no associated agent (then the GPU pill below shows alone). */}
      <HostAgentBar
        hostId={stats.host}
        uptimeDays={stats.uptime_days}
        load1m={stats.load_1m}
      />
      {/* Live desktop thumbnail */}
      <HostThumbnail host={stats.host} />
      {/* GPU quick-glance pill (util + temp). Sits alone now that the
          host-label header has been merged into the nameplate above. */}
      {gpu?.available && (
        <div className="flex items-center justify-end gap-2 text-[10px]">
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: pctColor(gpu.util_pct, 30, 70) }} />
            <span className="font-mono text-zinc-300">{gpu.util_pct ?? "—"}%</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: tempColor(gpu.temp_c) }} />
            <span className="font-mono text-zinc-300">{gpu.temp_c ?? "—"}°C</span>
          </span>
        </div>
      )}

      {/* CPU — fixed 0–100% scale */}
      <MetricRow
        label="CPU"
        value={`${cpu.toFixed(1)}%`}
        bar={<Bar pct={cpu} color={cpuColor} />}
        spark={
          <Sparkline
            values={history.map((s) => s.cpu_pct)}
            color={cpuColor}
            yMin={0}
            yMax={100}
          />
        }
      />

      {/* RAM — % scale */}
      <MetricRow
        label="RAM"
        value={
          <>
            {stats.ram_used_gb?.toFixed(1) ?? "—"} / {stats.ram_total_gb?.toFixed(1) ?? "—"} GB{" "}
            <span className="text-zinc-500">({Math.round(ramPct)}%)</span>
          </>
        }
        bar={<Bar pct={ramPct} color={ramColor} />}
        spark={
          <Sparkline
            values={history.map((s) =>
              s.ram_used_gb != null && s.ram_total_gb
                ? (s.ram_used_gb / s.ram_total_gb) * 100
                : null,
            )}
            color={ramColor}
            yMin={0}
            yMax={100}
          />
        }
      />

      {/* VRAM */}
      {gpu?.available && (
        <MetricRow
          label="VRAM"
          value={
            <>
              {fmtMb(gpu.vram_used_mib)} / {fmtMb(gpu.vram_total_mib)}{" "}
              <span className="text-zinc-500">({Math.round(vramPct)}%)</span>
            </>
          }
          bar={<Bar pct={vramPct} color={vramColor} />}
          spark={
            <Sparkline
              values={history.map((s) =>
                s.vram_used_mib != null && s.vram_total_mib
                  ? (s.vram_used_mib / s.vram_total_mib) * 100
                  : null,
              )}
              color={vramColor}
              yMin={0}
              yMax={100}
            />
          }
          subtle={gpu.name ?? undefined}
        />
      )}

      {/* GPU utilization — fixed 0–100% scale */}
      {gpu?.available && (
        <MetricRow
          label="GPU"
          value={`${gpu.util_pct ?? 0}%`}
          spark={
            <Sparkline
              values={history.map((s) => s.gpu_util_pct)}
              color={pctColor(gpu.util_pct, 30, 70)}
              yMin={0}
              yMax={100}
            />
          }
        />
      )}

      {/* GPU temperature — fixed 20–90°C scale (typical safe/danger range) */}
      {gpu?.available && (
        <MetricRow
          label="TEMP"
          value={`${gpu.temp_c ?? 0}°C`}
          spark={
            <Sparkline
              values={history.map((s) => s.gpu_temp_c)}
              color={tempColor(gpu.temp_c)}
              yMin={20}
              yMax={90}
            />
          }
        />
      )}

      {/* GPU processes (compact) */}
      {gpu?.available && gpu.processes && gpu.processes.length > 0 && (
        <div className="space-y-0.5">
          {gpu.processes.slice(0, 3).map((p) => (
            <div
              key={p.pid}
              className="flex items-center gap-2 text-[10px] font-mono text-zinc-400 min-w-0"
            >
              <span className="text-zinc-600 shrink-0">{p.pid}</span>
              <span className="truncate flex-1">{p.name}</span>
              <span className="shrink-0 text-zinc-300">{fmtMb(p.vram_mib)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function HostStrip() {
  const [stats, setStats] = useState<HostStats[]>([]);
  const [history, setHistory] = useState<Record<string, Sample[]>>({});

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const results = await Promise.allSettled(
        HOST_IDS.map(async (h) => {
          const r = await fetch(`/api/hosts/${h}/stats`);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return (await r.json()) as HostStats;
        }),
      );
      if (cancelled) return;
      setStats(
        results.map((r, i) =>
          r.status === "fulfilled"
            ? r.value
            : {
                host: HOST_IDS[i],
                label: HOST_IDS[i],
                available: false,
                error: (r.reason as Error).message,
              },
        ),
      );
    };
    tick();
    const id = setInterval(tick, 6000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Pull history every 30s — that's the granularity of the backend ring buffer
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const results = await Promise.allSettled(
        HOST_IDS.map(async (h) => {
          const r = await fetch(`/api/hosts/${h}/history`);
          if (!r.ok) return [h, [] as Sample[]] as const;
          const d = await r.json();
          return [h, (d.samples ?? []) as Sample[]] as const;
        }),
      );
      if (cancelled) return;
      const next: Record<string, Sample[]> = {};
      for (const r of results) {
        if (r.status === "fulfilled") {
          next[r.value[0]] = r.value[1];
        }
      }
      setHistory(next);
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (stats.length === 0) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-2 w-2" rounded="rounded-full" />
            </div>
            <Skeleton className="h-2 w-full" />
            <Skeleton className="h-2 w-full" />
            <Skeleton className="h-2 w-3/4" />
            <Skeleton className="h-24 w-full" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {stats.map((s) => (
        <HostCard key={s.host} stats={s} history={history[s.host] ?? []} />
      ))}
    </div>
  );
}
