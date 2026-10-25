import {
  AGENT_TURN_INTERRUPT_RESULT_METHOD,
  decodeAgentTurnInterruptResult,
  type AgentTurnInterruptResult,
} from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import type { AgentTurnInterrupt } from "#src/server/agents/agent-turn-interrupt.server";
import { userAgentTurnInterrupt } from "#src/server/agents/user-agent-control.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";
import { rejectNonDaemonPrincipal } from "./daemon-principal.server";

export function createAgentTurnInterruptResultMethod(
  interrupts: Pick<AgentTurnInterrupt, "receive">,
): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    const rejection = rejectNonDaemonPrincipal(metadata.principal);
    if (rejection) return rejection;
    let result: AgentTurnInterruptResult;
    try {
      result = decodeAgentTurnInterruptResult(payload);
    } catch {
      return { code: 403, message: "Agent turn interrupt result is not authorized" };
    }
    if (
      metadata.principal.workspaceId !== result.workspaceId ||
      metadata.principal.computerId !== result.computerId
    )
      return { code: 403, message: "Agent turn interrupt result is not authorized" };
    let stored: boolean;
    try {
      stored = await interrupts.receive(metadata.principal, result);
    } catch {
      return { code: 503, message: "Agent turn interrupt result could not be stored" };
    }
    if (!stored) return { code: 403, message: "Agent turn interrupt result is not authorized" };
    return new Uint8Array();
  };
}

/** The result callback, or the 503 stub when the server composes without a database. */
export function agentTurnInterruptMethods(
  db: PrismaClient | null,
): Record<string, CentrifugoRpcMethod> {
  return {
    [AGENT_TURN_INTERRUPT_RESULT_METHOD]: db
      ? createAgentTurnInterruptResultMethod(userAgentTurnInterrupt(db))
      : () => ({ code: 503, message: "protocol method dependencies are unavailable" }),
  };
}
