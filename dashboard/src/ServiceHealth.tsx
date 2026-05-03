import { useEffect, useState } from "react";

type Service = {
  id: string;
  name: string;
  host: string;
  kind: "normal" | "critical";
  type: "systemd" | "docker" | string;
  active: boolean;
  state: string;
  sub_state: string | null;
  uptime: string | null;
  log_tail: string[];
  description: string;
};

const HOST_LABEL: Record<string, string> = {
  natalie: "Natalie",
  clue: "Clue (bradBigDesktop)",
  sarah: "Sarah (Junior)",
};

function statusPill(s: Service): { label: string; cls: string } {
  if (!s.active) return { label: "DOWN", cls: "text-rose-300" };
  if (s.sub_state === "unhealthy") return { label: "?", cls: "text-amber-300" };
  return { label: "OK", cls: "text-emerald-300" };
}

export default function ServiceHealth() {
  const [services, setServices] = useState<Service[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState<Record<string, boolean>>({});
  const [openLogs, setOpenLogs] = useState<Set<string>>(new Set());
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const fetchAll = async () => {
    try {
      const r = await fetch("/api/services");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as Service[];
      setServices(d);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 15_000);
    return () => clearInterval(id);
  }, []);

  const restart = async (s: Service) => {
    if (s.kind === "critical" && confirmId !== s.id) {
      setConfirmId(s.id);
      return;
    }
    setRestarting((m) => ({ ...m, [s.id]: true }));
    setConfirmId(null);
    try {
      const r = await fetch(`/api/services/${s.id}/restart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      const d = await r.json();
      if (r.ok && d.ok) setToast(`✓ Restarted ${s.name}`);
      else setToast(`✗ Restart failed: ${d.stderr || d.detail || `rc=${d.rc}`}`);
    } catch (e) {
      setToast(`✗ Restart error: ${(e as Error).message}`);
    } finally {
      setTimeout(() => setRestarting((m) => ({ ...m, [s.id]: false })), 1500);
      setTimeout(() => fetchAll(), 1800);
      setTimeout(() => setToast(null), 4000);
    }
  };

  const toggleLogs = (id: string) =>
    setOpenLogs((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  if (error && !services) {
    return (
      <div className="p-6 text-rose-300 font-mono text-sm border border-rose-500/30 bg-ink-900/60 relative overflow-hidden">
        <span className="relative">err: service status fetch failed: {error}</span>
      </div>
    );
  }
  if (!services) {
    return (
      <div className="p-6 text-zinc-500 italic font-mono text-sm relative overflow-hidden">
        <span className="relative">loading services…</span>
      </div>
    );
  }

  const grouped: Record<string, Service[]> = {};
  for (const s of services) {
    (grouped[s.host] ??= []).push(s);
  }
  const hosts = Object.keys(grouped);

  const allUp = services.every((s) => s.active);
  const downCount = services.filter((s) => !s.active).length;

  return (
    <div className="p-4 sm:p-5 font-mono text-sm bg-ink-900/60 border border-ink-700 relative overflow-hidden">
      <div className="relative z-10">
        <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
          <div className="flex items-center gap-3">
            <span className="text-base phosphor text-emerald-300 tracking-wide">[ SERVICES ]</span>
            <span className="text-xs text-zinc-500">
              {allUp ? `${services.length}/${services.length} running` : `${services.length - downCount}/${services.length} running · ${downCount} down`}
            </span>
          </div>
          <button
            onClick={fetchAll}
            className="text-xs text-zinc-400 hover:text-zinc-100 px-2 py-1 bracket-value transition-colors"
            title="Refresh"
          >
            refresh
          </button>
        </div>

        <div className="space-y-5">
          {hosts.map((host) => (
            <div key={host}>
              <div className="term-label text-[10px] text-zinc-500 mb-2">
                {HOST_LABEL[host] ?? host}
              </div>
              <div className="space-y-1.5">
                {grouped[host].map((s) => {
                  const isCritical = s.kind === "critical";
                  const isConfirming = confirmId === s.id;
                  const pill = statusPill(s);
                  return (
                    <div
                      key={s.id}
                      className={`rounded border min-w-0 transition-all ${
                        s.active
                          ? "border-ink-700 bg-ink-900/40"
                          : "border-rose-500/30 bg-rose-500/5"
                      } ${
                        isCritical
                          ? "hover:border-emerald-400/50 hover:shadow-[0_0_12px_rgba(52,211,153,0.2)]"
                          : ""
                      }`}
                    >
                      <div className="flex items-center gap-3 px-3 py-2 min-w-0">
                        <span
                          className={`shrink-0 text-xs phosphor bracket-value ${pill.cls} w-14 text-center`}
                        >
                          {pill.label}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-zinc-100 truncate">{s.name}</span>
                            <span className="text-[10px] uppercase rounded bg-ink-800 px-1.5 py-0.5 text-zinc-500 shrink-0">
                              {s.type}
                            </span>
                            {isCritical && (
                              <span className="text-[10px] uppercase rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 px-1.5 py-0.5 shrink-0">
                                critical
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-zinc-500 truncate">
                            {s.state}
                            {s.sub_state ? ` · ${s.sub_state}` : ""}
                            {s.uptime ? ` · up ${s.uptime}` : ""}
                            {s.description ? ` · ${s.description}` : ""}
                          </div>
                        </div>
                        <button
                          onClick={() => toggleLogs(s.id)}
                          className="text-[10px] text-zinc-500 hover:text-zinc-300 px-2 py-1 shrink-0 bracket-value transition-colors"
                        >
                          {openLogs.has(s.id) ? "hide" : "logs"}
                        </button>
                        <button
                          onClick={() => restart(s)}
                          disabled={restarting[s.id]}
                          className={`text-[11px] px-2 py-1 rounded shrink-0 transition border bracket-value ${
                            isConfirming
                              ? "bg-rose-500/15 border-rose-500/40 text-rose-200 hover:bg-rose-500/25"
                              : "border-ink-700 text-zinc-400 hover:text-zinc-100 hover:border-emerald-400/40"
                          } disabled:opacity-50`}
                        >
                          {restarting[s.id]
                            ? "restarting"
                            : isConfirming
                            ? "confirm"
                            : "restart"}
                        </button>
                      </div>
                      {openLogs.has(s.id) && s.log_tail.length > 0 && (
                        <pre className="px-3 pb-2 text-[10px] text-zinc-500 leading-snug whitespace-pre-wrap [overflow-wrap:anywhere] border-t border-ink-700/60">
                          {s.log_tail.join("\n")}
                        </pre>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {toast && (
          <div className="fixed bottom-6 right-6 rounded px-4 py-3 text-sm font-medium shadow-2xl bg-ink-800 border border-emerald-400/30 text-zinc-100 phosphor-soft">
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}
