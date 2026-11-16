import { attachPlatformMemoryBriefing } from "#src/agent-runtime/platform-memory-briefing";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
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
  inputDrain: Pick<AgentInputDrain, "get">;
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

/** Both kinds of fresh-session context use the same queue and remain independent of runtime. */
export function sessionMemoryPorts(
  memory: () => SessionMemoryHooks,
  transport: () => Pick<DaemonConnectionClient, "agentMemory">,
) {
  return {
    attachSessionMemory: async (
      agentId: string,
      config?: { agentApiKey: string; identity?: { features?: { platformMemory?: boolean } } },
    ) => {
      const hooks = memory();
      const client = transport();
      // Capture the task before local memory can be prepended to its prompt. Recall and local
      // file reads can then run together; neither needs the other's injected reference text.
      const recall =
        config?.identity?.features?.platformMemory && client.agentMemory
          ? attachPlatformMemoryBriefing(hooks.inputDrain.get(agentId), (command) =>
              client.agentMemory!(command, config.agentApiKey),
            )
          : undefined;
      const attached = await attachFreshSessionMemory(hooks, agentId);
      await recall;
      return attached !== undefined;
    },
  };
}
