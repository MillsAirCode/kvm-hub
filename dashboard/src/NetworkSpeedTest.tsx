import { useState } from "react";

type Host = { id: string; label: string };

const HOSTS: Host[] = [
  { id: "natalie", label: "Natalie" },
  { id: "bradbigdesktop", label: "Clue (4090)" },
  { id: "junior", label: "Sarah (Junior)" },
  { id: "plex", label: "Plex box" },
];

type Result = {
  ok: boolean;
  error?: string;
  from_host?: string;
  to_host?: string;
  from_label?: string;
  to_label?: string;
  duration_actual?: number;
  throughput_mbits_per_sec?: number;
  throughput_mbytes_per_sec?: number;
  retransmits?: number;
};

export default function NetworkSpeedTest() {
  const [from, setFrom] = useState<string>("junior");
  const [to, setTo] = useState<string>("plex");
  const [duration, setDuration] = useState<number>(5);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const runTest = async () => {
    if (from === to) {
      setResult({ ok: false, error: "Source and target must differ." });
      return;
    }
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch("/api/network/iperf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_host: from, to_host: to, duration }),
      });
      const data = (await res.json()) as Result;
      setResult(data);
    } catch (e) {
      setResult({ ok: false, error: String(e) });
    } finally {
      setRunning(false);
    }
  };

  const fmtMbps = (v?: number) =>
    v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(2)} Gbit/s` : `${v.toFixed(0)} Mbit/s`;
  const fmtMBps = (v?: number) =>
    v == null ? "—" : `${v.toFixed(0)} MB/s`;

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-3">
        <svg viewBox="0 0 24 24" className="h-4 w-4 text-accent" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20v-6M6 14l6-6 6 6" />
          <circle cx="12" cy="20" r="0.5" fill="currentColor" />
        </svg>
        <h3 className="font-mono text-xs uppercase tracking-wider text-accent-glow phosphor-soft">
          Speed Test (iperf3)
        </h3>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
        <select
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          disabled={running}
          className="bg-ink-800 border border-ink-700 rounded px-2 py-1 text-zinc-200 font-mono"
          aria-label="Source host"
        >
          {HOSTS.map((h) => (
            <option key={h.id} value={h.id}>{h.label}</option>
          ))}
        </select>
        <span className="text-zinc-500">→</span>
        <select
          value={to}
          onChange={(e) => setTo(e.target.value)}
          disabled={running}
          className="bg-ink-800 border border-ink-700 rounded px-2 py-1 text-zinc-200 font-mono"
          aria-label="Target host"
        >
          {HOSTS.map((h) => (
            <option key={h.id} value={h.id}>{h.label}</option>
          ))}
        </select>
        <span className="text-zinc-500 ml-2">duration</span>
        <select
          value={duration}
          onChange={(e) => setDuration(Number(e.target.value))}
          disabled={running}
          className="bg-ink-800 border border-ink-700 rounded px-2 py-1 text-zinc-200 font-mono"
          aria-label="Test duration"
        >
          <option value={3}>3s</option>
          <option value={5}>5s</option>
          <option value={10}>10s</option>
          <option value={20}>20s</option>
        </select>
        <button
          onClick={runTest}
          disabled={running || from === to}
          className={`ml-auto px-3 py-1 rounded font-mono text-xs tracking-wider transition border ${
            running
              ? "border-amber-500/40 bg-amber-500/15 text-amber-300"
              : "border-accent/40 bg-accent/15 text-accent-glow hover:bg-accent/25"
          }`}
        >
          {running ? "running…" : "[ run test ]"}
        </button>
      </div>

      {result && !result.ok && (
        <div className="text-xs text-rose-300 font-mono bg-rose-500/10 border border-rose-500/30 rounded p-2">
          {result.error || "test failed"}
        </div>
      )}

      {result && result.ok && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div className="bg-ink-800/40 border border-ink-700 rounded p-2">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">throughput</div>
            <div className="font-mono text-base font-bold text-accent-glow phosphor">
              {fmtMbps(result.throughput_mbits_per_sec)}
            </div>
            <div className="text-[10px] text-zinc-500 font-mono">{fmtMBps(result.throughput_mbytes_per_sec)}</div>
          </div>
          <div className="bg-ink-800/40 border border-ink-700 rounded p-2">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">retransmits</div>
            <div className={`font-mono text-base font-bold ${
              (result.retransmits ?? 0) === 0 ? "text-emerald-400" :
              (result.retransmits ?? 0) < 50 ? "text-amber-300" : "text-rose-300"
            }`}>
              {result.retransmits ?? 0}
            </div>
          </div>
          <div className="bg-ink-800/40 border border-ink-700 rounded p-2">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">duration</div>
            <div className="font-mono text-base text-zinc-200">{result.duration_actual?.toFixed(2)}s</div>
          </div>
          <div className="bg-ink-800/40 border border-ink-700 rounded p-2">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">path</div>
            <div className="font-mono text-xs text-zinc-300 leading-tight">
              {result.from_label}<br />
              <span className="text-zinc-500">→</span> {result.to_label}
            </div>
          </div>
        </div>
      )}

      {!result && !running && (
        <div className="text-xs text-zinc-500 font-mono">
          Pick a source + target, click run. iperf3 ad-hoc test, ~5 sec, ephemeral server.
        </div>
      )}
    </div>
  );
}
