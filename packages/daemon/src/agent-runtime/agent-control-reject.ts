import type { AgentControlScope } from "@lrm/coforge-sdk/internal";
import type { AgentControlContext } from "./agent-control-runtime";
import { nextSequence } from "./agent-control-sequence";

export async function rejectStart(
  { state, runtime }: Pick<AgentControlContext, "state" | "runtime">,
  scope: AgentControlScope,
  errorCode: string,
): Promise<void> {
  return state.run(scope.agentId, async () => {
    const record = await state.store.read(scope.agentId);
    if (record && record.scope.epoch >= scope.epoch) return;
    await runtime
      .result({ ...scope, phase: "failed", sequence: nextSequence(record, scope), errorCode })
      .catch(() => {});
  });
}
