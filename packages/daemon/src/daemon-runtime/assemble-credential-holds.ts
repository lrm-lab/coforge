import { AGENT_ACTIVITY_DETAIL_KIND } from "@lrm/coforge-sdk/internal";
import type { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import { credentialInvalidNoticeText } from "#src/agent-runtime/runtime-error-activity";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { ActivityLaunch } from "./activity-launch";
import type { ActivityDraft, AgentActivityPublisher } from "./agent-activity-publisher";
import type { AgentDeliveryGate } from "./agent-delivery-gate";
import type { AgentLifecycle } from "./agent-lifecycle";
import { CredentialDiskWatch } from "./credential-disk-watch";
import { CredentialInvalidHolds } from "./credential-invalid-holds";
import type { RuntimeErrorDeliveryHold } from "./runtime-error-delivery-hold";
import { runtimeDisplayName } from "./session-invalidate-activity";

/**
 * The credential-invalid hold over the runtime's collaborators, and the watch of the credential
 * files that ends it when a login is made outside the Daemon. Every collaborator the runtime
 * builds after this one is a thunk: it is read when a hold starts or ends, not when this is made.
 */
export function assembleCredentialHolds(input: {
  deliveryGate: AgentDeliveryGate;
  lifecycle: AgentLifecycle;
  /** Holds one Agent's deliveries (ending a retry backoff it had). */
  errorHold(): Pick<RuntimeErrorDeliveryHold, "holdCredentialInvalid">;
  processManager(): Pick<
    AgentProcessManager,
    "runningAgentIds" | "isRunning" | "runtime" | "restartConfig" | "session"
  >;
  /** Each Agent's current launch (`currentActivityLaunches`). */
  launches(): ReadonlyMap<string, Pick<ActivityLaunch, "launchId">>;
  activityPublisher(): Pick<AgentActivityPublisher<ActivityLaunch>, "lastBusy" | "publishCurrent">;
  activity(
    agentId: string,
    kind: typeof AGENT_ACTIVITY_DETAIL_KIND.IDLE,
    level: "info",
    detail: string,
  ): ActivityDraft;
  workspaceId(): string;
  /** Tells a live Agent what its hold kept. */
  presentKept(agentId: string): void;
  /** Starts an Agent with nothing running for what its hold kept. */
  wake(agentId: string): void;
  transport(): Pick<DaemonConnectionClient, "sendAgentCredentialRestored">;
}): CredentialInvalidHolds {
  const configOf = (agentId: string) => {
    const processes = input.processManager();
    return processes.restartConfig(agentId)?.config ?? processes.runtime(agentId)?.config;
  };
  const holds: CredentialInvalidHolds = new CredentialInvalidHolds({
    deliveryGate: input.deliveryGate,
    hold: (agentId) => input.errorHold().holdCredentialInvalid(agentId),
    runningAgentIds: () => input.processManager().runningAgentIds(),
    isRunning: (agentId) => input.processManager().isRunning(agentId),
    configOf,
    present: input.presentKept,
    wake: input.wake,
    notice: (agentId, text) => {
      // Only an idle Agent is shown it: a working one keeps showing its work.
      if (input.activityPublisher().lastBusy(agentId) || !input.processManager().session(agentId))
        return;
      input
        .activityPublisher()
        .publishCurrent(
          agentId,
          input.activity(agentId, AGENT_ACTIVITY_DETAIL_KIND.IDLE, "info", text ?? "Idle"),
        );
    },
    noticeText: (config, reason) =>
      credentialInvalidNoticeText(reason, {
        provider: config.provider,
        providerLabel: runtimeDisplayName(config.provider),
        model: config.model,
        agentProviderKey: config.providerConfig?.kind === "coforge",
      }),
    launchId: (agentId) => input.launches().get(agentId)?.launchId,
    restored: (report) =>
      void input
        .transport()
        .sendAgentCredentialRestored?.({
          protocolMajor: 1,
          requestId: crypto.randomUUID(),
          workspaceId: input.workspaceId(),
          ...report,
        })
        ?.catch(() => {}),
    disposed: () => watch.stop(),
  });
  const watch = new CredentialDiskWatch({
    ledger: holds.ledger,
    release: (key) => holds.credentialsChanged(key),
    baseEnv: () => process.env,
  });
  input.lifecycle.subscribe({
    stopped: (agentId) => holds.stopped(agentId),
    processClosed: (agentId) => holds.closed(agentId),
  });
  return holds;
}
