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

const READ_KINDS = new Set<string>(["conversation", "thread", "app_events", "reminders"]);

function decodeReadItem(raw: unknown): AgentInboxReadItem | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as Record<string, unknown>;
  if (item.kind === "message") {
    if (
      typeof item.id !== "string" ||
      typeof item.seq !== "number" ||
      typeof item.sender !== "string" ||
      typeof item.createdAt !== "string" ||
      typeof item.body !== "string"
    )
      return undefined;
    return {
      kind: "message",
      id: item.id,
      seq: item.seq,
      sender: item.sender,
      createdAt: item.createdAt,
      body: item.body,
      ...(typeof item.mentionsAgent === "boolean" ? { mentionsAgent: item.mentionsAgent } : {}),
    };
  }
  if (item.kind === "reminder") {
    if (
      typeof item.id !== "string" ||
      typeof item.title !== "string" ||
      typeof item.target !== "string" ||
      typeof item.messageId !== "string" ||
      typeof item.fireAt !== "string" ||
      typeof item.status !== "string" ||
      typeof item.version !== "number"
    )
      return undefined;
    return {
      kind: "reminder",
      id: item.id,
      title: item.title,
      target: item.target,
      messageId: item.messageId,
      fireAt: item.fireAt,
      status: item.status,
      version: item.version,
      repeat: typeof item.repeat === "string" ? item.repeat : null,
      timezone: typeof item.timezone === "string" ? item.timezone : null,
    };
  }
  return undefined;
}

export function decodeAgentInboxReadResponse(value: unknown): AgentInboxReadResponse {
  if (!value || typeof value !== "object") throw new Error("Invalid inbox read response");
  const record = value as Record<string, unknown>;
  if (
    record.ok !== true ||
    typeof record.kind !== "string" ||
    !READ_KINDS.has(record.kind) ||
    typeof record.target !== "string" ||
    !Array.isArray(record.items) ||
    typeof record.hasMore !== "boolean" ||
    (record.nextCursor !== null && typeof record.nextCursor !== "string")
  )
    throw new Error("Invalid inbox read response");
  const items = record.items.map(decodeReadItem);
  if (items.some((entry) => entry === undefined))
    throw new Error("Invalid inbox read item in response");
  return {
    ok: true,
    kind: record.kind as AgentInboxReadTargetKind,
    target: record.target,
    items: items as AgentInboxReadItem[],
    hasMore: record.hasMore,
    nextCursor: record.nextCursor as string | null,
    ...(typeof record.readPositionAfter === "number"
      ? { readPositionAfter: record.readPositionAfter }
      : {}),
  };
}

export function decodeAgentInboxDismissResponse(value: unknown): AgentInboxDismissResponse {
  if (!value || typeof value !== "object") throw new Error("Invalid inbox dismiss response");
  const record = value as Record<string, unknown>;
  if (
    record.ok !== true ||
    (record.mode !== "target" && record.mode !== "before") ||
    typeof record.dismissedConversations !== "number" ||
    typeof record.dismissedThreads !== "number" ||
    typeof record.dismissedAppTargets !== "number" ||
    typeof record.dismissedReminders !== "number" ||
    !Array.isArray(record.targets) ||
    record.targets.some((entry) => typeof entry !== "string")
  )
    throw new Error("Invalid inbox dismiss response");
  return {
    ok: true,
    mode: record.mode,
    dismissedConversations: record.dismissedConversations,
    dismissedThreads: record.dismissedThreads,
    dismissedAppTargets: record.dismissedAppTargets,
    dismissedReminders: record.dismissedReminders,
    targets: record.targets as string[],
  };
}

export function decodeAgentActionWithdrawResponse(value: unknown): AgentActionWithdrawResponse {
  if (!value || typeof value !== "object") throw new Error("Invalid action withdraw response");
  const record = value as Record<string, unknown>;
  if (record.ok !== true || typeof record.messageId !== "string" || record.state !== "cancelled")
    throw new Error("Invalid action withdraw response");
  return {
    ok: true,
    messageId: record.messageId,
    state: "cancelled",
    ...(typeof record.alreadyWithdrawn === "boolean"
      ? { alreadyWithdrawn: record.alreadyWithdrawn }
      : {}),
  };
}
