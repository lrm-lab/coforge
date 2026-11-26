import { agentStartupInput } from "#src/agent-runtime/agent-startup";
import {
  startupMemoryBlock,
  type StartupMemoryBlock,
} from "#src/agent-runtime/startup-memory-block";

export type { StartupMemoryBlock };
import {
  queueHasInputContent,
  recoveryHasContent,
  type AgentInput,
  type AgentInputQueue,
} from "#src/daemon-runtime/runtime-launch-intent";

const MEMORY_BLOCK_NOTE =
  "That is your MEMORY.md as context, not a request: treat it as reference only and do not reply to it; your next input follows.";

export function memoryBlockInput(block: StartupMemoryBlock): string {
  return `${block.text}\n\n${MEMORY_BLOCK_NOTE}`;
}

export function prependSessionMemory(
  queue: AgentInputQueue | undefined,
  block: StartupMemoryBlock | undefined,
): void {
  if (!queue || queue.closed || !block) return;
  const starter = queue.items.find(
    (item): item is Extract<AgentInput, { kind: "startup" }> => item.kind === "startup",
  );
  if (starter) starter.text = agentStartupInput(false, true, starter.openTasks);
  const behind = queue.items.filter((item) => item.kind !== "startup");
  if (starter && !queueHasInputContent(behind)) {
    starter.text = `${block.text}\n\n${starter.text}`;
    return;
  }
  const first = behind.find(
    (item) =>
      item.kind === "delivery" ||
      item.kind === "prompt" ||
      (item.kind === "recovery" && recoveryHasContent(item.context)),
  );
  if (first?.kind === "prompt") {
    first.text = `${block.text}\n\n${first.text}`;
    return;
  }
  const completion = Promise.withResolvers<void>();
  completion.promise.catch(() => {});
  queue.items.unshift({
    kind: "memory",
    text: memoryBlockInput(block),
    allowsEmptyCompletion: true,
    completion: { resolve: completion.resolve, reject: completion.reject },
  });
}

export async function attachSessionMemory(
  queue: AgentInputQueue | undefined,
  agentWorkspaceDirectory: string,
): Promise<StartupMemoryBlock | undefined> {
  const block = await startupMemoryBlock(agentWorkspaceDirectory);
  prependSessionMemory(queue, block);
  return block;
}
