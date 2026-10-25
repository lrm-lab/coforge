import type { PrismaClient } from "#src/generated/prisma/client";
import { agentTurnInterruptMethods } from "./agent-turn-interrupt-receiver.server";
import { runtimeAuthMethods } from "./runtime-auth-receiver.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";

/** The report methods of the features whose daemon answers arrive on RPC and are kept in Redis. */
export function daemonReportMethods(db: PrismaClient | null): Record<string, CentrifugoRpcMethod> {
  return { ...agentTurnInterruptMethods(db), ...runtimeAuthMethods(db) };
}
