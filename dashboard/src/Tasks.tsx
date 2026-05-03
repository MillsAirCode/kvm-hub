import { useEffect, useState } from "react";
import { fetchAgents, type Agent } from "./agents";
import Schedules from "./Schedules";
import { KanbanColumnSkeleton } from "./Skeleton";
import AmbientBackground from "./AmbientBackground";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";

type Status = "pending" | "in_progress" | "completed" | "cancelled";

type Task = {
  id: number;
  title: string;
  description: string;
  owner_agent: string | null;
  status: Status;
  parent_task_id: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

type TasksSub = "active" | "schedules";

const STATUS_COLUMNS: { id: Status; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "in_progress", label: "In progress" },
  { id: "completed", label: "Completed" },
  { id: "cancelled", label: "Cancelled" },
];

const NEXT_STATUS: Record<Status, Status> = {
  pending: "in_progress",
  in_progress: "completed",
  completed: "pending",
  cancelled: "pending",
};

async function fetchTasks(): Promise<Task[]> {
  const r = await fetch("/api/tasks");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

async function createTaskApi(body: {
  title: string;
  description?: string;
  owner_agent?: string | null;
}): Promise<Task> {
  const r = await fetch("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

async function patchTaskApi(id: number, body: Partial<Task>): Promise<Task> {
  const r = await fetch(`/api/tasks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

async function deleteTaskApi(id: number): Promise<void> {
  const r = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

function relTime(iso: string): string {
  const t = new Date(iso.replace(" ", "T") + "Z").getTime();
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

function StatusPill({ status }: { status: Status }) {
  const cfg = {
    pending: { text: "PENDING", color: "text-zinc-400", bg: "bg-zinc-500/10", border: "border-zinc-500/30" },
    in_progress: { text: "ACTIVE", color: "text-amber-300", bg: "bg-amber-500/15", border: "border-amber-500/40", pulse: true },
    completed: { text: "DONE", color: "text-emerald-300", bg: "bg-emerald-500/15", border: "border-emerald-500/40" },
    cancelled: { text: "X-CANCELLED", color: "text-rose-300", bg: "bg-rose-500/15", border: "border-rose-500/30" },
  }[status];

  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider border ${cfg.bg} ${cfg.color} ${cfg.border} ${cfg.pulse ? "animate-pulse" : ""}`}>
      <span className="bracket-value phosphor-soft">{cfg.text}</span>
    </span>
  );
}

function AgentChip({ agentId }: { agentId: string | null }) {
  const cls = agentId === "clue" ? "bg-violet-500/20 text-emerald-300 border-violet-500/30"
    : agentId === "sarah" ? "bg-rose-500/20 text-rose-300 border-rose-500/30"
    : agentId === "claude_natalie" ? "bg-cyan-500/20 text-cyan-300 border-cyan-500/30"
    : "bg-zinc-700/50 text-zinc-400 border-zinc-600/50";
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono border ${cls}`}>
      <span className="bracket-value">{agentId || "UNASSIGNED"}</span>
    </span>
  );
}

function TaskCard({
  task, agents, onUpdate, onDelete, draggable = true, dragging = false
}: {
  task: Task;
  agents: Agent[];
  onUpdate: (t: Task) => void;
  onDelete: (id: number) => void;
  draggable?: boolean;
  dragging?: boolean;
}) {
  const advance = async () => {
    const t = await patchTaskApi(task.id, { status: NEXT_STATUS[task.status] });
    onUpdate(t);
  };
  const cancel = async () => {
    const t = await patchTaskApi(task.id, { status: "cancelled" });
    onUpdate(t);
  };
  const reassign = async (owner: string | null) => {
    const t = await patchTaskApi(task.id, { owner_agent: owner });
    onUpdate(t);
  };
  const remove = async () => {
    if (!confirm(`Delete "${task.title}"?`)) return;
    await deleteTaskApi(task.id);
    onDelete(task.id);
  };

  const drag = useDraggable({ id: `task-${task.id}`, disabled: !draggable });
  const dragStyle: React.CSSProperties = drag.transform
    ? { transform: `translate3d(${drag.transform.x}px, ${drag.transform.y}px, 0)` }
    : {};

  return (
    <div
      ref={drag.setNodeRef}
      style={dragStyle}
      {...drag.listeners}
      {...drag.attributes}
      className={`relative rounded border border-ink-700/80 bg-ink-900/60 p-2.5 min-w-0 group transition select-none ${
        dragging ? "opacity-30" : ""
      } ${drag.isDragging ? "ring-1 ring-emerald-400/40 shadow-[0_0_15px_rgba(52,211,153,0.15)] z-10 relative" : ""}`}
    >
      <div className="flex items-start gap-2.5 min-w-0">
        <div className="text-[10px] font-mono text-zinc-600 shrink-0 mt-0.5 select-none cursor-grab active:cursor-grabbing">⠿</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-mono text-emerald-400/70 bracket-value phosphor-soft">#{task.id}</span>
            <StatusPill status={task.status} />
          </div>
          <div className="text-sm font-mono text-zinc-100 leading-snug [overflow-wrap:anywhere] phosphor-soft">
            {task.title}
          </div>
          {task.description && (
            <div className="text-[11px] text-zinc-400 mt-1.5 leading-relaxed [overflow-wrap:anywhere] font-mono opacity-80">
              {task.description}
            </div>
          )}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2 flex-wrap" onPointerDown={(e) => e.stopPropagation()}>
        <select
          value={task.owner_agent ?? ""}
          onChange={(e) => reassign(e.target.value || null)}
          className="text-[10px] font-mono rounded px-1.5 py-0.5 border border-ink-700/80 bg-ink-950/80 text-zinc-300 cursor-pointer focus:outline-none focus:border-emerald-500/40"
        >
          <option value="">unassigned</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id} className="bg-ink-900 text-zinc-100">
              {a.name}
            </option>
          ))}
        </select>
        <AgentChip agentId={task.owner_agent} />
        <span className="text-[10px] font-mono text-zinc-500 ml-auto">{relTime(task.updated_at)}</span>
      </div>
      <div className="mt-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition font-mono" onPointerDown={(e) => e.stopPropagation()}>
        <button onClick={advance} className="text-[10px] px-2 py-1 hover:bg-zinc-800/50 rounded text-zinc-300 hover:text-emerald-300 transition">
          → {NEXT_STATUS[task.status]}
        </button>
        {task.status !== "cancelled" && task.status !== "completed" && (
          <button onClick={cancel} className="text-[10px] px-2 py-1 hover:bg-zinc-800/50 rounded text-zinc-300 hover:text-rose-300 transition">
            cancel
          </button>
        )}
        <button onClick={remove} className="text-[10px] px-2 py-1 ml-auto hover:bg-zinc-800/50 rounded text-zinc-300 hover:text-rose-400 transition">
          delete
        </button>
      </div>
    </div>
  );
}

function KanbanColumn({
  columnId, label, tasks, draggingId, agents, onUpdate, onDelete
}: {
  columnId: Status;
  label: string;
  tasks: Task[];
  draggingId: number | null;
  agents: Agent[];
  onUpdate: (t: Task) => void;
  onDelete: (id: number) => void;
}) {
  const drop = useDroppable({ id: `col-${columnId}` });
  const borderColor = columnId === "pending" ? "border-zinc-500/30"
    : columnId === "in_progress" ? "border-amber-500/40"
    : columnId === "completed" ? "border-emerald-500/40"
    : "border-rose-500/30";
  const bgColor = columnId === "pending" ? "bg-zinc-500/5"
    : columnId === "in_progress" ? "bg-amber-500/5"
    : columnId === "completed" ? "bg-emerald-500/5"
    : "bg-rose-500/5";

  return (
    <div
      ref={drop.setNodeRef}
      className={`rounded-xl border ${borderColor} ${bgColor} p-3 min-h-[140px] min-w-0 transition flex flex-col ${
        drop.isOver ? "ring-2 ring-emerald-400/60 bg-emerald-500/5" : ""
      }`}
    >
      <div className="flex items-center justify-between mb-3 font-mono">
        <div className={`text-xs font-semibold uppercase tracking-widest ${
          columnId === "in_progress" ? "text-amber-300 phosphor"
          : columnId === "completed" ? "text-emerald-300 phosphor"
          : columnId === "cancelled" ? "text-rose-300"
          : "text-zinc-400"
        }`}>
          ┌── {label} ──┐
        </div>
        <div className="text-[10px] text-zinc-500 font-mono bracket-value">{tasks.length}</div>
      </div>
      <div className="space-y-2 flex-1">
        {tasks.length === 0 ? (
          <div className="text-[11px] font-mono text-zinc-600 italic flex items-center gap-1.5">
            <span>{drop.isOver ? "drop here" : "> no tasks"}</span>
            <span className="inline-block w-1.5 h-3 bg-zinc-500 animate-pulse align-middle">▊</span>
          </div>
        ) : (
          tasks.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              agents={agents}
              onUpdate={onUpdate}
              onDelete={onDelete}
              dragging={t.id === draggingId}
            />
          ))
        )}
      </div>
    </div>
  );
}

function NewTaskForm({ agents, onCreate }: { agents: Agent[]; onCreate: (t: Task) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [owner, setOwner] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      const t = await createTaskApi({ title: title.trim(), description: description.trim(), owner_agent: owner || null });
      onCreate(t);
      setTitle(""); setDescription(""); setOwner(""); setOpen(false);
    } finally { setSubmitting(false); }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-emerald-500/40 bg-emerald-500/15 text-emerald-300 text-xs font-mono uppercase tracking-wider hover:bg-emerald-500/20 transition phosphor-soft">
        <span className="bracket-value">+ NEW</span>
      </button>
    );
  }
  return (
    <div className="rounded-xl border border-ink-700/80 bg-ink-900/60 p-4 space-y-3 font-mono">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-zinc-400 uppercase tracking-widest">[ CREATE TASK ]</span>
        <button onClick={() => setOpen(false)} className="text-xs text-zinc-500 hover:text-zinc-300">✕</button>
      </div>
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="TITLE"
        className="w-full rounded border border-ink-700/80 bg-ink-950/80 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/40 transition" />
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="DESCRIPTION (OPTIONAL)" rows={2}
        className="w-full rounded border border-ink-700/80 bg-ink-950/80 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 resize-none focus:outline-none focus:border-emerald-500/40 transition" />
      <div className="flex items-center gap-2">
        <select value={owner} onChange={(e) => setOwner(e.target.value)}
          className="flex-1 rounded border border-ink-700/80 bg-ink-950/80 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500/40">
          <option value="">UNASSIGNED</option>
          {agents.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
        </select>
        <button onClick={submit} disabled={!title.trim() || submitting}
          className="px-3 py-2 rounded border border-emerald-500/40 bg-emerald-500/15 text-emerald-300 text-xs font-mono uppercase tracking-wider disabled:opacity-40 hover:bg-emerald-500/20 transition phosphor-soft">
          {submitting ? "CREATING…" : "[ SUBMIT ]"}
        </button>
        <button onClick={() => { setOpen(false); setTitle(""); setDescription(""); setOwner(""); }}
          className="px-3 py-2 rounded border border-zinc-700/50 text-zinc-400 text-xs font-mono uppercase tracking-wider hover:bg-zinc-800/50 transition">
          [ ABORT ]
        </button>
      </div>
    </div>
  );
}

function TerminalHeader({ tasks, sub, setSub }: { tasks: Task[]; sub: TasksSub; setSub: (s: TasksSub) => void }) {
  const inFlight = tasks.filter((t) => t.status === "in_progress").length;
  return (
    <div className="flex items-center gap-1.5 flex-wrap border-b border-ink-800 pb-2 -mt-1 relative z-10">
      <span className="px-2 py-1 rounded border border-emerald-500/40 bg-emerald-500/15 text-emerald-300 text-xs font-mono uppercase tracking-widest phosphor">
        <span className="bracket-value">TASKS</span>
      </span>
      <span className="px-2 py-1 rounded border border-amber-500/30 bg-amber-500/10 text-amber-300 text-[10px] font-mono uppercase tracking-widest">
        <span className="bracket-value">{inFlight} IN-FLIGHT</span>
      </span>
      <div className="flex items-center gap-1 ml-auto">
        <button onClick={() => setSub("active")}
          className={`px-3 py-1.5 rounded-lg text-xs font-mono uppercase tracking-wider transition flex items-center gap-1.5 ${
            sub === "active" ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 phosphor-soft" : "text-zinc-400 hover:text-zinc-100 border border-transparent"
          }`}>
          <span className="bracket-value">ACTIVE</span>
        </button>
        <button onClick={() => setSub("schedules")}
          className={`px-3 py-1.5 rounded-lg text-xs font-mono uppercase tracking-wider transition flex items-center gap-1.5 ${
            sub === "schedules" ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 phosphor-soft" : "text-zinc-400 hover:text-zinc-100 border border-transparent"
          }`}>
          <span className="bracket-value">SCHEDULES</span>
        </button>
      </div>
      <span className="text-[11px] text-zinc-500 font-mono hidden sm:inline">
        {sub === "active" ? "ad-hoc kanban" : "crontab + hermes-cron + systemd-timer"}
      </span>
    </div>
  );
}

export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sub, setSub] = useState<TasksSub>("active");
  const [loading, setLoading] = useState(true);
  const [draggingId, setDraggingId] = useState<number | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const draggingTask = draggingId != null ? tasks.find((t) => t.id === draggingId) ?? null : null;

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    if (id.startsWith("task-")) setDraggingId(Number(id.slice(5)));
  };

  const onDragEnd = async (e: DragEndEvent) => {
    setDraggingId(null);
    if (!e.over) return;
    const taskId = Number(String(e.active.id).slice(5));
    const colId = String(e.over.id).slice(4) as Status;
    if (!STATUS_COLUMNS.some((c) => c.id === colId)) return;
    const t = tasks.find((x) => x.id === taskId);
    if (!t || t.status === colId) return;
    const prev = t.status;
    setTasks((arr) => arr.map((x) => (x.id === taskId ? { ...x, status: colId } : x)));
    try {
      const updated = await patchTaskApi(taskId, { status: colId });
      setTasks((arr) => arr.map((x) => (x.id === taskId ? updated : x)));
    } catch {
      setTasks((arr) => arr.map((x) => (x.id === taskId ? { ...x, status: prev } : x)));
    }
  };

  const reload = async () => {
    try {
      const [t, a] = await Promise.all([fetchTasks(), fetchAgents()]);
      setTasks(t);
      setAgents(a);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    const id = setInterval(reload, 6000);
    return () => clearInterval(id);
  }, []);

  const onUpdate = (t: Task) =>
    setTasks((arr) => arr.map((x) => (x.id === t.id ? t : x)));
  const onDelete = (id: number) => setTasks((arr) => arr.filter((x) => x.id !== id));
  const onCreate = (t: Task) => setTasks((arr) => [t, ...arr]);

  return (
    <div className="space-y-4 relative">
      <TerminalHeader tasks={tasks} sub={sub} setSub={setSub} />

      {sub === "schedules" && <Schedules />}
      {sub === "active" && (<>
        <div className="flex items-center justify-between relative z-10">
          <div>
            <div className="text-sm font-semibold tracking-tight text-zinc-100 phosphor-soft">Tasks</div>
            <div className="text-[11px] text-zinc-500 font-mono">
              shared across agents · sqlite-backed at <code className="font-mono text-emerald-400/70">~/kvm-hub/tasks.db</code>
            </div>
          </div>
          <NewTaskForm agents={agents} onCreate={onCreate} />
        </div>

        {error && <div className="rounded border border-rose-500/30 bg-rose-500/10 p-3 text-rose-300 text-xs font-mono relative z-10">Error: {error}</div>}

        {tasks.length === 0 && !loading && <AmbientBackground />}

        <DndContext
          sensors={sensors}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 relative z-10">
            {loading && tasks.length === 0
              ? STATUS_COLUMNS.map((col) => <KanbanColumnSkeleton key={col.id} rows={2} />)
              : STATUS_COLUMNS.map((col) => (
                  <KanbanColumn
                    key={col.id}
                    columnId={col.id}
                    label={col.label}
                    tasks={tasks.filter((t) => t.status === col.id)}
                    draggingId={draggingId}
                    agents={agents}
                    onUpdate={onUpdate}
                    onDelete={onDelete}
                  />
                ))}
          </div>
          <DragOverlay dropAnimation={null}>
            {draggingTask ? (
              <div className="rounded border border-emerald-400/60 bg-ink-900/90 p-2.5 shadow-[0_0_20px_rgba(52,211,153,0.25)] ring-1 ring-emerald-400/40">
                <TaskCard
                  task={draggingTask}
                  agents={agents}
                  onUpdate={() => {}}
                  onDelete={() => {}}
                  draggable={false}
                />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </>)}
    </div>
  );
}
