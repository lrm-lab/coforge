import type { AgentControlResult } from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeState } from "./agent-runtime-state";

type ReplayRuntime = Pick<{ result(result: AgentControlResult): Promise<void> }, "result">;

/** Replays durable Agent control results after reconnect, one Agent at a time. */
export async function replayAgentControlResults(
  known: ReadonlySet<string>,
  state: AgentRuntimeState,
  runtime: ReplayRuntime,
): Promise<void> {
  for (const id of known)
    await state.run(id, async () => {
      const record = await state.store.read(id);
      if (record?.lastResult) await runtime.result(record.lastResult).catch(() => {});
    });
}
