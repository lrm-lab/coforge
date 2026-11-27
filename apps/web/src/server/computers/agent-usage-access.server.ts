import { encodeDaemonRuntimeUsageScanRequest } from "@lrm/coforge-sdk/internal";
import { daemonControlChannel } from "#src/server/centrifugo/server-api.server";
import type { RedisAgentUsageCache } from "#src/server/centrifugo/agent-usage-cache.server";
import type { UsageReadResult } from "#src/server/centrifugo/usage-cache.server";
import { AppError } from "#src/lib/app-error";
import { AGENT_USAGE_SCAN_PREFIX, type AgentUsageTarget } from "./agent-usage-scope.server";
import { drawnReading, type RuntimeUsageAccess } from "./runtime-usage-access.server";
import type { Principal } from "./runtime-auth.server";

export type AgentUsageReadResult = UsageReadResult & {
  unavailable?: true;
  billing?: AgentUsageTarget["billing"];
  target?: Pick<AgentUsageTarget, "computerId" | "runtimeConfigRevision">;
};

export class AgentUsageAccess {
  constructor(
    private readonly ports: {
      resolve(principal: Principal, agentId: string): Promise<AgentUsageTarget | undefined>;
      usageOffer: RuntimeUsageAccess["usageOffer"];
      supportedWorker(workspaceId: string, computerId: string): Promise<string | undefined>;
      cache(): Pick<RedisAgentUsageCache, "read" | "claim" | "release">;
      publish(channel: string, request: Uint8Array): Promise<unknown>;
      requestId?(): string;
    },
  ) {}

  async read(principal: Principal, agentId: string): Promise<AgentUsageReadResult> {
    const { target, scope, includeBalance } = await this.authorize(principal, agentId);
    const { computerId, runtimeConfigRevision, billing } = target;
    if (billing) return { state: "fresh", billing, target: { computerId, runtimeConfigRevision } };
    if (!scope) return { state: "fresh", unavailable: true };
    const reading = await this.ports.cache().read({ ...target, workerInstanceId: scope });
    if (!reading) return { state: "fresh", unavailable: true };
    return {
      ...(includeBalance ? reading : drawnReading(reading)),
      target: { computerId, runtimeConfigRevision },
    };
  }

  async scan(principal: Principal, agentId: string) {
    const { target, scope: workerInstanceId } = await this.authorize(principal, agentId);
    if (!workerInstanceId) return { status: "unavailable" as const };
    const scope = { ...target, workerInstanceId };
    const requestId = AGENT_USAGE_SCAN_PREFIX + (this.ports.requestId?.() ?? crypto.randomUUID());
    const cache = this.ports.cache();
    const scanId = await cache.claim(scope, requestId);
    if (!scanId) return { status: "unavailable" as const };
    if (scanId === requestId) {
      try {
        const { workspaceId, computerId, provider, runtimeConfigRevision } = target;
        await this.ports.publish(
          daemonControlChannel(workspaceId, computerId),
          encodeDaemonRuntimeUsageScanRequest({
            protocolMajor: 1,
            requestId,
            workspaceId,
            computerId,
            provider,
            agentId: target.agentId,
            expectedRuntimeConfigRevision: runtimeConfigRevision,
          }),
        );
      } catch (error) {
        await cache.release(scope, requestId).catch(() => undefined);
        throw error;
      }
    }
    return { status: "pending" as const, scanId };
  }

  private async authorize(principal: Principal, agentId: string) {
    const target = await this.ports.resolve(principal, agentId);
    if (!target) throw new AppError("NOT_FOUND");
    const { runtime, offered } = await this.ports.usageOffer(principal, target);
    if (!runtime || !offered) throw new AppError("NOT_FOUND");
    return {
      target,
      scope: target.billing
        ? undefined
        : await this.ports.supportedWorker(target.workspaceId, target.computerId),
      includeBalance: runtime.ownerId === principal.userId,
    };
  }
}
