import {
  AgentConsumedSeqStore,
  type AgentConsumedSeqState,
} from "#src/persistence/agent-consumed-seq-store";

/**
 * Writes an Agent's consumed cursor to disk as an earlier daemon run left it, and returns a store
 * that reads it from there. `root` defaults to the store's own (`COFORGE_CLI_CONSUMED_SEQ_STATE_DIR`
 * or the temporary directory), the one a runtime under test reads.
 */
export async function seedCursor(agentId: string, state: AgentConsumedSeqState, root?: string) {
  const store = new AgentConsumedSeqStore(root);
  store.write(agentId, state);
  await store.flush();
  return new AgentConsumedSeqStore(root);
}
