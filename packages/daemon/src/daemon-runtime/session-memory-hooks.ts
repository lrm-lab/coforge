import type { AgentSession } from "@coforge/agent";
import type { AgentInputDrain } from "./agent-input-drain";
import { agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";
import {
  attachSessionMemory,
  type StartupMemoryBlock,
} from "#src/agent-runtime/session-memory-briefing";

/** Everything the two MEMORY.md hooks need: the Agent's directory, its input queue, and whether
 * it has a live session to hand input to. */
export type SessionMemoryHooks = Readonly<{
  connection: Readonly<{ workspaceRoot: string; workspaceId: string }>;
  inputDrain: AgentInputDrain;
  session(agentId: string): AgentSession | undefined;
}>;

/** The launch's fresh-session port: whether a block went in. */
export function attachFreshSessionMemoryPort(
  memory: () => SessionMemoryHooks,
): (agentId: string) => Promise<boolean> {
  return async (agentId) => (await attachFreshSessionMemory(memory(), agentId)) !== undefined;
}

/** A fresh session's MEMORY.md block in front of its queued input; `undefined` when the file has
 * nothing to show (the starter then still tells the Agent to read it). */
export function attachFreshSessionMemory(
  hooks: SessionMemoryHooks,
  agentId: string,
): Promise<StartupMemoryBlock | undefined> {
  return attachSessionMemory(
    hooks.inputDrain.get(agentId),
    agentWorkspaceDirectory(hooks.connection.workspaceRoot, hooks.connection.workspaceId, agentId),
  );
}
