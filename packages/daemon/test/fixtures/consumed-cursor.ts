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
  store.write(agentId, state);
  store.close();
  return new AgentConsumedSeqStore(root);
}
