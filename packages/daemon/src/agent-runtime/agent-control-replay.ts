import type { AgentControlResult } from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeState } from "./agent-runtime-state";

type ReplayRuntime = Pick<{ result(result: AgentControlResult): Promise<void> }, "result">;

/** Replays durable Agent control results after reconnect, independently per Agent. */
export async function replayAgentControlResults(
  known: ReadonlySet<string>,
  state: AgentRuntimeState,
  runtime: ReplayRuntime,
): Promise<void> {
  await Promise.all(
    [...known].map((id) =>
      state.run(id, async () => {
        const record = await state.store.read(id);
        if (record?.lastResult) await runtime.result(record.lastResult).catch(() => {});
      }),
    ),
  );
}
