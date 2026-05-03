import { useEffect, useState } from "react";
import EmptyHero from "./EmptyHero";

type CronJob = {
  source: "crontab" | "hermes" | "systemd";
  host: string;
  schedule: string;
  command: string;
  description: string;
  next_run_ts: number | null;
  due_in_sec: number | null;
};

const HOST_LABEL: Record<string, string> = {
  natalie: "Natalie",
  clue: "Clue",
  sarah: "Sarah",
};

const SOURCE_BADGE: Record<string, string> = {
  crontab: "border-amber-500/40 text-amber-300 bg-amber-500/10",
  hermes: "border-emerald-500/40 text-emerald-300 bg-emerald-500/10",
  systemd: "border-sky-500/40 text-sky-300 bg-sky-500/10",
};

function fmtDueIn(s: number | null): string {
  if (s == null) return "—";
  if (s < 0) return "now";
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}

function shortenCmd(cmd: string): string {
  const trimmed = cmd.split(" >>")[0].split(" >")[0].split(" 2>")[0].trim();
  const m = trimmed.match(/(\/[^\s]+)/);
  if (m) {
    const fullPath = m[1];
    const tail = fullPath.split("/").pop() || fullPath;
    return cmd.replace(fullPath, tail).slice(0, 70);
  }
  return trimmed.slice(0, 70);
}

export default function Schedules() {
  const [jobs, setJobs] = useState<CronJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [, setNow] = useState(Date.now());

  useEffect(() => {
    const tick = async () => {
      try {
        const r = await fetch("/api/cron");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setJobs(await r.json());
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      }
    };
    tick();
    const id = setInterval(tick, 30_000);
    const tickClock = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      clearInterval(id);
      clearInterval(tickClock);
    };
  }, []);

  if (error && !jobs) {
    return (
      <div className="p-4 text-rose-300 text-sm font-mono border border-rose-500/30 bg-ink-900/60 relative overflow-hidden">
        <span className="relative">err: cron fetch failed: {error}</span>
      </div>
    );
  }
  if (!jobs) {
    return (
      <div className="p-4 text-zinc-500 italic text-xs font-mono relative overflow-hidden">
        <span className="relative">loading schedules…</span>
      </div>
    );
  }
  if (jobs.length === 0) {
    return (
      <EmptyHero
        glyph="◷"
        tagline="no schedules · sprinkler-style cadence will appear here"
        opacity={0.4}
        minHeight="min-h-[30vh]"
      />
    );
  }

  const visible = showAll ? jobs : jobs.slice(0, 6);

  const liveDue = (j: CronJob) => {
    if (j.next_run_ts == null) return j.due_in_sec;
    return j.next_run_ts - Math.floor(Date.now() / 1000);
  };

  return (
    <div className="p-4 sm:p-5 font-mono text-sm bg-ink-900/60 border border-ink-700 relative overflow-hidden">
      <div className="relative z-10">
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <div className="flex items-center gap-3">
            <span className="text-base phosphor text-emerald-300 tracking-wide">[ SCHEDULES ]</span>
            <span className="text-xs text-zinc-500">
              {jobs.length} job{jobs.length === 1 ? "" : "s"}
            </span>
          </div>
          <span className="text-[10px] text-zinc-500">
            crontab + hermes-cron + systemd-timer · sorted by next-run
          </span>
        </div>

        <div className="border border-ink-700 rounded overflow-hidden">
          {/* ASCII Header Row */}
          <div className="sticky top-0 z-20 bg-ink-900 border-b border-ink-700">
            <div className="grid grid-cols-[100px_110px_1fr_1fr_80px] gap-0 px-2 py-1.5 text-[11px] text-zinc-400 uppercase tracking-wider phosphor-soft border-b border-emerald-400/30">
              <span className="flex items-center">│ host</span>
              <span className="flex items-center">│ schedule</span>
              <span className="flex items-center">│ command</span>
              <span className="flex items-center">│ desc</span>
              <span className="flex items-center">│ due</span>
            </div>
          </div>

          {/* Data Rows */}
          <div className="divide-y divide-ink-700/60">
            {visible.map((j, i) => {
              const due = liveDue(j);
              const isImminent = due != null && due >= 0 && due < 60;
              const srcBadge = SOURCE_BADGE[j.source] ?? "border-ink-700 text-zinc-400";
              return (
                <div
                  key={`${j.host}-${j.command}-${i}`}
                  className={`px-2 py-2 transition-colors ${
                    isImminent
                      ? "bg-emerald-500/5"
                      : "hover:bg-ink-800/30"
                  }`}
                >
                  <div className="grid grid-cols-[100px_110px_1fr_1fr_80px] gap-0 items-center">
                    {/* HOST column */}
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className={`text-[9px] uppercase tracking-wider rounded px-1 py-0.5 border bracket-value ${srcBadge}`}>
                        {j.source}
                      </span>
                      <span className="text-zinc-500 text-[10px]">│</span>
                      <span className="text-zinc-400 truncate">
                        {HOST_LABEL[j.host] ?? j.host}
                      </span>
                    </div>

                    {/* SCHEDULE column */}
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="text-zinc-500 text-[10px]">│</span>
                      <span className="text-zinc-400 truncate tabular-nums">
                        {j.schedule}
                      </span>
                    </div>

                    {/* COMMAND column */}
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="text-zinc-500 text-[10px]">│</span>
                      <span className="text-zinc-300 truncate">
                        {shortenCmd(j.command)}
                      </span>
                    </div>

                    {/* DESC column */}
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="text-zinc-500 text-[10px]">│</span>
                      <span className="text-zinc-500 truncate">
                        {j.description || "—"}
                      </span>
                    </div>

                    {/* DUE column */}
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="text-zinc-500 text-[10px]">│</span>
                      <span
                        className={`ml-auto tabular-nums shrink-0 ${
                          isImminent
                            ? "text-emerald-300 phosphor"
                            : "text-zinc-400"
                        }`}
                      >
                        {fmtDueIn(due)}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {jobs.length > 6 && (
          <button
            onClick={() => setShowAll((s) => !s)}
            className="mt-3 text-xs text-zinc-400 hover:text-zinc-100 bracket-value transition-colors"
          >
            {showAll ? "show less" : `show all ${jobs.length}`}
          </button>
        )}
      </div>
    </div>
  );
}
