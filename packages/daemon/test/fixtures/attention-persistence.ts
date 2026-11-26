import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import type { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";
import { session } from "./attention-delivery";
const stateDirectories: string[] = [];
export async function clearAttentionStateDirectories() {
  await Promise.all(
    stateDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
}
export const temporaryStateDirectory = () => {
  const path = join(tmpdir(), `coforge-attention-${crypto.randomUUID()}`);
  stateDirectories.push(path);
  return path;
};
export const indexWithConsumedSeqs = (
  store: AgentConsumedSeqStore,
  sessionFor: () => ReturnType<typeof session> = () => session(),
  notices: string[] = [],
) =>
  new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => sessionFor() ?? session((notice) => notices.push(notice)) },
    async () => {},
    () => {},
    {
      shouldHold: () => false,
      enqueue: () => {},
      busy: () => {},
      consumedSeqs: store,
    },
  );
export const bindTargets = (index: AgentMessageAttentionIndex, ...targets: string[]) => {
  for (const target of targets) index.bindConversation("agent-1", target, "conversation-1");
};
