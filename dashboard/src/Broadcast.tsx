// Broadcast.tsx
import { useEffect, useRef, useState } from "react";
import { fetchAgents, sendMessageStream, type Agent } from "./agents";
import { emitWorkflow } from "./eventBus";
import { PromptEditor } from "./QuickPrompts";

type Stream = {
  agentId: string;
  text: string;
  streaming: boolean;
  error: string | null;
  startedAt: number;
  firstChunkAt: number | null;
  endedAt: number | null;
  finishOrder: number | null;
};

type QuickPrompt = {
  id: number;
  label: string;
  icon: string;
  prompt: string;
  target: string;
};

export default function Broadcast() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [text, setText] = useState("");
  const [streams, setStreams] = useState<Record<string, Stream>>({});
  const [sending, setSending] = useState(false);
  const [presets, setPresets] = useState<QuickPrompt[]>([]);
  const [editing, setEditing] = useState<QuickPrompt | "new" | null>(null);
  const aborters = useRef<Record<string, () => void>>({});

  const reloadPresets = () =>
    fetch("/api/quickprompts")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setPresets(Array.isArray(d) ? d : []))
      .catch(() => {});

  useEffect(() => {
    fetchAgents().then((all) => {
      const sendable = all.filter((a) => a.can_send);
      setAgents(sendable);
      setSelected(new Set(sendable.map((a) => a.id)));
    });
    reloadPresets();
  }, []);

  const applyPreset = (p: QuickPrompt) => {
    setText(p.prompt);
    if (p.target === "broadcast") {
      setSelected(new Set(agents.filter((a) => a.can_send && !a.push_only).map((a) => a.id)));
    } else {
      setSelected(new Set([p.target]));
    }
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = () => {
    const msg = text.trim();
    if (!msg || sending || selected.size === 0) return;
    setSending(true);

    const fresh: Record<string, Stream> = { ...streams };
    for (const id of selected) {
      fresh[id] = {
        agentId: id,
        text: "",
        streaming: true,
        error: null,
        startedAt: performance.now(),
        firstChunkAt: null,
        endedAt: null,
        finishOrder: null,
      };
    }
    setStreams(fresh);
    setText("");

    let finishedCount = 0;
    for (const a of Object.values(aborters.current)) a();
    aborters.current = {};

    let remaining = selected.size;
    const onAnyDone = () => {
      remaining -= 1;
      if (remaining <= 0) setSending(false);
    };

    selected.forEach((id) => {
      emitWorkflow({ type: "user_to_agent", agentId: id, text: msg, ts: performance.now() });
      let firstChunk = true;
      const handle = sendMessageStream(
        id,
        msg,
        (_delta, full) => {
          if (firstChunk) {
            firstChunk = false;
            const now = performance.now();
            emitWorkflow({ type: "agent_to_user", agentId: id, text: full, ts: now });
            setStreams((s) => ({
              ...s,
              [id]: { ...s[id], text: full, firstChunkAt: now },
            }));
          } else {
            setStreams((s) => ({ ...s, [id]: { ...s[id], text: full } }));
          }
        },
        (full) => {
          finishedCount += 1;
          const order = finishedCount;
          setStreams((s) => ({
            ...s,
            [id]: {
              ...s[id],
              text: full || s[id]?.text || "",
              streaming: false,
              endedAt: performance.now(),
              finishOrder: order,
            },
          }));
          onAnyDone();
        },
        (err) => {
          setStreams((s) => ({
            ...s,
            [id]: { ...s[id], streaming: false, error: err, endedAt: performance.now() },
          }));
          onAnyDone();
        },
      );
      aborters.current[id] = handle.abort;
    });
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };

  if (agents.length === 0) {
    return null;
  }

  const visibleStreams = agents.filter((a) => selected.has(a.id) || streams[a.id]);

  return (
    <div className="card hover-phosphor-card p-4 sm:p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-mono font-bold tracking-tight text-zinc-100">
            <span className="text-zinc-500">[</span>
            <span className="phosphor text-accent-glow">BROADCAST</span>
            <span className="text-zinc-500">]</span>
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500 mr-1 term-label">targets</span>
        {agents.map((a) => {
          const isSelected = selected.has(a.id);
          const pillColor = isSelected
            ? "border-accent/50 bg-accent/15 text-accent-glow"
            : "border-ink-700 text-zinc-500 hover:text-zinc-300";
          return (
            <button
              key={a.id}
              onClick={() => toggle(a.id)}
              className={`text-[11px] px-2 py-1 rounded font-mono border transition ${pillColor}`}
            >
              <span className="text-zinc-500">[</span>
              <span className={isSelected ? "" : "text-zinc-400"}>{a.name.toUpperCase()}</span>
              <span className="text-zinc-500">]</span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-1.5 mb-3 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500 mr-1 term-label">presets</span>
        {presets.map((p) => (
          <button
            key={p.id}
            onClick={() => applyPreset(p)}
            onContextMenu={(e) => {
              e.preventDefault();
              setEditing(p);
            }}
            title={`${p.prompt}\n\nright-click to edit`}
            disabled={sending}
            className="text-[11px] px-2 py-1 rounded font-mono border border-ink-700 bg-ink-900/40
                       text-zinc-300 hover:text-zinc-100 hover:border-accent/40 transition disabled:opacity-50"
          >
            <span className="mr-1">{p.icon}</span>{p.label}
          </button>
        ))}
        <button
          onClick={() => setEditing("new")}
          className="text-[11px] px-2 py-1 rounded font-mono border border-dashed border-ink-700
                     text-zinc-500 hover:text-zinc-200 hover:border-accent/40 transition"
        >
          + new
        </button>
      </div>
      {editing && (
        <PromptEditor
          initial={editing === "new" ? null : editing}
          agents={agents}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reloadPresets();
          }}
        />
      )}
      <div className="flex items-end gap-2 mb-4">
        <textarea
          name="broadcast-message"
          aria-label="Broadcast message"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={`broadcast to ${selected.size} agent${selected.size === 1 ? "" : "s"}…`}
          rows={2}
          disabled={sending}
          className="flex-1 rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2
                     font-mono text-sm text-zinc-100 placeholder:text-zinc-600 resize-none
                     focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/30"
          style={{ fontSize: "16px" }}
        />
        <button
          onClick={submit}
          disabled={sending || !text.trim() || selected.size === 0}
          className={`btn-primary disabled:opacity-40 disabled:cursor-not-allowed shrink-0 font-mono text-xs px-3 py-2 rounded border transition ${
            sending || !text.trim() || selected.size === 0
              ? "border-zinc-700 text-zinc-500 bg-zinc-900/50"
              : "border-emerald-500/50 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
          }`}
        >
          <span className="text-zinc-500">[</span>
          <span>{sending ? "SENDING" : "SEND"}</span>
          <span className="text-zinc-500">▶]</span>
        </button>
      </div>

      {visibleStreams.length > 0 ? (
        <div className={`grid gap-3 ${
          visibleStreams.length === 1 ? "" : "sm:grid-cols-2"
        }`}>
          {visibleStreams.map((a) => {
            const s = streams[a.id];
            const elapsed = s
              ? ((s.endedAt ?? performance.now()) - s.startedAt) / 1000
              : null;
            const ttft = s?.firstChunkAt != null
              ? (s.firstChunkAt - s.startedAt) / 1000
              : null;
            const charsLen = s?.text?.length ?? 0;
            const charsPerSec = s && elapsed && elapsed > 0 && charsLen > 0
              ? charsLen / elapsed
              : null;
            const isWinner = s?.finishOrder === 1 && visibleStreams.length > 1;
            return (
              <div
                key={a.id}
                className={`rounded-lg border ${
                  s?.streaming
                    ? "border-emerald-400/60"
                    : isWinner
                    ? "border-amber-400/70 shadow-[0_0_16px_rgba(251,191,36,0.25)]"
                    : s?.error
                    ? "border-rose-500/40"
                    : "border-ink-700"
                } bg-ink-900/40 p-3 min-w-0 font-mono text-xs`}
              >
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide mb-2 flex-wrap">
                  {isWinner && <span className="text-amber-300" title="First to finish">🥇</span>}
                  <span className="text-zinc-300 font-semibold">{a.name}</span>
                  <span className="font-mono text-zinc-500 truncate">{a.model}</span>
                  {s?.streaming && (
                    <span className="flex items-center gap-1 text-emerald-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      streaming
                    </span>
                  )}
                  {elapsed != null && (
                    <span className="ml-auto font-mono text-zinc-500 tabular-nums">
                      {elapsed.toFixed(1)}s
                    </span>
                  )}
                </div>
                {s && (
                  <div className="flex items-center gap-3 text-[10px] text-zinc-500 font-mono tabular-nums mb-2 flex-wrap">
                    <span title="Time to first token">
                      ttft <span className="text-zinc-300">{ttft != null ? `${ttft.toFixed(2)}s` : "—"}</span>
                    </span>
                    <span title="Characters in reply">
                      chars <span className="text-zinc-300">{charsLen}</span>
                    </span>
                    <span title="Output rate">
                      rate <span className="text-zinc-300">
                        {charsPerSec != null ? `${charsPerSec.toFixed(0)}/s` : "—"}
                      </span>
                    </span>
                    {s.finishOrder != null && (
                      <span className="text-zinc-300">
                        #{s.finishOrder}
                      </span>
                    )}
                  </div>
                )}
                {s?.error ? (
                  <div className="text-xs text-rose-300 [overflow-wrap:anywhere]">{s.error}</div>
                ) : s ? (
                  <div className="text-sm text-zinc-100 whitespace-pre-wrap [overflow-wrap:anywhere] group-hover-phosphor-text">
                    <span className="text-zinc-600">└── REPLY ──┘</span>
                    <br />
                    {s.text || (s.streaming ? <span className="italic text-zinc-500">thinking…</span> : null)}
                    {s.streaming && s.text && (
                      <span className="inline-block w-[2px] h-[1em] bg-emerald-400 ml-0.5 animate-pulse align-text-bottom" />
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-zinc-600 italic">// no messages yet · type and send</div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-zinc-600 font-mono text-xs italic">// no messages yet · type and send</div>
      )}
    </div>
  );
}
