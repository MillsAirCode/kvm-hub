import { useEffect, useRef, useState } from "react";

type PerfData = {
  tps: number | null;
  ctxUsed: number;
  ctxMax: number;
  slotsBusy: number;
  slotsTotal: number;
  history: number[];
};

const INITIAL: PerfData = {
  tps: null,
  ctxUsed: 0,
  ctxMax: 0,
  slotsBusy: 0,
  slotsTotal: 0,
  history: [],
};

export function usePerfMeter(agentId: string, intervalMs = 2500) {
  const [data, setData] = useState<PerfData>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);
  const historyRef = useRef<number[]>([]);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    const fetchPerf = async () => {
      try {
        const res = await fetch(`/api/agents/${agentId}/perf`, { signal });
        if (!res.ok) return;
        const json = await res.json();

        const newHistory = [...historyRef.current];
        if (json.tps_recent !== null && json.tps_recent !== undefined) {
          newHistory.push(json.tps_recent);
          if (newHistory.length > 30) newHistory.shift();
        }
        historyRef.current = newHistory;

        setData({
          tps: json.tps_recent,
          ctxUsed: json.ctx_used ?? 0,
          ctxMax: json.ctx_max ?? 0,
          slotsBusy: json.slots_busy ?? 0,
          slotsTotal: json.slots_total ?? 0,
          history: newHistory,
        });
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
      }
    };

    fetchPerf();
    const id = setInterval(fetchPerf, intervalMs);
    return () => {
      clearInterval(id);
      abortRef.current?.abort();
    };
  }, [agentId, intervalMs]);

  return data;
}
