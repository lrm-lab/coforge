import { REPLY_INTENT_PHASE } from "@lrm/coforge-sdk/internal/reply-intent";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { ReplyIntentTracker, type ReplyIntentSignal } from "./reply-intent-tracker";

export type ReplyIntentPublisherPorts<L extends { stopping: boolean }> = Readonly<{
  /** The Agent's current launch; a start for any other launch is dropped. */
  currentLaunch(agentId: string): L | undefined;
  /** The current transport, read at each publish. */
  transport(): Pick<DaemonConnectionClient, "sendAgentReplyIntent">;
  workspaceId(): string;
  /** Whether the runtime is up: no start is published before it started or after it stopped. */
  active(): boolean;
}>;

/**
 * Publishes a launch's "about to post" signals (docs/observability/reply-intent.md) on the Agent
 * Activity channel. They are no Activity: no launch sequence, never remembered as busy evidence,
 * never a heartbeat. A start needs a running runtime and the Agent's current launch, and a
 * stopping launch announces no new one; an end only tears down, so it is always sent.
 */
export class ReplyIntentPublisher<L extends { stopping: boolean }> {
  readonly #ports: ReplyIntentPublisherPorts<L>;

  constructor(ports: ReplyIntentPublisherPorts<L>) {
    this.#ports = ports;
  }

  /** A launch's tracker: feed it the launch's runtime events and dispose it with the launch. */
  tracker(agentId: string, launch: L): ReplyIntentTracker {
    return new ReplyIntentTracker({ emit: (signal) => this.#publish(agentId, launch, signal) });
  }

  #publish(agentId: string, launch: L, signal: ReplyIntentSignal): void {
    if (
      signal.phase === REPLY_INTENT_PHASE.START &&
      (!this.#ports.active() || launch.stopping || this.#ports.currentLaunch(agentId) !== launch)
    )
      return;
    this.#ports.transport().sendAgentReplyIntent?.({
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceId: this.#ports.workspaceId(),
      agentId,
      observedAtMs: Date.now(),
      intent: signal,
    });
  }
}
