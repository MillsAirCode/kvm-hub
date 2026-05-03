import { useState, type ReactNode } from "react";
import { guacamoleUrl, type Machine, type MachineStatus } from "./machines";

const ICONS: Record<string, ReactNode> = {
  desktop: (
    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M9 20h6M12 16v4" />
    </svg>
  ),
  minipc: (
    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="9" width="18" height="10" rx="1.5" />
      <path d="M7 14h.01M11 14h.01" />
    </svg>
  ),
  server: (
    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01" />
    </svg>
  ),
  laptop: (
    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="5" width="16" height="11" rx="1.5" />
      <path d="M2 19h20" />
    </svg>
  ),
  pi: (
    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="6" width="16" height="12" rx="1" />
      <path d="M8 10h.01M12 10h.01M16 10h.01M8 14h8" />
    </svg>
  ),
  console: (
    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8h12a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3 3 3 0 0 1-2.83-2H8.83A3 3 0 0 1 6 18a3 3 0 0 1-3-3v-4a3 3 0 0 1 3-3z" />
      <path d="M8 12h2M9 11v2M15 12h.01M17 12h.01" />
    </svg>
  ),
};

const STATUS_DOT: Record<MachineStatus, string> = {
  online: "bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.7)]",
  offline: "bg-zinc-600",
  unknown: "bg-amber-400 animate-pulse",
};

const STATUS_LABEL: Record<MachineStatus, string> = {
  online: "online",
  offline: "offline",
  unknown: "checking…",
};

export default function MachineCard({
  machine,
  latency,
  onWake,
}: {
  machine: Machine;
  latency: number | null;
  onWake: (id: string) => Promise<void>;
}) {
  const status: MachineStatus = machine.status ?? "unknown";
  const url = guacamoleUrl(machine);
  const [waking, setWaking] = useState(false);

  const handleWake = async () => {
    setWaking(true);
    try {
      await onWake(machine.id);
    } finally {
      setTimeout(() => setWaking(false), 1500);
    }
  };

  return (
    <div className="card group p-5 flex flex-col gap-4 min-w-0 overflow-hidden hover-phosphor-card">
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="rounded-xl bg-ink-700/50 p-2 text-accent-glow group-hover:text-accent shrink-0">
            {ICONS[machine.icon] ?? ICONS.minipc}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold tracking-tight truncate">{machine.name}</div>
            <div className="text-xs text-zinc-400 truncate">{machine.short}</div>
          </div>
        </div>
        <span className="badge bg-ink-800/70 text-zinc-300 shrink-0 whitespace-nowrap">
          <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} />
          {STATUS_LABEL[status]}
          {status === "online" && latency != null && (
            <span className="text-zinc-500 font-mono tabular-nums">·{latency.toFixed(1)}ms</span>
          )}
        </span>
      </div>

      <p className="text-sm text-zinc-400 leading-relaxed [overflow-wrap:anywhere]">{machine.role}</p>

      <div className="flex items-center gap-2 text-xs font-mono text-zinc-500 min-w-0">
        <span className="rounded bg-ink-800 px-1.5 py-0.5 shrink-0">{machine.protocol.toUpperCase()}</span>
        <span className="truncate">{machine.hostname}</span>
      </div>

      <div className="mt-auto flex items-center justify-between pt-1">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className={`btn-primary ${status === "offline" ? "opacity-50 pointer-events-none" : ""}`}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M13 5l7 7-7 7" />
          </svg>
          Connect
        </a>
        <button className="btn-ghost" onClick={handleWake} disabled={waking}>
          {waking ? (
            <>
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 animate-spin" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" opacity="0.3" />
                <path d="M12 2 a10 10 0 0 1 10 10" strokeLinecap="round" />
              </svg>
              Sending
            </>
          ) : (
            <>
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 2 L4 14h7l-1 8 9-12h-7z" />
              </svg>
              Wake
            </>
          )}
        </button>
      </div>
    </div>
  );
}
