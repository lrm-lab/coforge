import type { AgentControlResult, AgentStartIntent } from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeState } from "./agent-runtime-state";

/** A Start's prompt turns (resume, introduction): only the Start that carries them delivers them. */
export function carriesStartPrompt(intent: AgentStartIntent): boolean {
  return intent.resumePrompt !== undefined || intent.introductionPrompt !== undefined;
}

export function withoutStartPrompts(intent: AgentStartIntent): AgentStartIntent {
  return { ...intent, resumePrompt: undefined, introductionPrompt: undefined };
}

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
