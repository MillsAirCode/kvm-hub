export type AgentState = "idle" | "thinking" | "responding" | "unknown";

export type Agent = {
  id: string;
  name: string;
  short: string;
  role: string;
  host: string;
  model: string;
  icon: string;
  has_log: boolean;
  has_chat: boolean;
  can_send: boolean;
  push_only?: boolean;
  chat_format: "hermes" | "claude_code";
  telegram_bot_username?: string | null;
};

export type SendResult = { ok: boolean; reply?: string | null; error?: string | null };

export async function sendMessage(agentId: string, message: string): Promise<SendResult> {
  const r = await fetch(`/api/agents/${agentId}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`send HTTP ${r.status}: ${txt.slice(0, 200)}`);
  }
  return await r.json();
}

/** Stream tokens from /api/agents/{id}/stream. Calls onDelta() for each
 *  content chunk, onDone() at the end (with full text accumulated),
 *  onError() if anything fails. Caller can call abort() to cancel. */
export function sendMessageStream(
  agentId: string,
  message: string,
  onDelta: (chunk: string, full: string) => void,
  onDone: (full: string) => void,
  onError: (err: string) => void,
): { abort: () => void } {
  const ctrl = new AbortController();
  let full = "";
  (async () => {
    try {
      const r = await fetch(`/api/agents/${agentId}/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ message }),
        signal: ctrl.signal,
      });
      if (!r.ok) {
        const txt = await r.text();
        onError(`HTTP ${r.status}: ${txt.slice(0, 200)}`);
        return;
      }
      if (!r.body) {
        onError("no response body");
        return;
      }
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE: events delimited by \n\n
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const event = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 2);
          if (!event.startsWith("data:")) continue;
          const data = event.slice(5).trim();
          if (data === "[DONE-STREAM]" || data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              onError(parsed.error);
              return;
            }
            const choices = parsed.choices ?? [];
            for (const c of choices) {
              const delta = c?.delta?.content;
              if (typeof delta === "string" && delta) {
                full += delta;
                onDelta(delta, full);
              }
            }
          } catch {
            /* not all SSE lines are JSON */
          }
        }
      }
      onDone(full);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (!ctrl.signal.aborted) onError(msg);
    }
  })();
  return { abort: () => ctrl.abort() };
}

export type AgentStatusResponse = {
  id: string;
  state: AgentState;
  last_event_at: number | null;
  last_event_text: string | null;
};

export async function fetchAgents(): Promise<Agent[]> {
  const r = await fetch("/api/agents");
  if (!r.ok) throw new Error(`agents HTTP ${r.status}`);
  return await r.json();
}

export async function fetchAgentStatus(id: string): Promise<AgentStatusResponse> {
  const r = await fetch(`/api/agents/${id}/status`);
  if (!r.ok) throw new Error(`agent status HTTP ${r.status}`);
  return await r.json();
}

export type AgentMetricsResponse = {
  id: string;
  msgs_today: number;
  api_calls_today: number;
  avg_latency_s: number | null;
  tools_today: number;
  activity_buckets: number[];
};

export async function fetchAgentMetrics(id: string): Promise<AgentMetricsResponse> {
  const r = await fetch(`/api/agents/${id}/metrics`);
  if (!r.ok) throw new Error(`agent metrics HTTP ${r.status}`);
  return await r.json();
}

/** Build the WebSocket URL relative to the page (preserves host/scheme). */
export function logWsUrl(id: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws/agents/${id}/logs`;
}

/** Map common tool names to emoji for fast visual scan. Falls back to ⚙. */
const TOOL_EMOJI: Record<string, string> = {
  web_search: "🔍",
  web_extract: "🔍",
  web_crawl: "🕸️",
  browser_navigate: "🌐",
  browser_snapshot: "📸",
  browser_click: "🖱️",
  read_file: "📖",
  write_file: "✍️",
  patch: "✏️",
  terminal: "💻",
  bash: "💻",
  Bash: "💻",
  search_files: "🔎",
  todo: "✅",
  hermes_chat: "🤖",
  honcho_chat: "🧠",
  honcho_search: "🧠",
  memory: "🧠",
  skill_manage: "🎯",
  delegate_task: "📋",
  send_message_telegram: "📱",
  send_message: "📱",
  image_generation: "🎨",
  vision: "👁️",
  vulnerability_scan: "🛡️",
};

export function toolEmoji(name: string | undefined): string {
  if (!name) return "⚙";
  // Normalize: strip trailing markers like " (+2 more)"
  const clean = name.replace(/\s*\([\+\d\s\w]+\)\s*$/, "").trim();
  return TOOL_EMOJI[clean] ?? "⚙";
}

/** Phosphor color cue per tool category for workflow-graph bursts. */
export function toolColor(name: string | undefined): string {
  if (!name) return "#fbbf24";
  const n = name.toLowerCase();
  if (n.includes("bash") || n === "terminal") return "#5eead4";        // terminal teal
  if (n.includes("read") || n === "cat") return "#38bdf8";              // sky
  if (n.includes("write") || n.includes("edit") || n.includes("patch")) return "#fbbf24"; // amber
  if (n.includes("grep") || n.includes("glob") || n.includes("search_files")) return "#f0abfc"; // fuchsia
  if (n.includes("web") || n.includes("browser") || n.includes("fetch")) return "#a78bfa"; // violet
  if (n.includes("memory") || n.includes("honcho")) return "#34d399";   // emerald
  if (n.includes("telegram") || n.includes("send_message")) return "#fb7185"; // rose
  if (n.includes("task") || n.includes("todo") || n.includes("delegate")) return "#6ee7b7"; // light emerald
  return "#fbbf24"; // default amber
}
