import type { AgentControlView } from "../../../apps/web/src/server/agents/agent-control.server";

/** Pending is an observation deadline, not a failed launch. Rejoin the same request. */
export async function waitForAgentStart(
  agentId: string,
  execute: (requestId?: string) => Promise<AgentControlView>,
  delay: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<void> {
  let requestId: string | undefined;
  for (let observation = 1; observation <= 3; observation++) {
    const result = await execute(requestId);
    requestId = result.requestId;
    if (result.phase === "completed") return;
    if (result.phase !== "pending") {
      throw new Error(
        `Agent ${agentId} start ${result.phase}${result.error ? `: ${result.error}` : ""}`,
      );
    }
    console.warn(
      JSON.stringify({
        event: "eval.agent_start_pending",
        agentId,
        requestId: result.requestId,
        observation,
        maxObservations: 3,
      }),
    );
    if (observation < 3) await delay(1000);
  }
  throw new Error(`Agent ${agentId} start pending after 3 observations`);
}
