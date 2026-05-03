import { usePerfMeter } from "./usePerfMeter";

export default function PerfMeter({
  agentId,
  intervalMs = 2500,
}: {
  agentId: string;
  intervalMs?: number;
}) {
  const { tps, ctxUsed, ctxMax, slotsBusy, slotsTotal, history } = usePerfMeter(agentId, intervalMs);

  if (slotsTotal === 0 && history.length === 0 && tps === null) return null;

  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n));
  const tpsText = tps !== null ? `${tps} tok/s` : "— tok/s";
  const ctxText = ctxMax > 0 ? `ctx ${fmt(ctxUsed)}/${fmt(ctxMax)}` : "";

  const w = 80;
  const h = 16;
  const pad = 1;
  const max = Math.max(...history, 1);
  const pts =
    history.length >= 2
      ? history
          .map((v, i) => {
            const x = pad + (i / (history.length - 1)) * (w - pad * 2);
            const y = h - pad - (v / max) * (h - pad * 2);
            return `${x},${y}`;
          })
          .join(" ")
      : "";

  return (
    <div className="flex items-center gap-2 text-[10px] text-zinc-500 font-mono mt-0.5">
      {pts && (
        <svg width={w} height={h} className="overflow-visible shrink-0" aria-hidden>
          <polyline
            points={pts}
            fill="none"
            stroke="rgb(var(--accent-rgb))"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      <span className="whitespace-nowrap truncate">
        <span style={{ color: "rgb(var(--accent-rgb))" }}>{tpsText}</span>
        {ctxText && (
          <>
            <span className="mx-1.5">·</span>
            {ctxText}
          </>
        )}
        {slotsTotal > 0 && (
          <>
            <span className="mx-1.5">·</span>
            slots {slotsBusy}/{slotsTotal}
          </>
        )}
      </span>
    </div>
  );
}
