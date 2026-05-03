import NeuralNetMini from "./NeuralNetMini";

/**
 * AgentBadge — animated nameplate per agent.
 *
 * Embeds the NeuralNetMini firing-pattern as the canvas backdrop (color-themed
 * per agent), with a phosphor mono name + role line and a state-driven status
 * pill on top. Box-drawing corner marks in each agent's accent color frame
 * the badge. Net is "active" when the agent is thinking or responding.
 */

type AgentState = "online" | "thinking" | "responding" | "offline" | "idle";

interface AgentBadgeProps {
  agentId: string;
  name: string;
  role: string;
  state: AgentState;
}

interface VariantSpec {
  color: string;       // primary phosphor tone
  glow: string;        // bright accent (peaks)
  border: "single" | "double" | "heavy";
}

const VARIANTS: Record<string, VariantSpec> = {
  clue:           { color: "#a78bfa", glow: "#c4b5fd", border: "double" },
  sarah:          { color: "#fb7185", glow: "#fda4af", border: "heavy"  },
  claude:         { color: "#34d399", glow: "#6ee7b7", border: "single" },
  claude_natalie: { color: "#34d399", glow: "#6ee7b7", border: "single" },
};

const DEFAULT_VARIANT: VariantSpec = {
  color: "#6ee7b7", glow: "#a7f3d0", border: "single",
};

const STATE_PILL: Record<AgentState, { dot: string; label: string }> = {
  online:     { dot: "#34d399", label: "ONLINE"     },
  thinking:   { dot: "#fbbf24", label: "THINKING"   },
  responding: { dot: "#34d399", label: "RESPONDING" },
  offline:    { dot: "#71717a", label: "OFFLINE"    },
  idle:       { dot: "#6b7280", label: "IDLE"       },
};

const BORDER_CHARS: Record<VariantSpec["border"], string> = {
  single: "┌┐└┘",
  double: "╔╗╚╝",
  heavy:  "┏┓┗┛",
};

export default function AgentBadge({ agentId, name, role, state }: AgentBadgeProps) {
  const variant = VARIANTS[agentId] ?? DEFAULT_VARIANT;
  const pill = STATE_PILL[state];
  const corners = BORDER_CHARS[variant.border];
  const netActive = state === "thinking" || state === "responding";

  return (
    <div className="relative h-20 overflow-hidden border-b border-ink-800 bg-black">
      <NeuralNetMini color={variant.color} glowColor={variant.glow} active={netActive} />

      {/* Corner box-drawing marks — distinctive per agent */}
      <span className="absolute top-0.5 left-1.5 font-mono text-[11px] leading-none phosphor pointer-events-none transition-all duration-200 group-hover:drop-shadow-[0_0_4px_rgba(16,185,129,0.5)] group-hover:brightness-125" style={{ color: variant.color }}>{corners[0]}</span>
      <span className="absolute top-0.5 right-1.5 font-mono text-[11px] leading-none phosphor pointer-events-none transition-all duration-200 group-hover:drop-shadow-[0_0_4px_rgba(16,185,129,0.5)] group-hover:brightness-125" style={{ color: variant.color }}>{corners[1]}</span>
      <span className="absolute bottom-0.5 left-1.5 font-mono text-[11px] leading-none phosphor pointer-events-none transition-all duration-200 group-hover:drop-shadow-[0_0_4px_rgba(16,185,129,0.5)] group-hover:brightness-125" style={{ color: variant.color }}>{corners[2]}</span>
      <span className="absolute bottom-0.5 right-1.5 font-mono text-[11px] leading-none phosphor pointer-events-none transition-all duration-200 group-hover:drop-shadow-[0_0_4px_rgba(16,185,129,0.5)] group-hover:brightness-125" style={{ color: variant.color }}>{corners[3]}</span>

      {/* Soft fade so text reads cleanly over the canvas */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: "linear-gradient(to top, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.20) 50%, transparent 100%)",
        }}
      />

      {/* Name + role + status pill */}
      <div className="absolute inset-0 flex items-end justify-between px-3 pb-1.5 pointer-events-none">
        <div className="min-w-0 font-mono">
          <div
            className="text-sm font-bold tracking-wider truncate phosphor"
            style={{ color: variant.glow, letterSpacing: "0.08em" }}
          >
            {name.toUpperCase()}
          </div>
          <div className="text-[9px] text-zinc-400 truncate">{role}</div>
        </div>
        <div
          className="shrink-0 font-mono text-[9px] flex items-center gap-1.5 px-1.5 py-0.5 rounded border bg-ink-950/70"
          style={{ color: pill.dot, borderColor: `${pill.dot}55` }}
        >
          <span
            className="h-1.5 w-1.5 rounded-full inline-block"
            style={{
              background: pill.dot,
              boxShadow: state === "thinking" || state === "responding"
                ? `0 0 6px ${pill.dot}`
                : "none",
              animation: state === "thinking" || state === "responding"
                ? "pulse-dot 1.4s ease-in-out infinite"
                : undefined,
            }}
          />
          [{pill.label}]
        </div>
      </div>
    </div>
  );
}

