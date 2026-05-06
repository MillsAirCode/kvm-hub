import { useEffect, useState, type ReactNode } from "react";
import {
  configApi,
  type MachineConfig,
  type AgentConfig,
  type ServiceConfig,
  type SshTestResult,
} from "./useConfigApi";

// ── Sub-tab definitions ──

type Sub = "machines" | "agents" | "services" | "general";

const SUBS: { id: Sub; label: string; icon: ReactNode; hint: string }[] = [
  {
    id: "machines",
    label: "Machines",
    hint: "hosts + SSH config",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="12" rx="1.5" />
        <path d="M8 20h8M12 16v4" />
      </svg>
    ),
  },
  {
    id: "agents",
    label: "Agents",
    hint: "LLM agents + endpoints",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
      </svg>
    ),
  },
  {
    id: "services",
    label: "Services",
    hint: "systemd + docker targets",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 12h4l2-5 4 10 2-5h6" />
      </svg>
    ),
  },
  {
    id: "general",
    label: "General",
    hint: "global settings",
    icon: (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
];

// ── Reusable form field ──

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`mt-1 w-full rounded border border-zinc-700/60 bg-ink-900 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-accent-glow/60 ${mono ? "font-mono text-xs" : ""}`}
      />
    </label>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded border border-zinc-700/60 bg-ink-900 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-accent-glow/60"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

// ── Machine form ──

const EMPTY_MACHINE: MachineConfig = {
  id: "", name: "", icon: "desktop", role: "", protocol: "ssh",
  hostname: "", lan_ip: "", mac: "", username: "", key_file: "",
};

function MachineForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: MachineConfig;
  onSave: (m: MachineConfig) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<MachineConfig>(initial ?? { ...EMPTY_MACHINE });
  const [sshTest, setSshTest] = useState<SshTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof MachineConfig, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const testSsh = async () => {
    setTesting(true);
    setSshTest(null);
    try {
      const r = await configApi.testSsh({
        hostname: form.hostname, username: form.username, key_file: form.key_file,
      });
      setSshTest(r);
    } catch (e) {
      setSshTest({ ok: false, error: (e as Error).message, latency_ms: 0 });
    }
    setTesting(false);
  };

  const save = async () => {
    setSaving(true);
    try { await onSave(form); } finally { setSaving(false); }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="ID" value={form.id} onChange={(v) => set("id", v)} placeholder="my-server" mono />
        <Field label="Name" value={form.name} onChange={(v) => set("name", v)} placeholder="My Server" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Select label="Icon" value={form.icon} onChange={(v) => set("icon", v)}
          options={[
            { value: "desktop", label: "Desktop" }, { value: "minipc", label: "Mini PC" },
            { value: "server", label: "Server" }, { value: "laptop", label: "Laptop" },
            { value: "pi", label: "Raspberry Pi" }, { value: "retro", label: "Retro" },
          ]}
        />
        <Field label="Protocol" value={form.protocol} onChange={(v) => set("protocol", v)} />
      </div>
      <Field label="Role / Description" value={form.role} onChange={(v) => set("role", v)} placeholder="What this machine does" />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Hostname / IP" value={form.hostname} onChange={(v) => set("hostname", v)} placeholder="10.0.0.100" mono />
        <Field label="LAN IP" value={form.lan_ip} onChange={(v) => set("lan_ip", v)} placeholder="10.0.0.100" mono />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="MAC Address" value={form.mac} onChange={(v) => set("mac", v)} placeholder="aa:bb:cc:dd:ee:ff" mono />
        <Field label="Username" value={form.username} onChange={(v) => set("username", v)} placeholder="brad" mono />
      </div>
      <Field label="SSH Key File" value={form.key_file} onChange={(v) => set("key_file", v)} placeholder="/home/user/.ssh/id_ed25519" mono />

      <div className="flex items-center gap-3 pt-2">
        <button onClick={testSsh} disabled={testing || !form.hostname || !form.username}
          className="rounded border border-zinc-600 px-3 py-1 text-xs text-zinc-300 hover:border-accent-glow/60 hover:text-accent-glow disabled:opacity-40">
          {testing ? "Testing..." : "Test SSH"}
        </button>
        {sshTest && (
          <span className={`text-xs ${sshTest.ok ? "text-emerald-400" : "text-red-400"}`}>
            {sshTest.ok ? `Connected (${sshTest.latency_ms}ms)` : sshTest.error}
          </span>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-zinc-800 pt-3">
        <button onClick={onCancel} className="rounded px-4 py-1.5 text-xs text-zinc-400 hover:text-zinc-200">Cancel</button>
        <button onClick={save} disabled={saving || !form.id || !form.name}
          className="rounded bg-accent-glow/20 px-4 py-1.5 text-xs text-accent-glow hover:bg-accent-glow/30 disabled:opacity-40">
          {saving ? "Saving..." : initial ? "Update" : "Add Machine"}
        </button>
      </div>
    </div>
  );
}

// ── Agent form ──

const EMPTY_AGENT: AgentConfig = {
  id: "", name: "", short: "", role: "", host: "", user: "", key_file: "",
  log_path: "", sessions_glob: "", model: "", icon: "brain",
  api_server_url: "", llama_url: "", llama_unit: "",
  telegram_bot_token_env: "", telegram_chat_id: "",
};

function AgentForm({
  initial,
  machines,
  onSave,
  onCancel,
}: {
  initial?: AgentConfig;
  machines: MachineConfig[];
  onSave: (a: AgentConfig) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<AgentConfig>(initial ?? { ...EMPTY_AGENT });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof AgentConfig, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    try { await onSave(form); } finally { setSaving(false); }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="ID" value={form.id} onChange={(v) => set("id", v)} placeholder="my-agent" mono />
        <Field label="Name" value={form.name} onChange={(v) => set("name", v)} placeholder="Agent Name" />
      </div>
      <Field label="Role" value={form.role} onChange={(v) => set("role", v)} placeholder="What this agent does" />
      <div className="grid grid-cols-2 gap-3">
        <Select label="Host Machine" value={form.host} onChange={(v) => set("host", v)}
          options={[{ value: "", label: "Select..." }, ...machines.map((m) => ({ value: m.hostname, label: m.name }))]}
        />
        <Field label="SSH User" value={form.user} onChange={(v) => set("user", v)} placeholder="brad" mono />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="SSH Key File" value={form.key_file} onChange={(v) => set("key_file", v)} mono />
        <Field label="Model" value={form.model} onChange={(v) => set("model", v)} placeholder="qwen3.6-27b" mono />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Hermes API URL" value={form.api_server_url} onChange={(v) => set("api_server_url", v)} placeholder="http://10.0.0.136:8642" mono />
        <Field label="llama-server URL" value={form.llama_url} onChange={(v) => set("llama_url", v)} placeholder="http://10.0.0.136:8080" mono />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Log Path" value={form.log_path} onChange={(v) => set("log_path", v)} mono />
        <Field label="Sessions Glob" value={form.sessions_glob} onChange={(v) => set("sessions_glob", v)} mono />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="llama-server Unit" value={form.llama_unit} onChange={(v) => set("llama_unit", v)} placeholder="llama-server.service" mono />
        <Field label="Telegram Chat ID" value={form.telegram_chat_id} onChange={(v) => set("telegram_chat_id", v)} mono />
      </div>
      <Field label="Telegram Bot Token Env File" value={form.telegram_bot_token_env} onChange={(v) => set("telegram_bot_token_env", v)} mono />

      <div className="flex justify-end gap-2 border-t border-zinc-800 pt-3">
        <button onClick={onCancel} className="rounded px-4 py-1.5 text-xs text-zinc-400 hover:text-zinc-200">Cancel</button>
        <button onClick={save} disabled={saving || !form.id || !form.name}
          className="rounded bg-accent-glow/20 px-4 py-1.5 text-xs text-accent-glow hover:bg-accent-glow/30 disabled:opacity-40">
          {saving ? "Saving..." : initial ? "Update" : "Add Agent"}
        </button>
      </div>
    </div>
  );
}

// ── Service form ──

const EMPTY_SERVICE: ServiceConfig = {
  id: "", name: "", host: "", type: "systemd_user_local", unit: "", container: "",
  ssh_user: "", ssh_host: "", key_file: "", kind: "normal", description: "",
};

function ServiceForm({
  initial,
  machines,
  onSave,
  onCancel,
}: {
  initial?: ServiceConfig;
  machines: MachineConfig[];
  onSave: (s: ServiceConfig) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<ServiceConfig>(initial ?? { ...EMPTY_SERVICE });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof ServiceConfig, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const isDocker = form.type.includes("docker");
  const isRemote = form.type.includes("remote");

  const save = async () => {
    setSaving(true);
    try { await onSave(form); } finally { setSaving(false); }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="ID" value={form.id} onChange={(v) => set("id", v)} placeholder="my-service" mono />
        <Field label="Name" value={form.name} onChange={(v) => set("name", v)} placeholder="Service Name" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Select label="Host" value={form.host} onChange={(v) => set("host", v)}
          options={[{ value: "", label: "Select..." }, ...machines.map((m) => ({ value: m.id, label: m.name }))]}
        />
        <Select label="Type" value={form.type} onChange={(v) => set("type", v)}
          options={[
            { value: "systemd_user_local", label: "systemd (local)" },
            { value: "systemd_user_remote", label: "systemd (remote)" },
            { value: "docker_local", label: "Docker (local)" },
          ]}
        />
      </div>
      {!isDocker && <Field label="Unit" value={form.unit} onChange={(v) => set("unit", v)} placeholder="my-service.service" mono />}
      {isDocker && <Field label="Container" value={form.container} onChange={(v) => set("container", v)} placeholder="container-name" mono />}
      {isRemote && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="SSH Host" value={form.ssh_host} onChange={(v) => set("ssh_host", v)} mono />
          <Field label="SSH User" value={form.ssh_user} onChange={(v) => set("ssh_user", v)} mono />
        </div>
      )}
      {isRemote && <Field label="SSH Key File" value={form.key_file} onChange={(v) => set("key_file", v)} mono />}
      <div className="grid grid-cols-2 gap-3">
        <Select label="Kind" value={form.kind} onChange={(v) => set("kind", v)}
          options={[{ value: "normal", label: "Normal" }, { value: "critical", label: "Critical" }]}
        />
        <Field label="Description" value={form.description} onChange={(v) => set("description", v)} />
      </div>

      <div className="flex justify-end gap-2 border-t border-zinc-800 pt-3">
        <button onClick={onCancel} className="rounded px-4 py-1.5 text-xs text-zinc-400 hover:text-zinc-200">Cancel</button>
        <button onClick={save} disabled={saving || !form.id || !form.name}
          className="rounded bg-accent-glow/20 px-4 py-1.5 text-xs text-accent-glow hover:bg-accent-glow/30 disabled:opacity-40">
          {saving ? "Saving..." : initial ? "Update" : "Add Service"}
        </button>
      </div>
    </div>
  );
}

// ── Modal wrapper ──

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-xl max-h-[85vh] overflow-y-auto rounded-lg border border-zinc-700/60 bg-ink-950 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-sm font-semibold text-zinc-200">[{title}]</h2>
        {children}
      </div>
    </div>
  );
}

// ── Config list with CRUD ──

function ConfigList<T extends { id: string; name: string }>({
  items,
  label,
  onAdd,
  onEdit,
  onDelete,
  renderDetail,
}: {
  items: T[];
  label: string;
  onAdd: () => void;
  onEdit: (item: T) => void;
  onDelete: (id: string) => void;
  renderDetail: (item: T) => string;
}) {
  const [deleting, setDeleting] = useState<string | null>(null);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs text-zinc-500">{items.length} {label}</span>
        <button onClick={onAdd}
          className="rounded border border-zinc-600 px-3 py-1 text-xs text-zinc-300 hover:border-accent-glow/60 hover:text-accent-glow">
          + Add
        </button>
      </div>
      {items.length === 0 ? (
        <div className="rounded border border-dashed border-zinc-700 p-6 text-center text-xs text-zinc-500">
          No {label} configured. Click + Add to get started.
        </div>
      ) : (
        <div className="space-y-1">
          {items.map((item) => (
            <div key={item.id}
              className="flex items-center justify-between rounded border border-zinc-800 bg-ink-900 px-3 py-2 hover:border-zinc-700">
              <div>
                <span className="text-sm text-zinc-200">{item.name}</span>
                <span className="ml-2 text-xs text-zinc-500 font-mono">{item.id}</span>
                <div className="text-[11px] text-zinc-500">{renderDetail(item)}</div>
              </div>
              <div className="flex gap-1">
                <button onClick={() => onEdit(item)} className="rounded px-2 py-1 text-[11px] text-zinc-400 hover:text-accent-glow">edit</button>
                <button
                  onClick={async () => {
                    if (deleting === item.id) return;
                    setDeleting(item.id);
                    try { await onDelete(item.id); } finally { setDeleting(null); }
                  }}
                  className="rounded px-2 py-1 text-[11px] text-zinc-500 hover:text-red-400"
                >
                  {deleting === item.id ? "..." : "del"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── General settings panel ──

function GeneralPanel() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    configApi.getGeneral().then((d) => setSettings(d as Record<string, string>)).catch(() => {});
  }, []);

  const set = (k: string, v: string) => setSettings((s) => ({ ...s, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      await configApi.putGeneral(settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { /* noop */ }
    setSaving(false);
  };

  return (
    <div className="space-y-3">
      <Field label="Honcho API URL" value={settings.honcho_url ?? ""} onChange={(v) => set("honcho_url", v)} placeholder="http://100.104.140.85:8000" mono />
      <Field label="Honcho Workspace" value={settings.honcho_workspace ?? ""} onChange={(v) => set("honcho_workspace", v)} placeholder="hermes" mono />
      <div className="flex items-center gap-3 pt-2">
        <button onClick={save} disabled={saving}
          className="rounded bg-accent-glow/20 px-4 py-1.5 text-xs text-accent-glow hover:bg-accent-glow/30 disabled:opacity-40">
          {saving ? "Saving..." : "Save"}
        </button>
        {saved && <span className="text-xs text-emerald-400">Saved</span>}
      </div>
    </div>
  );
}

// ── Main settings view ──

export default function SettingsView() {
  const [sub, setSub] = useState<Sub>("machines");
  const [machines, setMachines] = useState<MachineConfig[]>([]);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [services, setServices] = useState<ServiceConfig[]>([]);
  const [modal, setModal] = useState<{ type: "machine" | "agent" | "service"; item?: any } | null>(null);

  const reload = async () => {
    const [m, a, s] = await Promise.all([
      configApi.listMachines().catch(() => []),
      configApi.listAgents().catch(() => []),
      configApi.listServices().catch(() => []),
    ]);
    setMachines(m);
    setAgents(a);
    setServices(s);
  };

  useEffect(() => { reload(); }, []);

  const handleSaveMachine = async (m: MachineConfig) => {
    if (modal?.item) await configApi.updateMachine(modal.item.id, m);
    else await configApi.createMachine(m);
    setModal(null);
    reload();
  };

  const handleSaveAgent = async (a: AgentConfig) => {
    if (modal?.item) await configApi.updateAgent(modal.item.id, a);
    else await configApi.createAgent(a);
    setModal(null);
    reload();
  };

  const handleSaveService = async (s: ServiceConfig) => {
    if (modal?.item) await configApi.updateService(modal.item.id, s);
    else await configApi.createService(s);
    setModal(null);
    reload();
  };

  const panels: Record<Sub, ReactNode> = {
    machines: (
      <ConfigList
        items={machines}
        label="machines"
        onAdd={() => setModal({ type: "machine" })}
        onEdit={(m) => setModal({ type: "machine", item: m })}
        onDelete={async (id) => { await configApi.deleteMachine(id); reload(); }}
        renderDetail={(m) => `${m.hostname} (${m.username}@${m.protocol})`}
      />
    ),
    agents: (
      <ConfigList
        items={agents}
        label="agents"
        onAdd={() => setModal({ type: "agent" })}
        onEdit={(a) => setModal({ type: "agent", item: a })}
        onDelete={async (id) => { await configApi.deleteAgent(id); reload(); }}
        renderDetail={(a) => `${a.model} on ${a.host}`}
      />
    ),
    services: (
      <ConfigList
        items={services}
        label="services"
        onAdd={() => setModal({ type: "service" })}
        onEdit={(s) => setModal({ type: "service", item: s })}
        onDelete={async (id) => { await configApi.deleteService(id); reload(); }}
        renderDetail={(s) => `${s.type} on ${s.host} (${s.unit || s.container})`}
      />
    ),
    general: <GeneralPanel />,
  };

  return (
    <div className="space-y-4">
      {/* Sub-tab bar */}
      <div className="flex gap-1 rounded-lg border border-zinc-800 bg-ink-900 p-1">
        {SUBS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSub(s.id)}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors ${
              sub === s.id
                ? "bg-accent-glow/10 text-accent-glow"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {s.icon}
            <span>{s.label}</span>
          </button>
        ))}
      </div>

      {/* Hint */}
      <div className="text-[11px] text-zinc-500">
        {SUBS.find((s) => s.id === sub)?.hint}
      </div>

      {/* Panel */}
      {panels[sub]}

      {/* Modal */}
      {modal?.type === "machine" && (
        <Modal title={modal.item ? "Edit Machine" : "Add Machine"} onClose={() => setModal(null)}>
          <MachineForm initial={modal.item} onSave={handleSaveMachine} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal?.type === "agent" && (
        <Modal title={modal.item ? "Edit Agent" : "Add Agent"} onClose={() => setModal(null)}>
          <AgentForm initial={modal.item} machines={machines} onSave={handleSaveAgent} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal?.type === "service" && (
        <Modal title={modal.item ? "Edit Service" : "Add Service"} onClose={() => setModal(null)}>
          <ServiceForm initial={modal.item} machines={machines} onSave={handleSaveService} onCancel={() => setModal(null)} />
        </Modal>
      )}
    </div>
  );
}
