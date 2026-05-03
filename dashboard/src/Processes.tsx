import { useEffect, useState } from "react";

type Process = {
  pid: number;
  user: string;
  cpu_pct: number;
  mem_pct: number;
  rss_mb: number;
  etime: string;
  comm: string;
  args: string;
};

type Resp = {
  host: string;
  available: boolean;
  ssh_user?: string;
  processes: Process[];
};

const HOSTS: { id: string; label: string }[] = [
  { id: "natalie", label: "Natalie" },
  { id: "bradbigdesktop", label: "Clue" },
  { id: "junior", label: "Sarah" },
];

function fmtMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(0)} MB`;
}

export default function Processes() {
  const [host, setHost] = useState<string>(HOSTS[0].id);
  const [sortBy, setSortBy] = useState<"mem" | "cpu">("mem");
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmKill, setConfirmKill] = useState<number | null>(null);
  const [killing, setKilling] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const reload = async () => {
    try {
      const r = await fetch(`/api/hosts/${host}/processes?sort=${sortBy}&limit=12`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    reload();
    const id = setInterval(reload, 8_000);
    return () => clearInterval(id);
  }, [host, sortBy]);

  const handleKill = async (p: Process) => {
    if (confirmKill !== p.pid) {
      setConfirmKill(p.pid);
      setTimeout(() => setConfirmKill((c) => (c === p.pid ? null : c)), 4000);
      return;
    }
    setKilling(p.pid);
    setConfirmKill(null);
    try {
      const r = await fetch(`/api/hosts/${host}/processes/${p.pid}/kill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signal: "TERM" }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) setToast(`✓ Killed PID ${p.pid} (${p.comm})`);
      else if (r.status === 403)
        setToast(`✗ Not owned by ${data?.ssh_user ?? "ssh user"} — refused`);
      else setToast(`✗ Kill failed (rc=${d.rc ?? "?"})`);
    } catch (e) {
      setToast(`✗ Kill error: ${(e as Error).message}`);
    } finally {
      setKilling(null);
      setTimeout(reload, 800);
      setTimeout(() => setToast(null), 3500);
    }
  };

  return (
    <div className="card p-4 sm:p-5">
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <div>
          <div className="text-sm font-semibold tracking-tight">Processes</div>
          <div className="text-[10px] text-zinc-500">
            top consumers per host · TERM signal · {data?.ssh_user && `kills as ${data.ssh_user}`}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {HOSTS.map((h) => (
            <button
              key={h.id}
              onClick={() => setHost(h.id)}
              className={`text-[11px] px-2 py-1 rounded-full border transition ${
                host === h.id
                  ? "bg-accent/15 border-accent/40 text-accent-glow"
                  : "border-ink-700 text-zinc-400 hover:text-zinc-100"
              }`}
            >
              {h.label}
            </button>
          ))}
          <span className="mx-1 text-zinc-600">·</span>
          <button
            onClick={() => setSortBy("mem")}
            className={`text-[10px] px-2 py-1 rounded ${
              sortBy === "mem" ? "text-accent-glow" : "text-zinc-500 hover:text-zinc-200"
            }`}
          >
            mem
          </button>
          <button
            onClick={() => setSortBy("cpu")}
            className={`text-[10px] px-2 py-1 rounded ${
              sortBy === "cpu" ? "text-accent-glow" : "text-zinc-500 hover:text-zinc-200"
            }`}
          >
            cpu
          </button>
        </div>
      </div>

      {error && !data && (
        <div className="text-rose-300 text-xs">Fetch failed: {error}</div>
      )}

      {data && (
        <div className="overflow-x-auto -mx-2 px-2">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-zinc-500">
                <th className="text-right pb-1 px-2">PID</th>
                <th className="text-left pb-1 px-2">user</th>
                <th className="text-right pb-1 px-2">cpu</th>
                <th className="text-right pb-1 px-2">mem</th>
                <th className="text-right pb-1 px-2">rss</th>
                <th className="text-right pb-1 px-2">age</th>
                <th className="text-left pb-1 px-2">command</th>
                <th className="pb-1 px-2"></th>
              </tr>
            </thead>
            <tbody>
              {data.processes.map((p) => {
                const ownedByUs = data.ssh_user
                  ? p.user === data.ssh_user
                  : true;
                const isConfirming = confirmKill === p.pid;
                return (
                  <tr
                    key={p.pid}
                    className="border-t border-ink-700/50 hover:bg-ink-800/30"
                  >
                    <td className="text-right py-1.5 px-2 text-zinc-500">{p.pid}</td>
                    <td className="py-1.5 px-2 text-zinc-400">{p.user}</td>
                    <td className="text-right py-1.5 px-2 tabular-nums">
                      <span className={p.cpu_pct >= 50 ? "text-rose-300" : p.cpu_pct >= 10 ? "text-amber-300" : "text-zinc-300"}>
                        {p.cpu_pct.toFixed(1)}%
                      </span>
                    </td>
                    <td className="text-right py-1.5 px-2 tabular-nums">
                      <span className={p.mem_pct >= 30 ? "text-rose-300" : p.mem_pct >= 10 ? "text-amber-300" : "text-zinc-300"}>
                        {p.mem_pct.toFixed(1)}%
                      </span>
                    </td>
                    <td className="text-right py-1.5 px-2 text-zinc-400 tabular-nums">{fmtMb(p.rss_mb)}</td>
                    <td className="text-right py-1.5 px-2 text-zinc-500 tabular-nums">{p.etime}</td>
                    <td className="py-1.5 px-2 text-zinc-200 max-w-[280px] sm:max-w-[420px] truncate" title={p.args}>
                      {p.comm}
                    </td>
                    <td className="py-1.5 px-2 text-right">
                      <button
                        onClick={() => handleKill(p)}
                        disabled={!ownedByUs || killing === p.pid}
                        className={`text-[10px] px-2 py-0.5 rounded border transition ${
                          isConfirming
                            ? "bg-rose-500/20 border-rose-500/50 text-rose-200 hover:bg-rose-500/30"
                            : "border-ink-700 text-zinc-500 hover:text-zinc-100 hover:border-rose-500/40"
                        } disabled:opacity-30 disabled:hover:text-zinc-500`}
                        title={
                          ownedByUs
                            ? isConfirming
                              ? "tap again to confirm"
                              : "send SIGTERM"
                            : `not owned by ${data.ssh_user}`
                        }
                      >
                        {killing === p.pid
                          ? "…"
                          : isConfirming
                          ? "kill?"
                          : "kill"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 rounded-lg px-4 py-3 text-sm font-medium shadow-2xl bg-ink-800 border border-accent/30 text-zinc-100 z-50">
          {toast}
        </div>
      )}
    </div>
  );
}
