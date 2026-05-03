import { useEffect, useState, type ReactNode } from "react";
import { MACHINES, type Machine } from "./machines";
import HostStrip from "./HostStrip";
import Toolkits from "./Toolkits";
import MachineCard from "./MachineCard";
import ServiceHealth from "./ServiceHealth";
import PingMatrix from "./PingMatrix";
import NetworkSpeedTest from "./NetworkSpeedTest";
import Processes from "./Processes";
import { FleetStrip } from "./AgentDeck";

/**
 * Fleet tab — internal sub-tabs (Hardware / Services / Network / Tools /
 * Machines) so you don't scroll through 7 stacked cards. Each sub-tab
 * has one job. State persists in URL hash so deep-links survive refresh.
 */

type Sub = "hardware" | "services" | "network" | "tools" | "machines";

const SUBS: { id: Sub; label: string; icon: ReactNode; hint: string }[] = [
  {
    id: "hardware",
    label: "Hardware",
    hint: "host stats + thumbnails + sparklines",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="12" rx="1.5" />
        <path d="M8 20h8M12 16v4" />
      </svg>
    ),
  },
  {
    id: "services",
    label: "Services",
    hint: "systemd + docker + processes",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 12h4l2-5 4 10 2-5h6" />
      </svg>
    ),
  },
  {
    id: "network",
    label: "Network",
    hint: "inter-host ping latency",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
      </svg>
    ),
  },
  {
    id: "tools",
    label: "Tools",
    hint: "per-agent toolkit matrix",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4l-6 6 2.6 2.6 6-6a4 4 0 0 0 5.4-5.4l-2.7 2.7-2.6-2.6 2.7-2.7z" />
      </svg>
    ),
  },
  {
    id: "machines",
    label: "Machines",
    hint: "Guacamole + Wake-on-LAN",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
        <rect x="6" y="6" width="12" height="12" rx="2" />
        <rect x="9" y="9" width="6" height="6" rx="1" />
      </svg>
    ),
  },
];

type StatusEntry = { id: string; status: "online" | "offline"; latency_ms: number | null };

async function fetchStatus(): Promise<Record<string, StatusEntry>> {
  const r = await fetch("/api/status");
  if (!r.ok) throw new Error(`status HTTP ${r.status}`);
  const arr: StatusEntry[] = await r.json();
  return Object.fromEntries(arr.map((e) => [e.id, e]));
}

const SUB_STORAGE_KEY = "kvm-hub.fleet-sub";

function readSavedSub(): Sub {
  try {
    const v = localStorage.getItem(SUB_STORAGE_KEY);
    if (v && SUBS.some((s) => s.id === v)) return v as Sub;
  } catch { /* noop */ }
  return "hardware";
}

export default function FleetView({
  onToast,
}: {
  onToast?: (msg: string, kind: "ok" | "err") => void;
}) {
  const [sub, setSub] = useState<Sub>(() => readSavedSub());
  const [machines, setMachines] = useState<Machine[]>(
    MACHINES.map((m) => ({ ...m, status: "unknown" })),
  );
  const [latencies, setLatencies] = useState<Record<string, number | null>>({});

  useEffect(() => {
    try { localStorage.setItem(SUB_STORAGE_KEY, sub); } catch { /* noop */ }
  }, [sub]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const map = await fetchStatus();
        if (cancelled) return;
        setMachines((arr) =>
          arr.map((m) => ({ ...m, status: map[m.id]?.status ?? "unknown" })),
        );
        setLatencies(Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.latency_ms])));
      } catch {
        /* leave as-is */
      }
    };
    poll();
    const id = setInterval(poll, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const handleWake = async (id: string) => {
    try {
      const r = await fetch(`/api/wake/${id}`, { method: "POST" });
      const data = await r.json();
      if (r.ok) onToast?.(data.message ?? "WoL packet sent", "ok");
      else onToast?.(data.detail ?? `Wake failed (${r.status})`, "err");
    } catch (e) {
      onToast?.(`Wake failed: ${(e as Error).message}`, "err");
    }
  };

  const panels: Record<Sub, ReactNode> = {
    hardware: (
      <div className="space-y-4">
        <FleetStrip />
        <HostStrip />
      </div>
    ),
    services: (
      <div className="space-y-4">
        <ServiceHealth />
        <Processes />
      </div>
    ),
    network: (
      <div className="space-y-4">
        <PingMatrix />
        <NetworkSpeedTest />
      </div>
    ),
    tools: <Toolkits />,
    machines: (
      <div className="grid gap-4 sm:gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {machines.map((m) => (
          <MachineCard
            key={m.id}
            machine={m}
            latency={latencies[m.id] ?? null}
            onWake={handleWake}
          />
        ))}
      </div>
    ),
  };

  const activeHint = SUBS.find((s) => s.id === sub)?.hint;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5 flex-wrap border-b border-ink-800 pb-2 -mt-1">
        {SUBS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSub(s.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition flex items-center gap-2 ${
              sub === s.id
                ? "bg-accent/15 text-accent-glow border border-accent/40"
                : "text-zinc-400 hover:text-zinc-100 border border-transparent"
            }`}
          >
            <span className={sub === s.id ? "text-accent-glow" : "text-zinc-500"}>
              {s.icon}
            </span>
            <span>{s.label}</span>
          </button>
        ))}
        {activeHint && (
          <span className="ml-auto text-[11px] text-zinc-500 hidden sm:inline">
            {activeHint}
          </span>
        )}
      </div>
      {panels[sub]}
    </div>
  );
}
