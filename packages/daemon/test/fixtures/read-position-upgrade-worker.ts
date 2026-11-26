import { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";

const [, , stateDirectory, agentId] = process.argv;
if (!stateDirectory || !agentId || !process.send)
  throw new Error("Expected an isolated state directory, a synthetic Agent ID and IPC");

const store = new AgentConsumedSeqStore(stateDirectory);
process.send("opening");
try {
  store.read(agentId);
} finally {
  store.close();
}
process.send("finished");
