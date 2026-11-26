import { join } from "node:path";
import {
  AgentConsumedSeqStore,
  type AgentConsumedSeqState,
} from "#src/persistence/agent-consumed-seq-store";

/**
 * Writes an Agent's consumed cursor to the state database as an earlier daemon run left it, and
 * returns a store that reads it from there. `root` is the runtime-under-test's `stateDirectory`:
 * the ledger lives in `agent-state/<agentId>/state.db` under it.
 */
export async function seedCursor(agentId: string, state: AgentConsumedSeqState, root: string) {
  const store = new AgentConsumedSeqStore(root);
  store.stateDb(agentId).database.query("DELETE FROM scoped_consumed_seqs").run();
  store.write(agentId, state);
  if (state.scopedTargets) store.apply(agentId, { upsertScopedTargets: state.scopedTargets });
  store.close();
  return new AgentConsumedSeqStore(root);
}

export async function seedReviewedDelivery(workspaceRoot: string) {
  const stateDirectory = join(workspaceRoot, `state-${crypto.randomUUID()}`);
  await seedCursor(
    "agent-a",
    {
      targets: { "@agent": { conversationId: "conversation-1", seq: 3 } },
      aliases: {},
      nextReadOrder: 1,
    },
    stateDirectory,
  );
  return stateDirectory;
}
