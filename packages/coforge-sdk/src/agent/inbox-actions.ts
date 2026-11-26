import { z } from "zod";

export type AgentInboxReadTargetKind = "conversation" | "thread" | "app_events" | "reminders";

export type AgentInboxReadMessageItem = {
  kind: "message";
  id: string;
  seq: number;
  sender: string;
  createdAt: string;
  body: string;
  mentionsAgent?: boolean;
};

export type AgentInboxReadReminderItem = {
  kind: "reminder";
  id: string;
  title: string;
  target: string;
  messageId: string;
  fireAt: string;
  status: string;
  version: number;
  repeat: string | null;
  timezone: string | null;
};

export type AgentInboxReadItem = AgentInboxReadMessageItem | AgentInboxReadReminderItem;

export type AgentInboxReadRequest = {
  target: string;
  limit?: number;
  cursor?: string;
};

export type AgentInboxReadResponse = {
  ok: true;
  kind: AgentInboxReadTargetKind;
  target: string;
  items: AgentInboxReadItem[];
  hasMore: boolean;
  nextCursor: string | null;
  readPositionAfter?: number;
};

export type AgentInboxDismissRequest = {
  target?: string;
  before?: string;
};

export type AgentInboxDismissResponse = {
  ok: true;
  mode: "target" | "before";
  dismissedConversations: number;
  dismissedThreads: number;
  dismissedAppTargets: number;
  dismissedReminders: number;
  targets: string[];
};

export type AgentActionWithdrawRequest = {
  messageId: string;
};

export type AgentActionWithdrawResponse = {
  ok: true;
  messageId: string;
  state: "cancelled";
  alreadyWithdrawn?: boolean;
};

const readTargetKindSchema = z.enum(["conversation", "thread", "app_events", "reminders"]);

const readMessageItemSchema = z.object({
  kind: z.literal("message"),
  id: z.string(),
  seq: z.number(),
  sender: z.string(),
  createdAt: z.string(),
  body: z.string(),
  mentionsAgent: z.boolean().optional().catch(undefined),
});

const readReminderItemSchema = z.object({
  kind: z.literal("reminder"),
  id: z.string(),
  title: z.string(),
  target: z.string(),
  messageId: z.string(),
  fireAt: z.string(),
  status: z.string(),
  version: z.number(),
  repeat: z.string().nullable().catch(null),
  timezone: z.string().nullable().catch(null),
});

const readItemSchema = z.discriminatedUnion("kind", [
  readMessageItemSchema,
  readReminderItemSchema,
]);

const inboxReadEnvelopeSchema = z.object({
  ok: z.literal(true),
  kind: readTargetKindSchema,
  target: z.string(),
  items: z.array(z.unknown()),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  readPositionAfter: z.number().optional().catch(undefined),
});

const inboxDismissResponseSchema = z.object({
  ok: z.literal(true),
  mode: z.enum(["target", "before"]),
  dismissedConversations: z.number(),
  dismissedThreads: z.number(),
  dismissedAppTargets: z.number(),
  dismissedReminders: z.number(),
  targets: z.array(z.string()),
});

const actionWithdrawResponseSchema = z.object({
  ok: z.literal(true),
  messageId: z.string(),
  state: z.literal("cancelled"),
  alreadyWithdrawn: z.boolean().optional().catch(undefined),
});

function decodeReadItem(raw: unknown): AgentInboxReadItem | undefined {
  const parsed = readItemSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const item = parsed.data;
  if (item.kind === "message") {
    const { mentionsAgent, ...rest } = item;
    return mentionsAgent === undefined ? rest : { ...rest, mentionsAgent };
  }
  return item;
}

export function decodeAgentInboxReadResponse(value: unknown): AgentInboxReadResponse {
  const envelope = inboxReadEnvelopeSchema.safeParse(value);
  if (!envelope.success) throw new Error("Invalid inbox read response");
  const items: AgentInboxReadItem[] = [];
  for (const entry of envelope.data.items) {
    const item = decodeReadItem(entry);
    if (!item) throw new Error("Invalid inbox read item in response");
    items.push(item);
  }
  const { readPositionAfter, items: _rawItems, ...rest } = envelope.data;
  return {
    ...rest,
    items,
    ...(readPositionAfter !== undefined ? { readPositionAfter } : {}),
  };
}

export function decodeAgentInboxDismissResponse(value: unknown): AgentInboxDismissResponse {
  const parsed = inboxDismissResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid inbox dismiss response");
  return parsed.data;
}

export function decodeAgentActionWithdrawResponse(value: unknown): AgentActionWithdrawResponse {
  const parsed = actionWithdrawResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid action withdraw response");
  const { alreadyWithdrawn, ...rest } = parsed.data;
  return alreadyWithdrawn === undefined ? rest : { ...rest, alreadyWithdrawn };
}
