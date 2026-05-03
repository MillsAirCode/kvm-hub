/**
 * Tiny in-app event bus so components can broadcast workflow events
 * (e.g. Broadcast composer → WorkflowGraph) without prop-drilling.
 *
 * Hermes/Claude WS chat tails only fire on messages persisted to session
 * files. The Broadcast composer hits /v1/chat/completions directly on
 * api_server, which doesn't always touch those session files — so the
 * graph would otherwise look dead even when the user just sent something.
 * This bus closes that loop.
 */

export type WorkflowEvent =
  | { type: "user_to_agent"; agentId: string; text: string; ts: number }
  | { type: "agent_to_user"; agentId: string; text: string; ts: number }
  | { type: "agent_to_agent"; fromId: string; toId: string; text: string; ts: number }
  | { type: "ssh_call"; fromId: string; toId: string; cmd: string; ts: number }
  | { type: "agent_tool"; agentId: string; tool: string; ts: number };

type Listener = (e: WorkflowEvent) => void;

const listeners = new Set<Listener>();

export function emitWorkflow(e: WorkflowEvent) {
  for (const l of listeners) {
    try {
      l(e);
    } catch {
      /* noop */
    }
  }
}

export function onWorkflow(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
