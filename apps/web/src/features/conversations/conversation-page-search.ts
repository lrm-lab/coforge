import { z } from "zod";

import {
  agentProfileTabParamSchema,
  profileParamSchema,
} from "#src/features/agents/profile-panel/profile-panel-search";
import { conversationTaskBoardSearchShape } from "#src/features/tasks/task-board-search";
import type { ConversationPageTarget } from "./conversation-page-loader";
import { CONVERSATION_TABS } from "./conversation-tabs";
import { openTaskParamSchema } from "./conversation-thread-search";

/**
 * A conversation page's address state wherever the page is shown: the tab, the Task board's view,
 * and what it has open (a thread, a Task popup, an Agent's or a person's profile).
 * Every host's `validateSearch` spreads it; Chat's routes add `message`, the one-shot jump, and a
 * page hosting a conversation beside its own content adds `hostedConversationSearchShape`.
 */
export const conversationPageSearchShape = {
  view: z.enum(CONVERSATION_TABS).optional().catch(undefined),
  ...conversationTaskBoardSearchShape,
  threadRootId: z.uuid().optional().catch(undefined),
  task: openTaskParamSchema,
  profile: profileParamSchema,
  agentTab: agentProfileTabParamSchema,
};

export type ConversationPageSearch = z.output<z.ZodObject<typeof conversationPageSearchShape>>;

/** Only a conversation page's own fields out of a host's address (a `useSearch` select). */
export function pickConversationPageSearch({
  view,
  status,
  layout,
  owners,
  completed,
  threadRootId,
  task,
  profile,
  agentTab,
}: ConversationPageSearch): ConversationPageSearch {
  // `satisfies` names every field of the shape: one added there must be picked here too.
  return {
    view,
    status,
    layout,
    owners,
    completed,
    threadRootId,
    task,
    profile,
    agentTab,
  } satisfies Record<keyof ConversationPageSearch, unknown>;
}

/**
 * Which conversation a page hosts beside its own content (`HostedConversationPane`): `open` names
 * it (`channel:<id>` or `dm:<id>`, or `thread:channel:<id>` / `thread:dm:<id>` for a pane that
 * shows only its open thread) and `msg` the message its stream lands on. Each field falls back to
 * absent when malformed, so a stale or hand-edited address never breaks the page.
 */
export const hostedConversationSearchShape = {
  open: z
    .string()
    .regex(/^(thread:)?(channel|dm):[0-9a-f-]{36}$/)
    .optional()
    .catch(undefined),
  msg: z.uuid().optional().catch(undefined),
};

/**
 * A hosted conversation: a channel or a direct conversation by its id, optionally at the message
 * its stream lands on, with a thread open (`threadRootId`) at one of its replies (`threadReplyId`).
 */
export type HostedConversationTarget = ConversationPageTarget & {
  messageId?: string;
  threadRootId?: string;
  /** The reply the open thread scrolls to. */
  threadReplyId?: string;
  /** The pane shows only the thread rooted at `messageId`, without the conversation around it. */
  threadAlone?: boolean;
  /** The Task, by its number, whose popup opens over the conversation. */
  task?: number;
};

/**
 * A hosted conversation's `open` param: `channel:<id>` or `dm:<id>`, prefixed `thread:` when the
 * pane shows only its thread.
 */
export function hostedConversationOpenParam(
  target: ConversationPageTarget & Pick<HostedConversationTarget, "threadAlone">,
): string {
  return `${target.threadAlone ? "thread:" : ""}${target.kind}:${target.id}`;
}

/** The hosted conversation an address names: `open` at message `msg`. */
export function parseHostedConversation(
  open: string | undefined,
  msg?: string,
): HostedConversationTarget | undefined {
  const threadAlone = open?.startsWith("thread:") || undefined;
  const [kind, id] = open?.replace(/^thread:/, "").split(":") ?? [];
  if ((kind !== "channel" && kind !== "dm") || !id) return undefined;
  return { kind, id, messageId: msg, threadAlone };
}

/** The URL hash that names a message: its row's element id, `message-<id>`. */
export function messageHash(messageId: string): string {
  return `message-${messageId}`;
}
