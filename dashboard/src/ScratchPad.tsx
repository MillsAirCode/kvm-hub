import { useEffect, useRef, useState } from "react";

type State = {
  content: string;
  modified_ts: number;
  size: number;
};

function relTime(ts?: number): string {
  if (!ts) return "—";
  const sec = Math.round(Date.now() / 1000 - ts);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

export default function ScratchPad() {
  const [content, setContent] = useState<string | null>(null);
  const [modifiedTs, setModifiedTs] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const debounceRef = useRef<number | null>(null);

  // Initial load + polling for external edits while not editing
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/scratchpad");
        if (!r.ok) return;
        const d = (await r.json()) as State;
        if (cancelled || editing) return;
        setContent(d.content);
        setModifiedTs(d.modified_ts);
        setDraft(d.content);
      } catch { /* ignore */ }
    };
    tick();
    const id = setInterval(tick, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [editing]);

  const save = async (text: string) => {
    setSaving(true);
    try {
      const r = await fetch("/api/scratchpad", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      if (r.ok) {
        const d = await r.json();
        setModifiedTs(d.modified_ts);
        setContent(text);
        setSavedAt(Date.now());
      }
    } finally {
      setSaving(false);
    }
  };

  const onChange = (val: string) => {
    setDraft(val);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => save(val), 1000);
  };

  if (content == null) {
    return <div className="card p-4 text-xs text-zinc-500 italic">loading scratchpad…</div>;
  }

  return (
    <div data-scratchpad="1" className="card p-4">
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <div>
          <div className="text-sm font-semibold tracking-tight">Scratch</div>
          <div className="text-[10px] text-zinc-500">
            {saving
              ? "saving…"
              : savedAt && Date.now() - savedAt < 1500
              ? "saved"
              : `modified ${relTime(modifiedTs ?? undefined)}`}
          </div>
        </div>
        {!editing ? (
          <button
            onClick={() => {
              setEditing(true);
              setDraft(content);
            }}
            className="text-[11px] text-zinc-400 hover:text-zinc-100 px-2 py-1 rounded border border-ink-700 hover:border-accent/40"
          >
            ✎ edit
          </button>
        ) : (
          <button
            onClick={() => {
              if (debounceRef.current) {
                window.clearTimeout(debounceRef.current);
                debounceRef.current = null;
              }
              save(draft);
              setEditing(false);
            }}
            className="text-[11px] text-emerald-300 hover:text-emerald-200 px-2 py-1 rounded border border-emerald-500/40"
          >
            ✓ done
          </button>
        )}
      </div>
      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => onChange(e.target.value)}
          rows={12}
          className="w-full rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2 text-xs font-mono text-zinc-100 resize-y leading-relaxed"
          style={{ fontSize: "13px" }}
        />
      ) : (
        <pre className="text-xs font-mono text-zinc-300 whitespace-pre-wrap [overflow-wrap:anywhere] leading-relaxed max-h-72 overflow-y-auto">
          {content || <span className="text-zinc-600 italic">empty — tap edit</span>}
        </pre>
      )}
    </div>
  );
}
