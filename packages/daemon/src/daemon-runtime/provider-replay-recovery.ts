import { getLogger } from "@logtape/logtape";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { thrownMessage, type AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import type { MessageAttention } from "./agent-message-attention-index";
import type { LaunchRequest } from "./runtime-launch-types";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/**
 * A stored native Session the provider refuses to replay (Codex's encrypted reasoning no longer
 * decrypts after the backend or key changed, openai/codex#17541) fails every later turn the same
 * way until a person resets it. The adapter says so on the failed turn's `error` event
 * (`sessionRecovery`); once that turn has ended, the daemon invalidates the Session and
 * cold-starts a fresh one in its place.
 *
 * One launch's watch. A launch that resumed a stored Session replaces it at most once: `settle`
 * spends the watch only when the Session was replaced, so a recovery that did not proceed (the
 * process would not exit, a guard declined) leaves it armed for the next rejected turn. A launch
 * that did not resume one never acts, and a fresh Session that fails the same way is left to the
 * ordinary runtime-error path, so the recovery cannot loop.
 */
export class ProviderReplayWatch {
  #rejected = false;
  #attempting = false;
  #stored: string | undefined;

  /** The stored Session this launch continued, or undefined where there is none to replace: a
   * Session the launch created, recycled or had replaced (the provider replaced it, or reported
   * another id than the one asked for), and a Memory Agent's conversation-scoped ones. */
  constructor(
    resumedSessionId: string | undefined,
    exclude: Readonly<{
      memoryAgent: boolean;
      replacedSessionId: string | undefined;
      reportedSessionId: string | undefined;
    }>,
  ) {
    const replaced =
      exclude.replacedSessionId !== undefined ||
      (exclude.reportedSessionId !== undefined && exclude.reportedSessionId !== resumedSessionId);
    this.#stored = exclude.memoryAgent || replaced ? undefined : resumedSessionId;
  }

  /** Acts on one event of the launch: once the turn whose replay was rejected has ended, `replace`
   * ends the runtime and cold-starts a fresh Session with the stored one's id, and says whether it
   * did. A failure of `replace` is logged and leaves the watch armed. */
  observe(
    event: AgentRuntimeEvent,
    agentId: string,
    replace: (storedSessionId: string) => Promise<boolean>,
  ): void {
    if (this.#stored === undefined || this.#attempting) return;
    if (event.type === "error" && event.sessionRecovery === "provider_replay_rejected")
      this.#rejected = true;
    if (event.type !== "completed" || !this.#rejected) return;
    this.#rejected = false;
    this.#attempting = true;
    const stored = this.#stored;
    replace(stored).then(
      (replaced) => this.#settle(replaced),
      (error: unknown) => {
        this.#settle(false);
        logger.error("Replacing a Session the provider rejected failed", {
          event: "agent.runtime.replay_rejected_recovery_failed",
          agent_id: agentId,
          error: thrownMessage(error),
        });
      },
    );
  }

  /** The attempt ended; only a replaced Session spends the watch. */
  #settle(replaced: boolean): void {
    this.#attempting = false;
    if (replaced) this.#stored = undefined;
  }
}

/** What a launch was started with and a cold start must not lose. */
export type CarriedStart = Pick<LaunchRequest, "recovery" | "resumePrompt" | "introductionPrompt">;

/**
 * What the fresh Session is told: what the rejected launch was started with (a Start's recovery,
 * its resume or introduction prompt, which the Agent never got to act on) and the targets whose
 * messages reached the Agent and were never read, plus the `parked` deliveries that arrived while
 * the runtime was ending, folded into one `unreadSummary`. A server Start carries the same
 * `unreadSummary`. `check()` counts, not `unreadDeliveries()`: that one leaves out messages a
 * notice previewed in full, and a fresh Session holds none of those previews. A Start's
 * summary-only targets were never in `check()` (only recovered messages are), so the counts add.
 */
export function carriedStart(
  started: CarriedStart,
  attention: readonly Pick<MessageAttention, "target" | "pendingCount">[],
  parked: readonly Pick<AgentMessageDelivery, "target">[] = [],
): CarriedStart {
  const counts = new Map<string, number>();
  const add = (target: string | undefined, count: number) => {
    if (target && count > 0) counts.set(target, (counts.get(target) ?? 0) + count);
  };
  for (const [target, count] of Object.entries(started.recovery?.unreadSummary ?? {}))
    add(target, count);
  for (const { target, pendingCount } of attention) add(target, pendingCount);
  for (const { target } of parked) add(target, 1);
  const { recovery, resumePrompt, introductionPrompt } = started;
  return {
    ...(recovery || counts.size
      ? { recovery: { ...recovery, unreadSummary: Object.fromEntries(counts) } }
      : {}),
    ...(resumePrompt !== undefined ? { resumePrompt } : {}),
    ...(introductionPrompt !== undefined ? { introductionPrompt } : {}),
  };
}
