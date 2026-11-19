import { getLogger } from "@logtape/logtape";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { thrownMessage, type AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import type { MessageAttention } from "./agent-message-attention-index";
import type { AgentRecoveryContext } from "./runtime-launch-intent";
import { LaunchInboxes } from "./launch-inbox";
import type { LaunchRequest } from "./runtime-launch-types";
const logger = getLogger(["coforge", "daemon", "runtime"]);
export class ProviderReplayWatch {
  #rejected = false;
  #attempting = false;
  #stored: string | undefined;
  constructor(
    resumedSessionId: string | undefined,
    exclude: Readonly<{
      replacedSessionId: string | undefined;
      reportedSessionId: string | undefined;
    }>,
  ) {
    const replaced =
      exclude.replacedSessionId !== undefined ||
      (exclude.reportedSessionId !== undefined && exclude.reportedSessionId !== resumedSessionId);
    this.#stored = replaced ? undefined : resumedSessionId;
  }
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
  #settle(replaced: boolean): void {
    this.#attempting = false;
    if (replaced) this.#stored = undefined;
  }
}
export type CarriedStart = Pick<LaunchRequest, "recovery" | "resumePrompt" | "introductionPrompt">;
export function newlyParked<T extends Pick<AgentMessageDelivery, "deliveryId">>(
  parked: readonly T[],
  heldBefore: ReadonlySet<string>,
): T[] {
  return parked.filter(({ deliveryId }) => !heldBefore.has(deliveryId));
}
const carriedOf = ({ recovery, resumePrompt, introductionPrompt }: CarriedStart): CarriedStart => ({
  ...(recovery ? { recovery } : {}),
  ...(resumePrompt !== undefined ? { resumePrompt } : {}),
  ...(introductionPrompt !== undefined ? { introductionPrompt } : {}),
});
export function carriedStart(
  started: CarriedStart,
  attention: readonly Pick<MessageAttention, "target" | "pendingCount">[],
  parked: readonly Pick<AgentMessageDelivery, "target">[] = [],
  carried: ReadonlyMap<string, number> = new Map(),
): CarriedStart {
  const counts = new Map<string, number>();
  const add = (target: string | undefined, count: number) => {
    if (target && count > 0) counts.set(target, (counts.get(target) ?? 0) + count);
  };
  for (const [target, count] of Object.entries(started.recovery?.unreadSummary ?? {}))
    add(target, count);
  for (const { target, pendingCount } of attention)
    add(target, pendingCount - (carried.get(target) ?? 0));
  for (const { target } of parked) add(target, 1);
  const { recovery } = started;
  return carriedOf({
    ...started,
    ...(recovery || counts.size
      ? { recovery: { ...recovery, unreadSummary: Object.fromEntries(counts) } }
      : {}),
  });
}
export function mergeCarried(own: CarriedStart, owed: CarriedStart): CarriedStart {
  const a = own.recovery;
  const b = owed.recovery;
  const summary: Record<string, number> = { ...b?.unreadSummary };
  for (const [target, count] of Object.entries(a?.unreadSummary ?? {}))
    summary[target] = Math.max(summary[target] ?? 0, count);
  const wakeMessage = a?.wakeMessage ?? b?.wakeMessage;
  const ownIds = new Set(a?.resumeMessages?.map(({ deliveryId }) => deliveryId));
  const resumeMessages = [
    ...(a?.resumeMessages ?? []),
    ...(b?.resumeMessages ?? []).filter(({ deliveryId }) => !ownIds.has(deliveryId)),
  ];
  const conversationIds = { ...b?.unreadConversationIds, ...a?.unreadConversationIds };
  const openTasks = a?.openTasks ?? b?.openTasks;
  const recovery: AgentRecoveryContext = {
    ...(wakeMessage ? { wakeMessage } : {}),
    ...(resumeMessages.length ? { resumeMessages } : {}),
    ...(Object.keys(summary).length ? { unreadSummary: summary } : {}),
    ...(Object.keys(conversationIds).length ? { unreadConversationIds: conversationIds } : {}),
    ...(openTasks ? { openTasks } : {}),
  };
  return carriedOf({
    ...(a || b ? { recovery } : {}),
    resumePrompt: own.resumePrompt ?? owed.resumePrompt,
    introductionPrompt: own.introductionPrompt ?? owed.introductionPrompt,
  });
}
export function withOwed(
  request: LaunchRequest,
  startRecovery: AgentRecoveryContext | undefined,
  owed: CarriedStart | undefined,
): LaunchRequest {
  const own = startRecovery ? { ...request, recovery: startRecovery } : request;
  return owed ? { ...own, ...mergeCarried(own, owed) } : own;
}
export class OwedRecovery {
  constructor(private readonly inboxes = new LaunchInboxes()) {}
  owe(agentId: string, carried: CarriedStart): void {
    const inbox = this.inboxes.of(agentId);
    inbox.owed = inbox.owed ? mergeCarried(carried, inbox.owed) : carried;
  }
  owing(
    agentId: string,
    queued: readonly Pick<AgentMessageDelivery, "target">[],
  ):
    | {
        carried: CarriedStart;
        paid(): void;
      }
    | undefined {
    const owed = this.inboxes.peek(agentId)?.owed;
    if (!owed) return undefined;
    return {
      carried: carriedStart(owed, [], queued),
      paid: () => {
        if (this.inboxes.peek(agentId)?.owed === owed) this.inboxes.dropOwed(agentId);
      },
    };
  }
  drop(agentId: string): void {
    this.inboxes.dropOwed(agentId);
  }
  clear(): void {
    this.inboxes.clearOwed();
  }
}
