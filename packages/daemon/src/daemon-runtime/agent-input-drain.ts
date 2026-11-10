import { getLogger } from "@logtape/logtape";
import type { AgentSession } from "@coforge/agent";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { diagnosticErrorCode } from "@lrm/coforge-sdk/internal";
import { scrubRuntimeErrorText } from "@lrm/coforge-anvil";
import type { ActivityLaunch } from "./activity-launch";
import { LaunchInboxes } from "./launch-inbox";
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
  /** Whether tracked mentions are kept for the Agent's next launch. */
  hasCarried(agentId: string): boolean;
  /** Tells the tracked mentions kept for the Agent's launch in one notice with the deliveries held
   * `alongside` them. */
  tellCarried(agentId: string, alongside: readonly AgentMessageDelivery[]): Promise<void>;
  /** Presents what the Agent's launch kept: the deliveries held for it and the tracked mentions,
   * in one notice. */
  presentKept(agentId: string): Promise<void>;
}>;

/**
 * One serialized input queue per Agent. Enqueue is admission, drain is the only consumer, and a
 * closed queue rejects new items while letting its live drain settle. The runner hold is
 * enforced at drain start as well as at the caller: draining is what notifies the session and
 * then sends the `agent:deliver:ack`, so not draining is exactly "accepted locally, never
 * acked", and the server republishes after restart.
 */
export class AgentInputDrain {
  /** Drains of retired queues, still finishing the item they were on. */
  readonly #retired = new Set<Promise<void>>();

  /** The queues live in the Agents' inboxes. */
  constructor(
    private readonly ports: AgentInputDrainPorts,
    private readonly inboxes = new LaunchInboxes(),
  ) {}

  /** A launch for the Agent is in flight. */
  isLaunching(agentId: string): boolean {
    return this.ports.isLaunching(agentId);
  }

  get(agentId: string): AgentInputQueue | undefined {
    return this.inboxes.peek(agentId)?.input;
  }

  /** Every queue, for stop-all and reconnect drain-all sweeps. Callers copy the keys they need —
   * a drain finishing mid-iteration may delete its own entry. */
  entries(): [string, AgentInputQueue][] {
    return this.inboxes.inputs();
  }

  /** The live drain promises, for a settle-all wait. */
  drains(): Promise<void>[] {
    return [
      ...this.inboxes.inputs().flatMap(([, queue]) => (queue.drain ? [queue.drain] : [])),
      ...this.#retired,
    ];
  }

  /**
   * A new launch begins for this Agent: a queue's drain belongs to the runtime it was armed for, so
   * the one running now finishes the item it is on and exits, and the launch gets a queue of its
   * own, armed by `ensure` once the launch succeeds. Otherwise that loop would go on to the launch's
   * own inputs while the process they are for is not up, and run them against the dying one.
   *
   * What the ended runtime's loop left waiting is its own: the deliveries go to `keep` (custody for
   * the next launch), and so does one the retired loop fails on. A queue with no loop running was
   * filled for the launch now beginning (a wake queues its delivery first), so its deliveries stay.
   * The prompts waiting and those deliveries are returned for `carry`. The rest (startup, memory,
   * recovery) belonged to the ended session, and the new launch brings its own: they are settled.
   */
  retire(agentId: string, keep: (messages: AgentMessageDelivery[]) => void): AgentInput[] {
    const queue = this.get(agentId);
    if (!queue) return [];
    this.#delete(agentId);
    const ended = queue.drain !== undefined;
    const waiting: AgentMessageDelivery[] = [];
    const carried: AgentInput[] = [];
    for (const item of queue.items) {
      if (item.kind === "prompt" || (item.kind === "delivery" && !ended)) carried.push(item);
      else {
        if (item.kind === "delivery") waiting.push(item.message);
        item.completion.resolve();
      }
    }
    if (waiting.length) keep(waiting);
    queue.items = [];
    queue.closed = true;
    if (ended) queue.keep = (message) => keep([message]);
    const drain = queue.drain;
    if (drain) {
      this.#retired.add(drain);
      const done = () => void this.#retired.delete(drain);
      drain.then(done, done);
    }
    return carried;
  }

  /** Puts what `retire` returned at the front of the launch's queue, ahead of its own input: an
   * introduction always (a process gets at most one, and the one queued when a process ends is its
   * relaunch's), a resume prompt only when the launch carries none of its own. */
  carry(agentId: string, items: readonly AgentInput[], ownResumePrompt: boolean): void {
    const carried = items.filter(
      (item) => item.kind !== "prompt" || item.introduction || !ownResumePrompt,
    );
    for (const item of items) if (!carried.includes(item)) item.completion.resolve();
    if (carried.length) this.inboxes.of(agentId).input = { items: [...carried], closed: false };
  }

  enqueue(
    agentId: string,
    create: (completion: AgentInputCompletion) => AgentInput,
  ): Promise<void> {
    const queue = this.get(agentId) ?? { items: [], closed: false };
    if (queue.closed) return Promise.reject(new Error(`Agent runtime is stopping: ${agentId}`));
    const completion = new Promise<void>((resolve, reject) => {
      queue.items.push(create({ resolve, reject }));
    });
    this.inboxes.of(agentId).input = queue;
    return completion;
  }

  /** Delivery-kind messages still waiting in this Agent's queue (no removal). */
  queuedDeliveries(agentId: string): AgentMessageDelivery[] {
    return (
      this.get(agentId)?.items.flatMap((item) =>
        item.kind === "delivery" ? [item.message] : [],
      ) ?? []
    );
  }

  /** Removes and returns the delivery-kind items still waiting, resolving each kept item's
   * completion — they are kept for the next launch, not failed. */
  drainDeliveries(agentId: string): AgentMessageDelivery[] {
    const queue = this.get(agentId);
    const kept: AgentMessageDelivery[] = [];
    if (!queue) return kept;
    queue.items = queue.items.filter((item) => {
      if (item.kind !== "delivery") return true;
      item.completion.resolve();
      kept.push(item.message);
      return false;
    });
    return kept;
  }

  /** Settles the delivery-kind items waiting in this Agent's queue that `settle` takes. */
  dropDeliveries(agentId: string, settle: (message: AgentMessageDelivery) => boolean): void {
    this.inboxes.peek(agentId)?.dropInputDeliveries(settle);
  }

  /** Puts an input at the front of this Agent's queue, creating it if no input is pending. */
  prepend(
    agentId: string,
    create: (completion: AgentInputCompletion) => AgentInput,
  ): Promise<void> {
    const queue = this.get(agentId) ?? { items: [], closed: false };
    if (queue.closed) return Promise.reject(new Error(`Agent runtime is stopping: ${agentId}`));
    const completion = new Promise<void>((resolve, reject) => {
      queue.items.unshift(create({ resolve, reject }));
    });
    this.inboxes.of(agentId).input = queue;
    return completion;
  }

  /** Tells the mentions kept for the Agent's launch with `held`, the deliveries held for it, in
   * one notice: how a launch presents what it kept. */
  tellCarried(agentId: string, held: readonly AgentMessageDelivery[]): Promise<void> {
    return this.ports.tellCarried(agentId, held);
  }

  ensure(agentId: string): void {
    if (this.ports.runnerHeld() || !this.ports.sessionFor(agentId)) return;
    // Behind the launch's own input: what an earlier process left for this one. The launch's
    // recovery pass tells them too when it runs first, and this finds nothing left to tell.
    if (
      this.ports.hasCarried(agentId) &&
      !this.get(agentId)?.items.some((i) => i.kind === "carried")
    )
      void this.enqueue(agentId, (completion) => ({ kind: "carried", completion })).catch(() => {});
    const queue = this.get(agentId);
    if (!queue || queue.closed || queue.drain) return;
    queue.drain = this.#drain(agentId, queue).finally(() => {
      queue.drain = undefined;
      if (queue.closed || !queue.items.length) {
        if (this.get(agentId) === queue) this.#delete(agentId);
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
        } else if (item.kind === "carried") {
          await this.ports.presentKept(agentId);
        } else if (item.kind === "startup") {
          const session = this.ports.sessionFor(agentId);
          const launch = this.ports.launchFor(agentId);
          // Release the queue at real readiness if this provider awaits the whole turn.
          if (session && launch) await this.ports.runStartup(agentId, session, launch, item.text);
        } else if (item.kind === "prompt") {
          await this.ports.runPrompt(agentId, item.text, item.introduction);
        } else if (item.kind === "memory") {
          // Context, not a request: it opens a turn of its own ahead of the real input.
          if (this.ports.sessionFor(agentId)) await this.ports.runPrompt(agentId, item.text);
        } else {
          await this.ports.recoverAttention(agentId, item.context);
          item.told?.();
        }
      } catch (error) {
        // A retired queue belongs to a runtime that ended: its failures never consult the launch
        // that replaced it.
        if (queue.keep) {
          if (item.kind === "delivery") {
            queue.keep(item.message);
            item.completion.resolve();
          } else item.completion.reject(error);
          continue;
        }
        if (
          (item.kind === "recovery" || item.kind === "startup" || item.kind === "memory") &&
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

  /** Rejects what waits in the queue and closes it. A queued tracked mention is refused, unless
   * `forgetMentions` says a Stop is ending the Agent: the cloud settles those, so none is reported. */
  close(agentId: string, error: unknown, { forgetMentions = false } = {}): void {
    this.ports.forgetIntroduced(agentId);
    const queue = this.get(agentId);
    if (!queue) return;
    queue.closed = true;
    for (const item of queue.items.splice(0)) {
      if (item.kind === "delivery" && !forgetMentions) this.ports.dropMention(item.message);
      item.completion.reject(error);
    }
    if (!queue.drain) this.#delete(agentId);
  }

  #delete(agentId: string): void {
    const inbox = this.inboxes.peek(agentId);
    if (inbox) inbox.input = undefined;
    this.inboxes.tidy(agentId);
  }
}
