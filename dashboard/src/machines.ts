export type MachineStatus = "online" | "offline" | "unknown";

export type Machine = {
  id: string;
  name: string;
  short: string;
  role: string;
  protocol: "ssh" | "rdp" | "vnc";
  hostname: string;
  lan_ip: string;
  guacamole_id: string;
  data_source: string;
  icon: string;
  status?: MachineStatus;
};

// Machines are loaded from the API (/api/machines) at runtime.
// This static list is a fallback for when the API hasn't responded yet.
// Configure your fleet via the Setup tab or by editing machines.yaml.
export const MACHINES: Machine[] = [];

/**
 * Build the Guacamole "deep-link" hash for a connection.
 * Format: base64(<connectionID>\0c\0<dataSource>) — c = connection (vs. group).
 */
export function guacamoleHash(m: Machine): string {
  const raw = `${m.guacamole_id}\0c\0${m.data_source}`;
  return btoa(raw);
}

export function guacamoleUrl(m: Machine, base?: string): string {
  const guacBase = base || localStorage.getItem("kvmhub.guacamoleUrl") || "/guacamole";
  return `${guacBase}/#/client/${guacamoleHash(m)}`;
}
