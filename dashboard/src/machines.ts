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

// Pre-baked from `sync_connections.py` output. Phase 6 will replace this with
// a live fetch from the FastAPI backend (which itself queries Guacamole).
export const MACHINES: Machine[] = [
  {
    id: "bradbigdesktop",
    name: "bradBigDesktop",
    short: "RTX 4090 workstation",
    role: "Runs Clue (Qwen 3.6 27B)",
    protocol: "ssh",
    hostname: "100.106.249.30",
    lan_ip: "10.0.0.136",
    guacamole_id: "1",
    data_source: "postgresql",
    icon: "desktop",
  },
  {
    id: "natalie",
    name: "Natalie",
    short: "UM690 mini-PC",
    role: "Hosts OpenClaw + Hermes + this dashboard",
    protocol: "ssh",
    hostname: "10.0.0.119",
    lan_ip: "10.0.0.119",
    guacamole_id: "2",
    data_source: "postgresql",
    icon: "minipc",
  },
  {
    id: "junior",
    name: "Junior",
    short: "Meigao F7BSC",
    role: "Runs Sarah (Gemma 4 26B)",
    protocol: "ssh",
    hostname: "10.0.0.54",
    lan_ip: "10.0.0.54",
    guacamole_id: "3",
    data_source: "postgresql",
    icon: "minipc",
  },
  {
    id: "plex",
    name: "Plex Box",
    short: "brad-Venus-series",
    role: "Plex + Home Assistant + Docker host",
    protocol: "ssh",
    hostname: "10.0.0.10",
    lan_ip: "10.0.0.10",
    guacamole_id: "4",
    data_source: "postgresql",
    icon: "server",
  },
  {
    id: "pi",
    name: "Pi",
    short: "raspberry pi",
    role: "Smart-sprinkler controller, kitchen kiosk DNS",
    protocol: "ssh",
    hostname: "10.0.0.102",
    lan_ip: "10.0.0.102",
    guacamole_id: "5",
    data_source: "postgresql",
    icon: "pi",
  },
  {
    id: "mister",
    name: "MiSTer",
    short: "SuperStation One",
    role: "MiSTer FPGA — retro console, password auth (root/1)",
    protocol: "ssh",
    hostname: "10.0.0.64",
    lan_ip: "10.0.0.64",
    guacamole_id: "6",
    data_source: "postgresql",
    icon: "console",
  },
];

/**
 * Build the Guacamole "deep-link" hash for a connection.
 * Format: base64(<connectionID>\0c\0<dataSource>) — c = connection (vs. group).
 * Reference: https://guacamole.apache.org/doc/gug/using-guacamole.html#client-url
 */
export function guacamoleHash(m: Machine): string {
  const raw = `${m.guacamole_id}\0c\0${m.data_source}`;
  // btoa expects latin-1 — our chars are all ASCII so this is fine.
  return btoa(raw);
}

export function guacamoleUrl(m: Machine, base = "http://100.104.140.85:8080"): string {
  return `${base}/#/client/${guacamoleHash(m)}`;
}
