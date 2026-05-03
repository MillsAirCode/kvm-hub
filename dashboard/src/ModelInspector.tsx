// ModelInspector.tsx
import { useEffect, useState } from "react";

type ModelInfo = {
  available: boolean;
  reason?: string;
  agent_id?: string;
  model_alias?: string;
  model_path?: string;
  quant?: string | null;
  file_size_bytes?: number | null;
  n_ctx?: number | null;
  build?: string | null;
  is_processing?: boolean;
  n_slots?: number;
  flags?: Record<string, string | boolean>;
};

function fmtBytes(b: number | null | undefined): string {
  if (b == null) return "—";
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MB`;
  return `${b} B`;
}

function fmtCtx(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1024) return `${(n / 1024).toFixed(0)}K`;
  return String(n);
}

const FLAG_LABELS: Record<string, string> = {
  "ctx-size": "ctx",
  "n-gpu-layers": "gpu layers",
  "cache-type-k": "K cache",
  "cache-type-v": "V cache",
  "flash-attn": "flash attn",
  "mlock": "mlock",
  "n-predict": "n-predict",
  "temp": "temp",
  "top-k": "top-k",
  "top-p": "top-p",
  "min-p": "min-p",
  "n-batch": "batch",
  "n-ubatch": "ubatch",
  "parallel": "parallel",
};

export default function ModelInspector({ agentId }: { agentId: string }) {
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/agents/${agentId}/model`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (!cancelled) setInfo(d);
      } catch (e) {
        if (!cancelled) setInfo({ available: false, reason: (e as Error).message });
      }
    };
    tick();
    const id = setInterval(tick, 8_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [agentId, open]);

  return (
    <div className="font-mono text-[10px]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-zinc-500 hover:text-emerald-300 px-1 transition-colors"
      >
        {open ? "▾ [ MODEL ]" : "▸ [ MODEL ]"}
      </button>
      {open && (
        <div className="mt-2 rounded border border-ink-700 bg-ink-900/60 p-3 space-y-2">
          {!info ? (
            <div className="text-zinc-600 italic">
              loading… <span className="inline-block align-middle animate-pulse">▊</span>
            </div>
          ) : !info.available ? (
            <div className="text-rose-300 phosphor">
              <span className="term-label">[ OFFLINE ]</span> {info.reason || "unavailable"}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 flex-wrap">
                <span className="font-mono text-emerald-300 phosphor-soft text-[11px]">
                  <span className="bracket-value">{info.model_alias}</span>
                </span>
                {info.quant && (
                  <span className="rounded bg-violet-500/15 border border-violet-500/30 text-violet-200 px-1.5 py-0.5 font-mono uppercase tracking-wider text-[9px]">
                    {info.quant}
                  </span>
                )}
                <span className="font-mono text-zinc-500">
                  <span className="bracket-value">{fmtBytes(info.file_size_bytes)}</span>
                </span>
                <span className="ml-auto font-mono text-zinc-500">
                  ctx <span className="bracket-value">{fmtCtx(info.n_ctx)}</span>
                </span>
              </div>
              {info.flags && Object.keys(info.flags).length > 0 && (
                <div className="flex flex-wrap gap-2 pt-2 border-t border-ink-700/60">
                  {Object.entries(info.flags).map(([k, v]) => (
                    <span
                      key={k}
                      className="font-mono text-[9px] text-zinc-400"
                      title={k}
                    >
                      <span className="term-label text-zinc-600">{FLAG_LABELS[k] ?? k}:</span>{" "}
                      <span className="text-zinc-300 bracket-value">
                        {typeof v === "boolean" ? "✓" : v}
                      </span>
                    </span>
                  ))}
                </div>
              )}
              {info.build && (
                <div className="text-zinc-600 font-mono text-[9px] truncate flex items-center gap-2">
                  <span className="bracket-value">build {info.build}</span>
                  <span className="bracket-value">{info.n_slots} slot{info.n_slots === 1 ? "" : "s"}</span>
                  {info.is_processing && (
                    <span className="text-emerald-300 phosphor term-label">[ PROCESSING ]</span>
                  )}
                </div>
              )}
              {info.available && (
                <div className="flex items-center gap-2 mt-1">
                   <span className="text-emerald-300 phosphor term-label text-[10px]">[ OK ]</span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
