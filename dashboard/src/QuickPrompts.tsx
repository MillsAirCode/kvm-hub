import { useEffect, useState } from "react";
import { fetchAgents, sendMessageStream, type Agent } from "./agents";
import { emitWorkflow } from "./eventBus";

type QuickPrompt = {
  id: number;
  label: string;
  icon: string;
  prompt: string;
  target: string; // agent_id | "broadcast"
};

export default function QuickPrompts() {
  const [prompts, setPrompts] = useState<QuickPrompt[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [running, setRunning] = useState<Record<number, boolean>>({});
  const [editing, setEditing] = useState<QuickPrompt | "new" | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const reload = async () => {
    try {
      const r = await fetch("/api/quickprompts");
      if (r.ok) setPrompts(await r.json());
    } catch { /* ignore */ }
  };

  useEffect(() => {
    reload();
    fetchAgents().then(setAgents).catch(() => {});
  }, []);

  const fire = (qp: QuickPrompt) => {
    if (running[qp.id]) return;
    setRunning((m) => ({ ...m, [qp.id]: true }));
    const targets =
      qp.target === "broadcast"
        ? agents.filter((a) => a.can_send && !a.push_only).map((a) => a.id)
        : [qp.target];
    if (targets.length === 0) {
      setToast("No matching agent");
      setRunning((m) => ({ ...m, [qp.id]: false }));
      setTimeout(() => setToast(null), 2500);
      return;
    }
    let remaining = targets.length;
    targets.forEach((id) => {
      emitWorkflow({ type: "user_to_agent", agentId: id, text: qp.prompt, ts: performance.now() });
      sendMessageStream(
        id,
        qp.prompt,
        () => { /* deltas ignored — workflow shows the flow */ },
        () => {
          remaining -= 1;
          if (remaining <= 0) setRunning((m) => ({ ...m, [qp.id]: false }));
        },
        (err) => {
          remaining -= 1;
          if (remaining <= 0) setRunning((m) => ({ ...m, [qp.id]: false }));
          setToast(`Send failed: ${err.slice(0, 60)}`);
          setTimeout(() => setToast(null), 3000);
        },
      );
    });
    setToast(
      qp.target === "broadcast"
        ? `📡 Broadcasting to ${targets.length} agents`
        : `▸ Sent to ${qp.target}`,
    );
    setTimeout(() => setToast(null), 2500);
  };

  if (prompts.length === 0 && !editing) {
    return (
      <div className="card p-4 sm:p-5">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold tracking-tight">Quick prompts</div>
          <button
            onClick={() => setEditing("new")}
            className="text-[11px] text-zinc-400 hover:text-zinc-100"
          >
            + add one
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="card p-4 sm:p-5">
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <div>
            <div className="text-sm font-semibold tracking-tight">Quick prompts</div>
            <div className="text-[10px] text-zinc-500">one-tap presets · long-press to edit</div>
          </div>
          <button
            onClick={() => setEditing("new")}
            className="text-[11px] text-zinc-400 hover:text-zinc-100 px-2 py-1 rounded border border-ink-700 hover:border-accent/40"
          >
            + new
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {prompts.map((qp) => {
            const targetLabel =
              qp.target === "broadcast" ? "all" : agents.find((a) => a.id === qp.target)?.name ?? qp.target;
            const targetColor =
              qp.target === "broadcast"
                ? "text-emerald-300/70"
                : "text-emerald-300/70";
            return (
              <button
                key={qp.id}
                onClick={() => fire(qp)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setEditing(qp);
                }}
                disabled={running[qp.id]}
                title={qp.prompt}
                className={`group rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2.5 text-left
                            hover:border-accent/40 hover:bg-ink-900/60 transition disabled:opacity-50 min-w-0`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-base shrink-0">{qp.icon}</span>
                  <span className="text-sm font-medium text-zinc-100 truncate">{qp.label}</span>
                  {running[qp.id] && (
                    <span className="ml-auto h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                  )}
                </div>
                <div className={`mt-0.5 text-[10px] ${targetColor} font-mono uppercase tracking-wide truncate`}>
                  → {targetLabel}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {editing && (
        <PromptEditor
          initial={editing === "new" ? null : editing}
          agents={agents}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 rounded-lg px-4 py-3 text-sm font-medium shadow-2xl bg-ink-800 border border-accent/30 text-zinc-100 z-50">
          {toast}
        </div>
      )}
    </>
  );
}

export function PromptEditor({
  initial,
  agents,
  onClose,
  onSaved,
}: {
  initial: QuickPrompt | null;
  agents: Agent[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [icon, setIcon] = useState(initial?.icon ?? "⚡");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [target, setTarget] = useState(initial?.target ?? "broadcast");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!label.trim() || !prompt.trim()) {
      setError("label and prompt required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const url = initial ? `/api/quickprompts/${initial.id}` : "/api/quickprompts";
      const method = initial ? "PUT" : "POST";
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim(), icon: icon.trim() || "⚡", prompt: prompt.trim(), target }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!initial) return;
    setSaving(true);
    try {
      await fetch(`/api/quickprompts/${initial.id}`, { method: "DELETE" });
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm grid place-items-center p-4">
      <div className="card p-5 w-full max-w-lg space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold tracking-tight">
            {initial ? "Edit quick prompt" : "New quick prompt"}
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-100">✕</button>
        </div>
        <div className="grid grid-cols-[80px_1fr] gap-2">
          <input
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            placeholder="⚡"
            className="rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2 text-center text-lg"
            style={{ fontSize: "16px" }}
          />
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (e.g. Status check)"
            className="rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2 text-sm"
            style={{ fontSize: "16px" }}
          />
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="The prompt text…"
          rows={5}
          className="w-full rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2 text-sm resize-none"
          style={{ fontSize: "16px" }}
        />
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-zinc-500">Target:</span>
          <button
            onClick={() => setTarget("broadcast")}
            className={`text-[11px] px-2 py-1 rounded-full border ${
              target === "broadcast"
                ? "bg-violet-500/15 border-violet-500/40 text-violet-200"
                : "border-ink-700 text-zinc-400 hover:text-zinc-100"
            }`}
          >
            broadcast (all)
          </button>
          {agents.filter((a) => a.can_send && !a.push_only).map((a) => (
            <button
              key={a.id}
              onClick={() => setTarget(a.id)}
              className={`text-[11px] px-2 py-1 rounded-full border ${
                target === a.id
                  ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-200"
                  : "border-ink-700 text-zinc-400 hover:text-zinc-100"
              }`}
            >
              {a.name}
            </button>
          ))}
        </div>
        {error && <div className="text-xs text-rose-300">{error}</div>}
        <div className="flex items-center justify-between pt-2">
          {initial ? (
            <button
              onClick={remove}
              disabled={saving}
              className="text-[11px] text-rose-300 hover:text-rose-200"
            >
              delete
            </button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="text-[11px] text-zinc-400 px-3 py-1.5">
              cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="btn-primary disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
