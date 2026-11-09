import type { TaskListCoverage, TaskMember, TaskView } from "@lrm/coforge-sdk/internal";

export const person = (handle: string, fields: Partial<TaskMember> = {}): TaskMember => ({
  memberId: `member-${handle}`,
  kind: "user",
  id: `user-${handle}`,
  name: handle,
  handle,
  ...fields,
});

export const task = (number: number, fields: Partial<TaskView> = {}): TaskView => ({
  id: `${number}abcdef0-1111-2222-3333-444444444444`,
  messageId: `${number}abcdef0-1111-2222-3333-444444444444`,
  conversationId: "conversation",
  number,
  title: `Task ${number}`,
  status: "todo",
  revision: 1,
  blockedBy: [],
  blocked: false,
  parent: null,
  subtasks: null,
  owner: null,
  creator: person("ada"),
  createdAt: "2026-09-23T05:00:00.000Z",
  updatedAt: "2026-09-23T06:30:15.000Z",
  requiresResourceReceipt: false,
  resourceReceiptRecordedAt: null,
  ...fields,
});

export const coverage: TaskListCoverage = {
  status: "incomplete",
  visibleConversationKinds: ["channel", "dm"],
  includesArchived: true,
  inaccessibleScope: "not_asserted",
  reason: "Reads the channels and DMs this Agent is a member of now.",
};
