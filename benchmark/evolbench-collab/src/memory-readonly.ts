import { OPENVIKING_AGENT_PROTOCOL } from "../../../packages/coforge-sdk/src/agent/openviking-memory";
import type { AgentProxyRuntime } from "../../../packages/daemon/src/agent-proxy";

/** Diagnosis creates sessions even without drain. Stop it before forwarding to
 * the shared web process, whose environment does not carry this episode's flag.
 * Reads and channel Offers do not persist to the OV account and remain available.
 */
export function guardWarmMemoryWrites(
  forward: NonNullable<AgentProxyRuntime["agentOpenviking"]>,
  arm: "warm" | "cold",
  readonly = Bun.env.COFORGE_EVAL_WARM_READONLY === "1",
): NonNullable<AgentProxyRuntime["agentOpenviking"]> {
  return async (context, request, agentApiKey) => {
    if (arm === "warm" && readonly && request.op === "diagnose") {
      return {
        protocol: OPENVIKING_AGENT_PROTOCOL,
        op: "diagnose",
        operationId: request.operationId,
        duplicate: false,
        status: "failed",
        published: false,
        reason: "eval_warm_readonly",
      };
    }
    return forward(context, request, agentApiKey);
  };
}
