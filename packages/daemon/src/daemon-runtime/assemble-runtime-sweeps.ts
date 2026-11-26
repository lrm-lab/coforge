import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { CodeAgentProvider } from "@lrm/coforge-anvil";
import type { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import type { AgentContexts } from "./agent-contexts";
import type { AgentDeliveryGate } from "./agent-delivery-gate";
import type { AgentStopRegistry } from "./agent-stop-registry";
import type { CodeAgentInventorySync } from "./code-agent-inventory-sync";
import { codeAgentProviderCapabilities, createCodeAgentProvider } from "#src/code-agent/registry";
import { CatalogFreshnessSweep } from "./catalog-freshness-sweep";
import { ColdIdleSweep } from "./cold-idle-sweep";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { ActivityLaunch } from "./activity-launch";
import type { RuntimeRelease } from "./runtime-release";
import { RuntimeSweeps } from "./runtime-sweeps";
import { stalledRecoverySweep } from "./stalled-recovery-sweep";
import type { SessionSummaryObserver } from "./runtime-event-observation-ports";

function observedTimestampMs(occurredAt: string | undefined): number {
  const parsed = occurredAt === undefined ? Number.NaN : Date.parse(occurredAt);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : Date.now();
}

export function createSessionSummaryObserver(
  contexts: AgentContexts,
  sessionId: (agentId: string) => string | undefined,
  createProvider: (provider: RuntimeProvider) => CodeAgentProvider,
): SessionSummaryObserver {
  const supported = new Map<RuntimeProvider, boolean>();
  const tracksSummary = (provider: RuntimeProvider): boolean => {
    const cached = supported.get(provider);
    if (cached !== undefined) return cached;
    let enabled = false;
    try {
      enabled = createProvider(provider).supportsSessionSummaryRecycle === true;
    } catch {
      enabled = false;
    }
    supported.set(provider, enabled);
    return enabled;
  };
  return {
    contextUsage(agentId, provider, usedTokens, windowTokens, occurredAt) {
      if (!tracksSummary(provider)) return;
      const currentSessionId = sessionId(agentId);
      if (!currentSessionId) return;
      contexts.recordSessionContextUsage(agentId, {
        sessionId: currentSessionId,
        provider,
        usedTokens,
        windowTokens,
        observedAtMs: observedTimestampMs(occurredAt),
      });
    },
    compaction(agentId, provider, tokensAfter, windowTokens) {
      if (!tracksSummary(provider)) return;
      const currentSessionId = sessionId(agentId);
      if (!currentSessionId) return;
      contexts.recordSessionCompaction(agentId, {
        sessionId: currentSessionId,
        provider,
        ...(tokensAfter !== undefined ? { tokensAfter } : {}),
        ...(windowTokens !== undefined ? { windowTokens } : {}),
      });
    },
    turnCompleted(agentId, provider) {
      if (!tracksSummary(provider)) return;
      const currentSessionId = sessionId(agentId);
      if (!currentSessionId) return;
      contexts.recordSessionActivity(agentId, {
        sessionId: currentSessionId,
        provider,
      });
    },
  };
}

export function assembleRuntimeSweeps(ports: {
  processManager(): AgentProcessManager;
  runtimeRelease(): RuntimeRelease<ActivityLaunch>;
  providerFactory(): (provider: RuntimeProvider) => CodeAgentProvider;
  contexts(): AgentContexts;
  deliveryGate(): AgentDeliveryGate;
  runnerHold(): boolean;
  stopState(): AgentStopRegistry;
  activeTransport(): DaemonConnectionClient | undefined;
  inventory(): CodeAgentInventorySync;
}): RuntimeSweeps {
  return new RuntimeSweeps([
    new ColdIdleSweep({
      agentIds: () => ports.processManager().runningAgentIds(),
      agent: (agentId) => ports.runtimeRelease().coldIdleAgent(agentId),
      provider: (provider) => ports.providerFactory()(provider),
      providerCapabilities: (provider) =>
        ports.providerFactory() === createCodeAgentProvider
          ? codeAgentProviderCapabilities(provider)
          : undefined,
      readSummaryFacts: (agentId, sessionId) =>
        ports.contexts().sessionResumeFacts(agentId, sessionId),
      stop: (stop) => ports.runtimeRelease().stopColdIdle(stop),
    }),
    stalledRecoverySweep({
      agentIds: () => ports.processManager().runningAgentIds(),
      hasQueuedDeliveries: (agentId) => ports.deliveryGate().hasQueued(agentId),
      runnerHold: () => ports.runnerHold(),
      isStopping: (agentId) => ports.stopState().stopping(agentId),
      release: ports.runtimeRelease(),
    }),
    new CatalogFreshnessSweep({
      transport: () => ports.activeTransport(),
      recheck: (transport) => ports.inventory().recheckCatalogs(transport),
    }),
  ]);
}
