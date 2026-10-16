import { join } from "node:path";

/** The Agent's memory index in its workspace root. */
export const AGENT_MEMORY_FILE = "MEMORY.md";

/** Where an Agent keeps the code it works on, in its workspace root. */
export const AGENT_WORK_DIRECTORY = "work";

const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Returns the only permitted durable directory for an Agent runtime. */
export function agentWorkspaceDirectory(
  workspaceRoot: string,
  workspaceId: string,
  agentId: string,
): string {
  if (!STABLE_ID.test(workspaceId) || !STABLE_ID.test(agentId)) {
    throw new Error("workspace and Agent IDs must be stable path-safe identifiers");
  }
  return join(workspaceRoot, workspaceId, "agents", agentId);
}
