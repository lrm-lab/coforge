/** Message-backed Task contract shared by browser, Agent RPC and backend. */
import type { AgentMessageRecord } from "./local-daemon";
import { CHANNEL_NAME_PATTERN } from "./channel-references";

export const TASK_STATUSES = ["todo", "in_progress", "in_review", "done", "closed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPeerKind = "human" | "agent";

/**
 * The statuses a Task may move to in ordinary hands, as the reference product's board works: work
 * moves forward Todo → In Progress → In Review → Done, In Progress may be withdrawn to Todo,
 * In Review may be sent back to In Progress for more work, Closed may be set from anywhere, and a finished Task may be reopened. A Workspace
 * owner or admin may set any status at all; this table is what everyone else may do. The server's
 * TaskBoard and the browser's board both read it, so the two cannot drift apart.
 */
export const ORDINARY_TASK_STATUS_MOVES: Record<TaskStatus, readonly TaskStatus[]> = {
  todo: ["in_progress", "closed"],
  // Back to Todo withdraws a Task that was started by mistake.
  in_progress: ["todo", "in_review", "closed"],
  in_review: ["in_progress", "done", "closed"],
  // A Done Task goes back to Todo, In Progress or In Review.
  done: ["todo", "in_progress", "in_review", "closed"],
  // A Closed Task reopens to Todo only.
  closed: ["todo"],
};

/** Whether someone who is not a Workspace owner or admin may move a Task from one status to
 * another. The same status is not a move: it is accepted and changes nothing. */
export function ordinaryTaskStatusMove(from: TaskStatus, to: TaskStatus): boolean {
  return to === from || ORDINARY_TASK_STATUS_MOVES[from].includes(to);
}

/** Whether this viewer may make the move: a Workspace owner or admin (an Agent whose own role is
 * one included) sets any status, everyone else follows the ordinary table. */
export function taskStatusMoveAllowed(
  from: TaskStatus,
  to: TaskStatus,
  viewer: { manager: boolean },
): boolean {
  return viewer.manager || ordinaryTaskStatusMove(from, to);
}

/** A conversation member named on a Task: its owner or its creator. */
export type TaskMember = {
  memberId: string;
  kind: "user" | "agent";
  /** The User or Agent id behind the member, as history payloads name an assignee. */
  id: string;
  name: string;
  /** The username or Agent name. */
  handle: string;
  /** True when the named Agent has been deleted: the identity still reads, with its DELETED marker. */
  deleted?: boolean;
  /** Set when the member has left the conversation; the Task still names them. */
  left?: boolean;
  /** Where the browser reads the member's avatar, a person's or an Agent's; null without one. */
  avatarUrl?: string | null;
};

/**
 * How a command names a Task: `number` in the command's own conversation, or in the Workspace
 * channel `channel` (its name, without `#`).
 */
export type TaskRef = { number: number; channel?: string };

/** Whether `value` is a well-formed `TaskRef`: a positive whole number and, when given, a valid channel name. */
export function isTaskRef(value: unknown): value is TaskRef {
  if (typeof value !== "object" || value === null) return false;
  const { number, channel, ...rest } = value as Record<string, unknown>;
  return (
    Object.keys(rest).length === 0 &&
    typeof number === "number" &&
    Number.isSafeInteger(number) &&
    number >= 1 &&
    (channel === undefined || (typeof channel === "string" && CHANNEL_NAME_PATTERN.test(channel)))
  );
}

/**
 * A Task as a view or a history event names it, from the conversation of the Task being read.
 * `channel` is null for a Task in that same conversation and the channel's name otherwise. A Task
 * in another conversation is `hidden` unless that is a public channel: the reader may not be able
 * to read it, so nothing but its status shows.
 */
export type TaskName = { hidden: false; number: number; channel: string | null } | { hidden: true };

/** How text writes a Task's name: `#3`, `#channel/3`, or, for one the reader may not name, that. */
export function taskNameLabel(name: TaskName): string {
  if (name.hidden) return "a task in another channel";
  return name.channel === null ? `#${name.number}` : `#${name.channel}/${name.number}`;
}

/** A Task as another Task's card names it: a blocker, a dependent or a parent. */
export type TaskLink =
  | (Extract<TaskName, { hidden: false }> & { title: string; status: TaskStatus })
  | { hidden: true; status: TaskStatus };

/** A Task waiting for a blocker is blocked until the blocker is finished: done or closed. */
export const TASK_BLOCKER_SATISFIED_STATUSES = ["done", "closed"] as const;

/** Whether a Task in this status no longer holds back the Tasks that wait for it. */
export function isBlockerSatisfied(status: string): boolean {
  return (TASK_BLOCKER_SATISFIED_STATUSES as readonly string[]).includes(status);
}

/** The most blockers one Task may wait for. */
export const MAX_TASK_BLOCKERS = 20;
/** The deepest a subtask tree may nest: a top-level Task is level 1. */
export const MAX_TASK_TREE_DEPTH = 5;

/** One node of a Task's subtask tree as `task show` reads it. A hidden node has no children read. */
export type TaskTreeNode =
  | (Extract<TaskName, { hidden: false }> & {
      title: string;
      status: TaskStatus;
      owner: TaskMember | null;
      /** Whether any of its blockers is unfinished. */
      blocked: boolean;
      /** The unfinished Tasks it still waits for. */
      blockedBy: TaskName[];
      children: TaskTreeNode[];
    })
  | { hidden: true; status: TaskStatus; children: [] };

export type TaskView = {
  /** The task's own id; for a task that started as a message it equals that message's id. */
  id: string;
  /** The channel message the task sits on; null for a task made without one (task conversations). */
  messageId: string | null;
  conversationId: string;
  number: number;
  title: string;
  description?: string | null;
  status: TaskStatus;
  revision: number;
  /** The Tasks this one waits for, in this Workspace, by number. */
  blockedBy: TaskLink[];
  /** Whether any of `blockedBy` is not done or closed; derived on read, never stored. */
  blocked: boolean;
  /** The Task this one is a subtask of; null at the top level. */
  parent: TaskLink | null;
  /** The progress of this Task's subtasks (`finished` counts done and closed); null with none. */
  subtasks: { total: number; finished: number } | null;
  owner: TaskMember | null;
  creator: TaskMember;
  createdAt: string;
  updatedAt: string;
  /** The conversation's target (`#channel` or `@user`); an Agent's own cross-conversation list sets it. */
  channelRef?: string;
  requiresResourceReceipt?: boolean;
  resourceReceiptRecordedAt?: string | null;
  resourceReceipt?: TaskResourceReceipt;
  claimedAt?: string | null;
  /** The current or most recent isolated runtime attempt for an Agent-owned Task. */
  executionSessionId?: string | null;
  /** The task's own conversation, once someone has spoken in it (task conversations). */
  discussionConversationId?: string | null;
  /** The messages in that conversation. */
  replyCount?: number;
  /** The thread under the message the task started as, from before the task had a conversation of
   * its own; new replies go to the task's conversation, not here. */
  earlierDiscussion?: { threadRootId: string; replyCount: number };
  /** The channel message the task was made from (`create --message-id`). */
  sourceMessageId?: string | null;
  /** The channel message the task was made from, as a card or `task show` shows it; null when it
   * was made from none. `threadRootId` is set when that message is a reply. */
  sourceMessage?: {
    messageId: string;
    threadRootId?: string;
    senderName: string | null;
    preview: string;
  } | null;
};

export type TaskResourceReceipt = {
  object: string;
  purpose: string;
  teardownOwner: string;
  securityPrivacy: string;
  expiry: string;
  runbook: string;
  tracking: string;
};

/** One claim selector's outcome. A refused claim is a result, not an error: `reason` says why,
 * and `conflict` is set when another member holds the Task. */
export type TaskClaimResult = {
  number?: number;
  messageId?: string;
  success: boolean;
  reason?: string;
  conflict?: TaskClaimConflict;
  /** With reason `blocked`: the blockers that are not done or closed yet. */
  blockedBy?: TaskName[];
};

/** One Task change as history records it: `payload` carries the facts its `eventType` names. */
export type TaskHistoryChange =
  | { eventType: "created"; payload: { taskNumber: number; status: TaskStatus } }
  | { eventType: "status_changed"; payload: { from: TaskStatus; to: TaskStatus } }
  | {
      eventType: "assignee_changed";
      /** A User or Agent id, both null when the Task was unassigned. */
      payload: { assigneeId: string | null; assigneeType: "user" | "agent" | null };
    }
  | {
      eventType: "amended";
      payload: {
        changes: {
          title?: { from: string; to: string };
          description?: { from: string | null; to: string | null };
        };
        /** The Task revision this amendment produced; absent on amendments recorded before it. */
        revision?: number;
      };
    }
  | {
      eventType: "dependencies_changed";
      /** The blockers added and removed. */
      payload: { added: TaskName[]; removed: TaskName[] };
    }
  | {
      eventType: "parent_changed";
      /** The parent before and after; null for none. */
      payload: { from: TaskName | null; to: TaskName | null };
    };

export type TaskHistoryEvent = {
  id: string;
  seq: number;
  actorType: "user" | "agent" | "system";
  /** The actor's handle when the event was recorded. */
  actorName: string | null;
  createdAt: string;
} & TaskHistoryChange;

export type TaskCommand = {
  operation:
    | "list"
    | "show"
    | "create"
    | "convert"
    | "claim"
    | "unclaim"
    | "update"
    | "assign"
    | "unassign"
    | "amend"
    | "history"
    | "delete"
    | "receipt";
  idempotencyKey: string;
  /** Browser callers identify the conversation; Agent callers use its public target. */
  conversationId?: string;
  target?: string;
  /** For a direct board target (`@peer`), whether the peer is a human or Agent. */
  peerKind?: TaskPeerKind;
  number?: number;
  numbers?: number[];
  messageId?: string;
  messageIds?: string[];
  title?: string;
  titles?: string[];
  description?: string | null;
  /** `create`: the Tasks the new Tasks wait for. `amend`: the whole set, replacing the old one; empty clears. */
  blockedBy?: TaskRef[];
  /** `create`: the parent of the new Tasks. `amend`: the new parent; null makes the Task top level. */
  parent?: TaskRef | null;
  /** `list`: only Tasks ready to start: todo, unowned and not blocked. */
  ready?: boolean;
  assignee?: string | null;
  mine?: boolean;
  createsResource?: boolean;
  receipt?: TaskResourceReceipt;
  freshnessContextMode?: "inline" | "withheld";
  /** With task conversations, create a task beside someone else's live task on `messageId`. */
  alongside?: boolean;
  attachmentId?: string;
  status?: TaskStatus | "all";
  expectedRevision?: number;
  /** The model-visible boundary for the task board, carried to the server's freshness gate. */
  seenUpToSeq?: number;
  /** Exact messages shown above `seenUpToSeq`, for sparse context reads. */
  seenExactSeqs?: number[];
};

/** The conversation kinds an Agent's own Task list reads: channels and direct messages. */
export type TaskConversationKind = "channel" | "dm";

/**
 * What an Agent's own Task list covered. The server derives it from the query it ran, so the
 * Agent can tell an empty list from a scope the list never looked at.
 */
export type TaskListCoverage = {
  /** Always `incomplete`: conversations outside the covered scope are not checked. */
  status: "incomplete";
  visibleConversationKinds: TaskConversationKind[];
  includesArchived: boolean;
  /** The list makes no claim about Tasks in conversations it did not read. */
  inaccessibleScope: "not_asserted";
  reason: string;
};

/** An Agent's own Task list is never cut short: every covered match is returned. */
export type TaskListPagination = { mode: "complete"; truncated: false };

export type TaskResult = {
  tasks: TaskView[];
  /** Set only on an Agent's own (`mine`) list. */
  coverage?: TaskListCoverage;
  /** Set only on an Agent's own (`mine`) list. */
  pagination?: TaskListPagination;
  claims?: TaskClaimResult[];
  history?: TaskHistoryEvent[];
  /** `show` only: the Tasks waiting for the shown one. */
  blocking?: TaskLink[];
  /** `show` only: the shown Task's subtasks, nested at most `MAX_TASK_TREE_DEPTH` levels. */
  subtree?: TaskTreeNode[];
  /** One per assigned Task, each posted in that Task's own thread. */
  assignmentReceipts?: Array<{
    messageId: string;
    content: string;
    assignee: string;
    state: "started" | "assigned";
  }>;
  resourceFollowup?: {
    id: string;
    ownerAgentId: string;
    owner: string;
    fireAt: string;
    messageId: string;
    targetChannelId: string;
  };
  /** `held`: unread target context stopped the write; `duplicate`: an existing Task answered a
   * repeated create without a new one. */
  state?: "held" | "duplicate";
  freshnessContextMode?: "inline" | "withheld";
  withheldMessageCount?: number;
  heldMessages?: AgentMessageRecord[];
  newMessageCount?: number;
  /** Context attached to a task mutation that was allowed to proceed. */
  recentUnread?: AgentMessageRecord[];
};

/** What another member's hold on a Task stops: the only action a refused claim blocks. */
export const TASK_CLAIM_BLOCKED_ACTIONS = ["start_conflicting_execution"] as const;

/**
 * Another member holds the Task a claim named. The holder is read in the same transaction that
 * refused the claim, and `observedAt` is when: a snapshot, not a ruling that stays true.
 */
export type TaskClaimConflict = {
  kind: "claim_conflict";
  conflictScope: "implementation_execution";
  /** Every action this conflict blocks; an action not listed is not blocked by it. */
  blockedActions: (typeof TASK_CLAIM_BLOCKED_ACTIONS)[number][];
  /** Illustrative, not exhaustive, and never a permission table. */
  unblockedActionExamples: string[];
  /** The holder by handle; `deleted` marks a deleted Agent that still holds the Task. */
  currentAssignee: { type: "user" | "agent"; name: string; deleted?: boolean };
  taskStatus: TaskStatus;
  /** When the holder claimed it; null when a person assigned it and it was not claimed since. */
  claimedAt: string | null;
  observedAt: string;
};

/** Who acts on a board: a person or an Agent, never both (the board refuses a principal naming
 * both, so the type does too). An Agent API request authenticates an Agent beside its owner; the
 * owner is not the actor. */
export type TaskPrincipal =
  | { workspaceId: string; userId: string; agentId?: never }
  | { workspaceId: string; agentId: string; userId?: never };
