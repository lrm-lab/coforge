import type { AgentSession } from "@coforge/agent";
import type { AgentInputDrain } from "./agent-input-drain";
import { agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";
import {
  attachSessionMemory,
  type StartupMemoryBlock,
} from "#src/agent-runtime/session-memory-briefing";
import {
  prependStandingPromptUpdate,
  standingPromptUpdateStandalone,
} from "#src/agent-runtime/standing-prompt-refresh";

export type SessionMemoryHooks = Readonly<{
  connection: Readonly<{ workspaceRoot: string; workspaceId: string }>;
  inputDrain: AgentInputDrain;
  session(agentId: string): AgentSession | undefined;
}>;

export function attachFreshSessionMemoryPort(
  memory: () => SessionMemoryHooks,
): (agentId: string) => Promise<boolean> {
  return async (agentId) => (await attachFreshSessionMemory(memory(), agentId)) !== undefined;
}

export function launchInputPorts(memory: () => SessionMemoryHooks): {
  attachSessionMemory: (agentId: string) => Promise<boolean>;
  prependStandingPromptUpdate: (agentId: string, instructions: string) => boolean;
} {
  return {
    attachSessionMemory: attachFreshSessionMemoryPort(memory),
    prependStandingPromptUpdate: (agentId, instructions) => {
      if (!instructions.trim()) return false;
      const { inputDrain } = memory();
      const queue = inputDrain.get(agentId);
      if (queue) return prependStandingPromptUpdate(queue, instructions);
      void inputDrain
        .prepend(agentId, (completion) => ({
          kind: "memory",
          text: standingPromptUpdateStandalone(instructions),
          allowsEmptyCompletion: true,
          completion,
        }))
        .catch(() => {});
      return true;
    },
  };
}

export function attachFreshSessionMemory(
  hooks: SessionMemoryHooks,
  agentId: string,
): Promise<StartupMemoryBlock | undefined> {
  return attachSessionMemory(
    hooks.inputDrain.get(agentId),
    agentWorkspaceDirectory(hooks.connection.workspaceRoot, hooks.connection.workspaceId, agentId),
  );
}
