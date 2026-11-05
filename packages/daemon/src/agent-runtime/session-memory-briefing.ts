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

/** Closes a block that stands alone as the session's first turn: a fresh session woken by a real
 * delivery, or one whose context was just compacted. It is context, never a request. */
const MEMORY_BLOCK_NOTE =
  "That is your MEMORY.md as context, not a request: treat it as reference only and do not reply to it; your next input follows.";

/** The block closed as a turn of its own — how a session that starts or restarts with queued
 * input is handed its memory. */
export function memoryBlockInput(block: StartupMemoryBlock): string {
  return `${block.text}\n\n${MEMORY_BLOCK_NOTE}`;
}

/**
 * A fresh session starts with its MEMORY.md block ahead of everything else: merged into the
 * launch's starter when nothing else has anything to say, so it costs no extra turn, and as its
 * own first turn when a real delivery or recovery notice is queued behind it. The starter stops
 * telling the Agent to read MEMORY.md exactly when the block is complete.
 *
 * A queue that is gone or closed, or a block that could not be built, leaves the launch exactly
 * as it was: the starter still says to read the file.
 */
export function prependSessionMemory(
  queue: AgentInputQueue | undefined,
  block: StartupMemoryBlock | undefined,
): void {
  if (!queue || queue.closed || !block) return;
  const starter = queue.items.find(
    (item): item is Extract<AgentInput, { kind: "startup" }> => item.kind === "startup",
  );
  if (starter) starter.text = agentStartupInput(false, block.complete);
  const behind = queue.items.filter((item) => item.kind !== "startup");
  if (starter && !queueHasInputContent(behind)) {
    // The starter is the session's whole first turn: the block rides in it, no second turn.
    starter.text = `${block.text}\n\n${starter.text}`;
    return;
  }
  // An empty recovery item is enqueued even when there is nothing to recover; it says nothing.
  const first = behind.find(
    (item) =>
      item.kind === "delivery" ||
      item.kind === "prompt" ||
      (item.kind === "recovery" && recoveryHasContent(item.context)),
  );
  if (first?.kind === "prompt") {
    // A person's own first prompt (guidance for a new session): the block rides in it too, so
    // their words still open the session and no turn is spent on a reply to context alone.
    first.text = `${block.text}\n\n${first.text}`;
    return;
  }
  // A queued delivery or notice is handed to the runtime after this input, but the block still
  // comes first: one short reference turn, then the real input.
  const completion = Promise.withResolvers<void>();
  completion.promise.catch(() => {});
  queue.items.unshift({
    kind: "memory",
    text: memoryBlockInput(block),
    completion: { resolve: completion.resolve, reject: completion.reject },
  });
}

/**
 * Reads the Agent's MEMORY.md at the one budget and puts it at the front of the queue; the same
 * assembly for a fresh launch and for the idle recycle. `undefined` when there is nothing to show.
 */
export async function attachSessionMemory(
  queue: AgentInputQueue | undefined,
  agentWorkspaceDirectory: string,
): Promise<StartupMemoryBlock | undefined> {
  const block = await startupMemoryBlock(agentWorkspaceDirectory);
  prependSessionMemory(queue, block);
  return block;
}
