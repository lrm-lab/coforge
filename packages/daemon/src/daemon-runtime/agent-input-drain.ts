import { getLogger } from "@logtape/logtape";
import type { AgentSession } from "@coforge/agent";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { diagnosticErrorCode } from "@lrm/coforge-sdk/internal";
import { scrubRuntimeErrorText } from "@lrm/coforge-anvil";
import type { ActivityLaunch } from "./activity-launch";
import {
  queueHasInputContent,
  type AgentInput,
  type AgentInputCompletion,
  type AgentInputQueue,
  type AgentRecoveryContext,
} from "./runtime-launch-intent";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** The input drain's reach into the runtime: session and launch lookups, the guards that hold a
 * drain back, and the action each item kind performs. Queue custody itself never leaves. */
export type AgentInputDrainPorts = Readonly<{
  runnerHeld(): boolean;
  sessionFor(agentId: string): AgentSession | undefined;
  launchFor(agentId: string): ActivityLaunch | undefined;
  hasQueuedDeliveries(agentId: string): boolean;
  isLaunching(agentId: string): boolean;
  isStopping(agentId: string): boolean;
  deliverMessage(agentId: string, message: AgentMessageDelivery): Promise<void>;
  runStartup(
    agentId: string,
    session: AgentSession,
    launch: ActivityLaunch,
    text: string,
  ): Promise<void>;
  runPrompt(agentId: string, text: string, introduction?: true): Promise<void>;
  recoverAttention(agentId: string, context: AgentRecoveryContext): Promise<void>;
  abandonLaunch(agentId: string, error: unknown): Promise<unknown>;
  publishStartupError(agentId: string, launch: ActivityLaunch, message: string): void;
  forgetIntroduced(agentId: string): void;
  dropMention(message: AgentMessageDelivery): void;
}>;

/**
 * One serialized input queue per Agent. Enqueue is admission, drain is the only consumer, and a
 * closed queue rejects new items while letting its live drain settle. The runner hold is
 * enforced at drain start as well as at the caller: draining is what notifies the session and
 * then sends the `agent:deliver:ack`, so not draining is exactly "accepted locally, never
 * acked", and the server republishes after restart.
 */
export class AgentInputDrain {
  readonly #queues = new Map<string, AgentInputQueue>();

  constructor(private readonly ports: AgentInputDrainPorts) {}

  get(agentId: string): AgentInputQueue | undefined {
    return this.#queues.get(agentId);
  }

  /** Every queue, for stop-all and reconnect drain-all sweeps. Callers copy the keys they need —
   * a drain finishing mid-iteration may delete its own entry. */
  entries(): IterableIterator<[string, AgentInputQueue]> {
    return this.#queues.entries();
  }

  /** The live drain promises, for a settle-all wait. */
  drains(): Promise<void>[] {
    return [...this.#queues.values()].flatMap((queue) => (queue.drain ? [queue.drain] : []));
  }

  enqueue(
    agentId: string,
    create: (completion: AgentInputCompletion) => AgentInput,
  ): Promise<void> {
    const queue = this.#queues.get(agentId) ?? { items: [], closed: false };
    if (queue.closed) return Promise.reject(new Error(`Agent runtime is stopping: ${agentId}`));
    const completion = new Promise<void>((resolve, reject) => {
      queue.items.push(create({ resolve, reject }));
    });
    this.#queues.set(agentId, queue);
    return completion;
  }

  ensure(agentId: string): void {
    const queue = this.#queues.get(agentId);
    if (
      !queue ||
      queue.closed ||
      queue.drain ||
      this.ports.runnerHeld() ||
      !this.ports.sessionFor(agentId)
    )
      return;
    queue.drain = this.#drain(agentId, queue).finally(() => {
      queue.drain = undefined;
      if (queue.closed || !queue.items.length) {
        if (this.#queues.get(agentId) === queue) this.#queues.delete(agentId);
        return;
      }
      this.ensure(agentId);
    });
  }

  async #drain(agentId: string, queue: AgentInputQueue): Promise<void> {
    while (!queue.closed) {
      const item = queue.items.shift();
      if (!item) return;
      const responses = this.ports.launchFor(agentId)?.startup?.responses ?? 0;
      try {
        if (
          item.kind === "startup" &&
          (queueHasInputContent(queue.items) ||
            this.ports.hasQueuedDeliveries(agentId) ||
            this.ports.sessionFor(agentId)?.hasLiveTurn === true)
        ) {
          item.completion.resolve();
          continue;
        }
        if (item.kind === "delivery") {
          await this.ports.deliverMessage(agentId, item.message);
          logger.info("Agent delivery indexed", {
            event: "agent.message.delivery_indexed",
            agent_id: agentId,
            delivery_id: item.message.deliveryId,
            message_id: item.message.messageId,
            target: item.message.target,
            sequence: item.message.sequence,
          });
        } else if (item.kind === "startup") {
          const session = this.ports.sessionFor(agentId);
          const launch = this.ports.launchFor(agentId);
          // Release the queue at real readiness if this provider awaits the whole turn.
          if (session && launch) await this.ports.runStartup(agentId, session, launch, item.text);
        } else if (item.kind === "prompt") {
          await this.ports.runPrompt(agentId, item.text, item.introduction);
        } else await this.ports.recoverAttention(agentId, item.context);
      } catch (error) {
        if (
          (item.kind === "recovery" || item.kind === "startup") &&
          this.ports.isLaunching(agentId)
        ) {
          if (this.ports.isStopping(agentId)) {
            item.completion.reject(error);
            return;
          }
          const launch = this.ports.launchFor(agentId);
          if (launch?.startup && !launch.startup.endsLaunch(error, responses)) {
            // The model already answered this input: the launch stands, like a refused prompt.
            logger.warn("Agent startup input was not accepted", {
              event: "agent.startup_input.rejected",
              agent_id: agentId,
              input_kind: item.kind,
              error_code: diagnosticErrorCode(error),
            });
            item.completion.resolve();
            continue;
          }
          if (item.kind === "startup" && launch && !launch.startup?.errorObserved)
            this.ports.publishStartupError(
              agentId,
              launch,
              scrubRuntimeErrorText(
                error instanceof Error ? error.message : "Agent startup input was rejected",
              ),
            );
          item.completion.reject(await this.ports.abandonLaunch(agentId, error));
          return;
        }
        if (item.kind === "delivery") {
          item.completion.reject(error);
          continue;
        }
        if (item.kind === "prompt") {
          // The launch stands: a provider that refuses input handles it as any refused input.
          logger.warn("Agent prompt turn was not accepted", {
            event: "agent.prompt_turn.rejected",
            agent_id: agentId,
            error_code: diagnosticErrorCode(error),
          });
          item.completion.reject(error);
          continue;
        }
      }
      item.completion.resolve();
    }
  }

  close(agentId: string, error: unknown): void {
    this.ports.forgetIntroduced(agentId);
    const queue = this.#queues.get(agentId);
    if (!queue) return;
    queue.closed = true;
    for (const item of queue.items.splice(0)) {
      if (item.kind === "delivery") this.ports.dropMention(item.message);
      item.completion.reject(error);
    }
    if (!queue.drain) this.#queues.delete(agentId);
  }
}
