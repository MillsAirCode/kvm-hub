/** Config CRUD helpers for machines / agents / services. */

export type ConfigType = "machines" | "agents" | "services";

export interface MachineConfig {
  id: string;
  name: string;
  icon: string;
  role: string;
  protocol: string;
  hostname: string;
  lan_ip: string;
  mac: string;
  username: string;
  key_file: string;
  password?: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  short: string;
  role: string;
  host: string;
  user: string;
  key_file: string;
  log_path: string;
  sessions_glob: string;
  model: string;
  icon: string;
  api_server_url: string;
  llama_url: string;
  llama_unit: string;
  telegram_bot_token_env: string;
  telegram_chat_id: string;
}

export interface ServiceConfig {
  id: string;
  name: string;
  host: string;
  type: string;
  unit: string;
  container: string;
  ssh_user: string;
  ssh_host: string;
  key_file: string;
  kind: string;
  description: string;
}

export interface ConfigStatus {
  has_machines: boolean;
  has_agents: boolean;
  has_services: boolean;
}

export interface SshTestResult {
  ok: boolean;
  error?: string;
  latency_ms: number;
}

export interface DiscoveredService {
  id: string;
  name: string;
  type: string;
  unit?: string;
  container?: string;
  host: string;
  ssh_user?: string;
  ssh_host?: string;
  key_file?: string;
  description?: string;
}

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(path, opts);
  if (!r.ok) {
    const body = await r.text();
    throw new Error(body || `HTTP ${r.status}`);
  }
  return r.json();
}

export const configApi = {
  status: () => api<ConfigStatus>("/api/config/status"),

  listMachines: () => api<MachineConfig[]>("/api/config/machines"),
  createMachine: (m: MachineConfig) =>
    api<{ ok: boolean }>("/api/config/machines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(m),
    }),
  updateMachine: (id: string, m: MachineConfig) =>
    api<{ ok: boolean }>(`/api/config/machines/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(m),
    }),
  deleteMachine: (id: string) =>
    api<{ ok: boolean }>(`/api/config/machines/${id}`, { method: "DELETE" }),

  listAgents: () => api<AgentConfig[]>("/api/config/agents"),
  createAgent: (a: AgentConfig) =>
    api<{ ok: boolean }>("/api/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(a),
    }),
  updateAgent: (id: string, a: AgentConfig) =>
    api<{ ok: boolean }>(`/api/config/agents/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(a),
    }),
  deleteAgent: (id: string) =>
    api<{ ok: boolean }>(`/api/config/agents/${id}`, { method: "DELETE" }),

  listServices: () => api<ServiceConfig[]>("/api/config/services"),
  createService: (s: ServiceConfig) =>
    api<{ ok: boolean }>("/api/config/services", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
    }),
  updateService: (id: string, s: ServiceConfig) =>
    api<{ ok: boolean }>(`/api/config/services/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
    }),
  deleteService: (id: string) =>
    api<{ ok: boolean }>(`/api/config/services/${id}`, { method: "DELETE" }),

  testSsh: (params: { hostname: string; username: string; key_file: string }) =>
    api<SshTestResult>("/api/config/test-ssh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }),

  discoverServices: (machineId: string) =>
    api<{ machine_id: string; discovered: DiscoveredService[] }>(
      `/api/config/discover-services/${machineId}`,
      { method: "POST" },
    ),

  getGeneral: () => api<Record<string, unknown>>("/api/config/general"),
  putGeneral: (data: Record<string, unknown>) =>
    api<{ ok: boolean }>("/api/config/general", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
};
