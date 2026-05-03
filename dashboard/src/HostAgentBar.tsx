import { useEffect, useState } from "react";

import { CopyableText } from "./CopyableText";

/**
 * HostAgentBar — unified Hermes-style nameplate for the agent running on a
 * given host. Replaces both the previous agent-only nameplate and the
 * host-label/uptime header. One row per host card.
 *
 * Animated text reveal: chars cycle through a random glyph palette for ~700ms
 * on mount before resolving to the final agent name. Gives the boot a "decode"
 * feel matching Hermes Agent's TUI banner.
 *
 * Renders nothing when the host has no associated agent.
 */

interface HostAgentBarProps {
  hostId: string;
  uptimeDays?: number | null;
  load1m?: number | null;
}

interface HostAgentMapping {
  agentLabel: string;
  agentModel: string;
  color: string;     // primary phosphor tone
  glow: string;      // bright accent
}

const HOST_AGENT: Record<string, HostAgentMapping> = {
  bradbigdesktop: {
    agentLabel: "CLUE",
    agentModel: "qwen3.6-27b",
    color: "#a78bfa",
    glow: "#c4b5fd",
  },
  junior: {
    agentLabel: "SARAH",
    agentModel: "qwen3.6-35b-a3b",
    color: "#fb7185",
    glow: "#fda4af",
  },
  natalie: {
    agentLabel: "CLAUDE",
    agentModel: "claude-opus-4-7",
    color: "#34d399",
    glow: "#6ee7b7",
  },
};

const DECODE_GLYPHS = "█▓▒░@#&%*+=<>?▰▱◆◇■□▣◉◌";
const DECODE_DURATION_MS = 700;
const DECODE_TICK_MS = 45;

function fmtUp(d: number | null | undefined): string {
  if (d == null) return "—";
  if (d < 1) return `${Math.round(d * 24)}h`;
  return `${d.toFixed(1)}d`;
}

/** One-shot decode animation: each char locks in at a random offset within
 *  DECODE_DURATION_MS, gradually revealing the target text. */
function useDecode(target: string): string {
  const [out, setOut] = useState(() =>
    Array.from(target, () => DECODE_GLYPHS[Math.floor(Math.random() * DECODE_GLYPHS.length)]).join(""),
  );

  useEffect(() => {
    const lockTimes = Array.from(target, () => Math.random() * DECODE_DURATION_MS);
    const start = performance.now();
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      const elapsed = performance.now() - start;
      const chars = Array.from(target, (ch, i) => {
        if (elapsed >= lockTimes[i]) return ch;
        if (ch === " ") return " ";
        return DECODE_GLYPHS[Math.floor(Math.random() * DECODE_GLYPHS.length)];
      });
      setOut(chars.join(""));
      if (elapsed < DECODE_DURATION_MS) {
        window.setTimeout(tick, DECODE_TICK_MS);
      } else {
        setOut(target);
      }
    };
    tick();
    return () => {
      cancelled = true;
    };
  }, [target]);

  return out;
}

export default function HostAgentBar({ hostId, uptimeDays, load1m }: HostAgentBarProps) {
  const mapping = HOST_AGENT[hostId];
  const decodedAgent = useDecode(mapping ? `[ ${mapping.agentLabel} ]` : "[ ??? ]");
  if (!mapping) return null;

  return (
    <div
      className="rounded-md border bg-ink-950/80 px-3 py-2 font-mono min-w-0"
      style={{ borderColor: `${mapping.color}55` }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="font-bold tracking-wider phosphor shrink-0 text-[12px]"
          style={{ color: mapping.glow, letterSpacing: "0.12em" }}
        >
          {decodedAgent}
        </span>
        <CopyableText
          value={mapping.agentModel}
          className="!min-h-0 text-[11px] truncate"
          title={`copy model alias: ${mapping.agentModel}`}
        >
          <span style={{ color: mapping.color, opacity: 0.85 }}>
            {mapping.agentModel}
          </span>
        </CopyableText>
      </div>
      <div className="mt-1 text-[10px] text-zinc-500 whitespace-nowrap">
        up {fmtUp(uptimeDays)}
        {load1m != null && <> · load {load1m.toFixed(2)}</>}
      </div>
    </div>
  );
}
