import type { AgentRuntimeConfig } from "@coforge/agent";
import type { AgentMessageDelivery, AgentStartIntent } from "@lrm/coforge-sdk/internal";

export type AgentInputCompletion = {
  resolve: () => void;
  reject: (error: unknown) => void;
};

export type AgentRecoveryContext = Pick<
  AgentStartIntent,
  "wakeMessage" | "resumeMessages" | "unreadSummary" | "unreadConversationIds"
>;

/** Whether a recovery context has anything concrete to deliver. `recoveryOf(intent)` always
 * returns an object, even for a launch with no wake message, resume messages, or unread summary,
 * so callers cannot tell "nothing to recover" from "recovery was requested" by presence alone —
 * this is the same check `#recoverAttention` uses to skip an empty context. */
export function recoveryHasContent(context: AgentRecoveryContext | undefined): boolean {
  return Boolean(
    context &&
    (context.wakeMessage ||
      context.resumeMessages?.length ||
      Object.keys(context.unreadSummary ?? {}).length),
  );
}

export type AgentInput =
  | { kind: "recovery"; context: AgentRecoveryContext; completion: AgentInputCompletion }
  | { kind: "delivery"; message: AgentMessageDelivery; completion: AgentInputCompletion }
  | { kind: "startup"; text: string; completion: AgentInputCompletion }
  | { kind: "prompt"; text: string; introduction?: true; completion: AgentInputCompletion };

/** Whether any queued input has something to say, so the startup starter has nothing to add:
 * the input drain skips the starter when this holds for the inputs behind it. */
export function queueHasInputContent(items: readonly AgentInput[]): boolean {
  return items.some(
    (item) =>
      item.kind === "delivery" ||
      item.kind === "prompt" ||
      (item.kind === "recovery" && recoveryHasContent(item.context)),
  );
}

export type AgentInputQueue = {
  items: AgentInput[];
  drain?: Promise<void>;
  closed: boolean;
};

/** The daemon's launch config from the versioned start intent; absent `fastMode` means the
 * ordinary service tier. */
export function runtimeConfigOf(intent: AgentStartIntent): AgentRuntimeConfig {
  return {
    provider: intent.provider,
    model: intent.model,
    modelProvider: intent.modelProvider,
    reasoning: intent.reasoning,
    providerConfig: intent.providerConfig,
    toolProfile: intent.toolProfile,
    ...(intent.memoryAgent ? { memoryAgent: true } : {}),
    ...(intent.fastMode ? { fastMode: true } : {}),
  };
}

export function recoveryOf(intent: AgentStartIntent): AgentRecoveryContext {
  return {
    wakeMessage: intent.wakeMessage,
    resumeMessages: intent.resumeMessages,
    unreadSummary: intent.unreadSummary,
    unreadConversationIds: intent.unreadConversationIds,
  };
}
