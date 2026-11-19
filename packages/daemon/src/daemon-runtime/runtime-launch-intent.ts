import type { AgentRuntimeConfig } from "@coforge/agent";
import type {
  AgentConfigSync,
  AgentMessageDelivery,
  AgentStartIntent,
  AgentStartOpenTasks,
} from "@lrm/coforge-sdk/internal";
import type { RestartRuntimeFields } from "#src/agent-runtime/agent-process-manager";
export type AgentInputCompletion = {
  resolve: () => void;
  reject: (error: unknown) => void;
};
export type AgentRecoveryContext = Pick<
  AgentStartIntent,
  "wakeMessage" | "resumeMessages" | "unreadSummary" | "unreadConversationIds" | "openTasks"
> & {
  summaryIncludesResumeMessages?: true;
  countedDeliveries?: readonly AgentMessageDelivery[];
};
export function recoveryHasContent(context: AgentRecoveryContext | undefined): boolean {
  return Boolean(
    context &&
    (context.wakeMessage ||
      context.resumeMessages?.length ||
      Object.keys(context.unreadSummary ?? {}).length),
  );
}
export type AgentInput =
  | {
      kind: "recovery";
      context: AgentRecoveryContext;
      completion: AgentInputCompletion;
      recovered?: (told: boolean) => void;
    }
  | {
      kind: "delivery";
      message: AgentMessageDelivery;
      completion: AgentInputCompletion;
    }
  | {
      kind: "carried";
      completion: AgentInputCompletion;
    }
  | {
      kind: "startup";
      text: string;
      openTasks?: AgentStartOpenTasks;
      completion: AgentInputCompletion;
    }
  | {
      kind: "prompt";
      text: string;
      introduction?: true;
      completion: AgentInputCompletion;
    }
  | {
      kind: "memory";
      text: string;
      completion: AgentInputCompletion;
    };
export function queueHasInputContent(items: readonly AgentInput[]): boolean {
  return items.some(
    (item) =>
      item.kind === "delivery" ||
      item.kind === "carried" ||
      item.kind === "prompt" ||
      item.kind === "memory" ||
      (item.kind === "recovery" && recoveryHasContent(item.context)),
  );
}
export type AgentInputQueue = {
  items: AgentInput[];
  drain?: Promise<void>;
  closed: boolean;
  keep?: (message: AgentMessageDelivery) => void;
};
export function runtimeFieldsOf(
  intent: Pick<AgentStartIntent | AgentConfigSync, keyof RestartRuntimeFields>,
): RestartRuntimeFields {
  return {
    provider: intent.provider,
    model: intent.model,
    reasoning: intent.reasoning,
    ...(intent.modelProvider !== undefined ? { modelProvider: intent.modelProvider } : {}),
    ...(intent.providerConfig !== undefined ? { providerConfig: intent.providerConfig } : {}),
    ...(intent.fastMode ? { fastMode: true } : {}),
    ...(intent.contextWindow !== undefined ? { contextWindow: intent.contextWindow } : {}),
    ...(intent.maxOutputTokens !== undefined ? { maxOutputTokens: intent.maxOutputTokens } : {}),
  };
}
export function runtimeConfigOf(intent: AgentStartIntent): AgentRuntimeConfig {
  return {
    ...runtimeFieldsOf(intent),
  };
}
export function recoveryOf(intent: AgentStartIntent): AgentRecoveryContext {
  return {
    wakeMessage: intent.wakeMessage,
    resumeMessages: intent.resumeMessages,
    unreadSummary: intent.unreadSummary,
    unreadConversationIds: intent.unreadConversationIds,
    openTasks: intent.openTasks,
    summaryIncludesResumeMessages: true,
  };
}
