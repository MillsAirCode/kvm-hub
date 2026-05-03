import { useEffect, useRef, useState } from "react";
import { onWorkflow } from "./eventBus";
import { fetchAgents, type Agent } from "./agents";
import { Toast } from "./Toast";

/**
 * Tiny notification stack triggered by workflow events:
 *   - agent_to_user / agent_to_agent → soft chime + toast
 *   - agent_tool → no sound, just a faint toast (high-volume)
 *   - user_to_agent → ignored (you initiated it; you don't need a ping)
 *
 * Mute toggle persists in localStorage. PWA push notifications fire only
 * when the tab is backgrounded AND the browser has granted permission.
 *
 * Sounds are synthesized via the WebAudio API — no asset bundles, no
 * autoplay-policy headaches once the user interacts with the page.
 */

export const MUTE_KEY = "kvm-hub.notify-mute";

type Toast = {
  id: number;
  title: string;
  body: string;
  kind: "reply" | "tool" | "ssh" | "info";
  ts: number;
};

/** Map our 4 internal kinds onto the Toast component's 3 variants
 *  (success/error/info). Tool calls + ssh + ambient info all collapse into
 *  the sky info variant; agent replies become success. We don't currently
 *  emit error-kind events from the event bus — leaving the door open. */
const TOAST_KIND: Record<Toast["kind"], "success" | "error" | "info"> = {
  reply: "success",
  tool: "info",
  ssh: "info",
  info: "info",
};

let _ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (_ctx) return _ctx;
  try {
    _ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    return _ctx;
  } catch {
    return null;
  }
}

function chime(kind: Toast["kind"]) {
  const ctx = audio();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => { /* noop */ });
  const now = ctx.currentTime;
  // Different short tones per kind
  const tones: Record<Toast["kind"], { freq: number; dur: number; type: OscillatorType }> = {
    reply: { freq: 780, dur: 0.18, type: "sine" },
    tool: { freq: 520, dur: 0.10, type: "triangle" },
    ssh: { freq: 380, dur: 0.14, type: "square" },
    info: { freq: 600, dur: 0.10, type: "sine" },
  };
  const cfg = tones[kind];
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = cfg.type;
  osc.frequency.setValueAtTime(cfg.freq, now);
  // Tiny upward sweep on reply for character
  if (kind === "reply") {
    osc.frequency.exponentialRampToValueAtTime(cfg.freq * 1.4, now + cfg.dur * 0.7);
  }
  // ADSR-ish envelope, kept gentle
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.06, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + cfg.dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + cfg.dur + 0.02);
}

export default function Notifications({ muted }: { muted: boolean }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const idRef = useRef(0);

  // Dedup map: key -> ToastId
  const dedupMapRef = useRef<Map<string, number>>(new Map());
  // Track timestamps for the 3s window
  const dedupTsRef = useRef<Map<string, number>>(new Map());
  // Track dismiss timers so we can clear them on replace
  const dismissTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  // Mirror current toast list synchronously so push() can verify a dedup
  // candidate id hasn't been evicted by the 5-cap before trying to update it.
  const toastsRef = useRef<Toast[]>([]);
  // Mount guard so deferred timers don't try to update state after unmount.
  const isMountedRef = useRef(true);

  // On unmount: clear ALL pending dismiss timers + flip the mount guard.
  // Without this, a 6s auto-dismiss queued before unmount fires later and
  // calls setToasts on an unmounted component (React warning + leak).
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      for (const t of dismissTimersRef.current.values()) clearTimeout(t);
      dismissTimersRef.current.clear();
      dedupMapRef.current.clear();
      dedupTsRef.current.clear();
    };
  }, []);

  const dismiss = (id: number) => {
    // Clear timer if it hasn't fired yet
    const timer = dismissTimersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      dismissTimersRef.current.delete(id);
    }
    // Remove from dedup maps
    for (const [key, val] of dedupMapRef.current.entries()) {
      if (val === id) {
        dedupMapRef.current.delete(key);
        dedupTsRef.current.delete(key);
        break;
      }
    }
    if (!isMountedRef.current) return;
    setToasts((arr) => arr.filter((x) => x.id !== id));
  };

  useEffect(() => {
    fetchAgents().then(setAgents).catch(() => {});
  }, []);

  // Wake the audio context on the first user gesture (browsers gate audio
  // playback until then). We hook a one-shot click listener.
  useEffect(() => {
    const wake = () => {
      audio()?.resume().catch(() => { /* noop */ });
      window.removeEventListener("pointerdown", wake);
    };
    window.addEventListener("pointerdown", wake, { once: true });
    return () => window.removeEventListener("pointerdown", wake);
  }, []);

  const nameOf = (id: string | undefined): string => {
    if (!id) return "?";
    const a = agents.find((x) => x.id === id);
    return a?.name ?? id;
  };

  const push = (t: Omit<Toast, "id" | "ts">, agentId?: string) => {
    if (!isMountedRef.current) return;
    const key = `${t.kind}:${agentId || "unknown"}`;
    const existingId = dedupMapRef.current.get(key);
    const existingTs = dedupTsRef.current.get(key);
    const now = Date.now();

    // Phantom-id guard: the 5-cap may have evicted the id `dedupMapRef` points
    // at. If so, fall through to PUSH new instead of trying to update a
    // ghost. Without this, a same-key event after eviction silently no-ops
    // for the rest of the 3s dedup window.
    const existingStillAlive =
      existingId !== undefined && toastsRef.current.some((x) => x.id === existingId);

    if (existingStillAlive && existingTs !== undefined && (now - existingTs) < 3000) {
      // Within 3s window for same (kind, agentId) AND the toast is still
      // mounted -> REPLACE in place

      // Clear existing auto-dismiss timer
      const oldTimer = dismissTimersRef.current.get(existingId);
      if (oldTimer) clearTimeout(oldTimer);

      // Update toast in state
      setToasts((arr) => arr.map((x) =>
        x.id === existingId ? { ...x, ...t, ts: now } : x
      ));

      // Set new auto-dismiss timer
      const newTimer = setTimeout(() => {
        dismiss(existingId);
      }, 6000);
      dismissTimersRef.current.set(existingId, newTimer);

      // Update dedup timestamp
      dedupTsRef.current.set(key, now);
    } else {
      // Out of window OR existing was evicted -> PUSH new. If existingId
      // pointed at a ghost, prune the stale dedup entry so we don't keep
      // looking for it.
      if (existingId !== undefined && !existingStillAlive) {
        dedupMapRef.current.delete(key);
        dedupTsRef.current.delete(key);
      }

      if (!muted) chime(t.kind);

      const newId = ++idRef.current;
      const next: Toast = { ...t, id: newId, ts: now };

      setToasts((arr) => {
        const out = [...arr, next];
        if (out.length > 5) {
          // Prune dedup refs for any ids that just got evicted by slice(-5),
          // so a subsequent same-key event correctly falls through to PUSH.
          const kept = new Set(out.slice(-5).map((x) => x.id));
          for (const [k, v] of dedupMapRef.current.entries()) {
            if (!kept.has(v)) {
              dedupMapRef.current.delete(k);
              dedupTsRef.current.delete(k);
              const tm = dismissTimersRef.current.get(v);
              if (tm) {
                clearTimeout(tm);
                dismissTimersRef.current.delete(v);
              }
            }
          }
          return out.slice(-5);
        }
        return out;
      });

      const timer = setTimeout(() => {
        dismiss(newId);
      }, 6000);
      dismissTimersRef.current.set(newId, timer);

      dedupMapRef.current.set(key, newId);
      dedupTsRef.current.set(key, now);
    }

    // Browser push if backgrounded + permission granted. Pass `tag: key` and
    // `renotify: true` so the OS REPLACES the previous notification for the
    // same (kind, agentId) instead of stacking — same dedup intent at the
    // OS level so a tool-call burst doesn't spam the notification center.
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "granted" &&
      typeof document !== "undefined" &&
      document.hidden
    ) {
      try {
        // `renotify` isn't in TypeScript's NotificationOptions type yet but
        // is supported in modern browsers — required for `tag` to actually
        // replace + alert again on the same key.
        new Notification(t.title, {
          body: t.body,
          silent: muted,
          tag: key,
          renotify: true,
        } as NotificationOptions & { renotify?: boolean });
      } catch { /* noop */ }
    }
  };

  // Keep toastsRef in sync with state for the phantom-id guard above.
  useEffect(() => {
    toastsRef.current = toasts;
  }, [toasts]);

  useEffect(() => {
    const off = onWorkflow((e) => {
      if (e.type === "user_to_agent") return; // user-initiated, no toast
      if (e.type === "agent_to_user" && e.agentId) {
        push({
          kind: "reply",
          title: `${nameOf(e.agentId)} replied`,
          body: typeof e.text === "string" && e.text ? e.text.slice(0, 120) : "",
        }, e.agentId);
      } else if (e.type === "agent_to_agent" && e.fromId && e.toId) {
        push({
          kind: "info",
          title: `${nameOf(e.fromId)} → ${nameOf(e.toId)}`,
          body: typeof e.text === "string" ? e.text.slice(0, 120) : "",
        }, e.fromId);
      } else if (e.type === "agent_tool" && e.agentId) {
        push({
          kind: "tool",
          title: `${nameOf(e.agentId)}: ${e.tool || "tool"}`,
          body: "",
        }, e.agentId);
      }
    });
    return off;
  // re-bind when agents resolve so name lookup is current
  }, [agents, muted]);

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <Toast
            kind={TOAST_KIND[t.kind]}
            title={t.title}
            body={t.body}
            onClose={() => dismiss(t.id)}
            floating={false}
          />
        </div>
      ))}
    </div>
  );
}
