import type { TaskStatus } from "@lrm/coforge-sdk/internal";

/** A person a system notice names: the id opens their profile when it resolves; the handle and
 * name survive a deleted person. */
export type SystemPerson = { memberId: string | null; handle: string; displayName: string };

/** A Task a system notice names; the id survives a title change. Null in a notice backfilled from
 * text that named no Task the backfill could find. */
export type SystemTask = {
  taskId: string | null;
  number: number;
  title: string;
  /** The channel the Task is in, when that is not the conversation the notice is in. */
  channel?: string;
  /** In a channel the reader may not be able to read: named by nothing else (`number` is 0). */
  hidden?: true;
};

/** The notices that address a Task's owner name them here, when someone holds the Task. */
type OwnerParam = { owner?: SystemPerson | null };

/**
 * A server-authored system message's structured content. `Message.body` is the rendered English
 * text the Agent API, CLI and search read; the web renders this shape in the viewer's language.
 * `params` carries facts only, never display text.
 */
export type SystemNotice =
  | { kind: "task.created"; params: { tasks: SystemTask[] } }
  | { kind: "task.converted"; params: { actor: SystemPerson; task: SystemTask } }
  | { kind: "task.from_message"; params: { actor: SystemPerson; task: SystemTask } }
  | {
      kind: "task.assigned";
      params: { actor: SystemPerson; task: SystemTask; assignee: SystemPerson };
    }
  | { kind: "task.claimed"; params: { claimer: SystemPerson; task: SystemTask } }
  | { kind: "task.moved"; params: { actor: SystemPerson; task: SystemTask; status: TaskStatus } }
  | { kind: "task.unassigned"; params: { actor: SystemPerson; task: SystemTask } }
  | {
      kind: "task.unfollowed";
      params: { actor: SystemPerson; task: SystemTask; reason?: string };
    }
  | { kind: "task.assigned_you"; params: { actor: SystemPerson; task: SystemTask } }
  | {
      kind: "task.blocked";
      /** `task`, already under way, now waits for `blockers`. */
      params: { task: SystemTask; blockers: SystemTask[] } & OwnerParam;
    }
  | { kind: "task.subtasks_finished"; params: { task: SystemTask } & OwnerParam }
  | {
      kind: "task.released";
      /** `task`'s last blocker was removed or deleted, so it can start. */
      params: { task: SystemTask } & OwnerParam;
    }
  | {
      kind: "task.unblocked";
      /** `task` can start now that `blocker` is finished. */
      params: { task: SystemTask; blocker: SystemTask } & OwnerParam;
    }
  | {
      kind: "channel.coordinator_changed";
      params: {
        channelId: string;
        channelName: string;
        actor: SystemPerson;
        previous?: SystemPerson;
        next?: SystemPerson;
      };
    }
  | { kind: "agent_dm.chain_limit" | "agent_dm.rate_limit"; params: Record<string, never> }
  | { kind: "legacy_text"; params: { body: string } };

/** The body and structured content one notice carries. */
export type SystemNoticeContent = { body: string; system: SystemNotice };

const person = (value: unknown): value is SystemPerson => {
  const row = value as Record<string, unknown> | null;
  return (
    !!row &&
    (row.memberId === null || typeof row.memberId === "string") &&
    typeof row.handle === "string" &&
    typeof row.displayName === "string"
  );
};

const task = (value: unknown): value is SystemTask => {
  const row = value as Record<string, unknown> | null;
  return (
    !!row &&
    (row.taskId === null || typeof row.taskId === "string") &&
    typeof row.number === "number" &&
    typeof row.title === "string"
  );
};

/** A notice about `params.task` that may name the owner it addresses. */
const ownerAddressed = (params: Record<string, unknown>) =>
  task(params.task) &&
  (params.owner === null || params.owner === undefined || person(params.owner));

const STATUSES = new Set(["todo", "in_progress", "in_review", "done", "closed"]);

/** Whether a stored `kind`/`params` pair is one a renderer can trust. The backfill test runs it
 * over every migrated row; the web can use it to fall back to `body` on a malformed row. */
export function isSystemNotice(value: { kind: string; params: unknown }): value is SystemNotice {
  const params = value.params as Record<string, unknown> | null;
  if (!params) return false;
  switch (value.kind) {
    case "task.created":
      return Array.isArray(params.tasks) && params.tasks.every(task);
    case "task.converted":
    case "task.from_message":
    case "task.unassigned":
    case "task.assigned_you":
      return person(params.actor) && task(params.task);
    case "task.assigned":
      return person(params.actor) && task(params.task) && person(params.assignee);
    case "task.blocked":
      return (
        ownerAddressed(params) && Array.isArray(params.blockers) && params.blockers.every(task)
      );
    case "task.released":
    case "task.subtasks_finished":
      return ownerAddressed(params);
    case "task.unblocked":
      return ownerAddressed(params) && task(params.blocker);
    case "task.claimed":
      return person(params.claimer) && task(params.task);
    case "task.moved":
      return person(params.actor) && task(params.task) && STATUSES.has(String(params.status));
    case "task.unfollowed":
      return (
        person(params.actor) &&
        task(params.task) &&
        (params.reason === null || params.reason === undefined || typeof params.reason === "string")
      );
    case "channel.coordinator_changed":
      return (
        (params.channelId === null || typeof params.channelId === "string") &&
        typeof params.channelName === "string" &&
        person(params.actor) &&
        (params.previous === null || params.previous === undefined || person(params.previous)) &&
        (params.next === null || params.next === undefined || person(params.next))
      );
    case "agent_dm.chain_limit":
    case "agent_dm.rate_limit":
      return true;
    case "legacy_text":
      return typeof params.body === "string";
    default:
      return false;
  }
}
