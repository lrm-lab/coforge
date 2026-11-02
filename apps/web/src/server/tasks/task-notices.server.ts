import type { TaskStatus } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import type { HumanNames } from "#src/lib/human-label";
import {
  agentReadableBody,
  type MessageMentionRef,
} from "#src/server/conversations/mentions.server";
import { browserSenderName } from "#src/server/conversations/sender-display.server";

/**
 * The wording of the server notices TaskBoard posts when a Task changes. Creation and conversion
 * notices are top-level; the rest, assignment included, are replies in the Task's own thread (as
 * Raft's).
 */

declare const brand: unique symbol;
/**
 * A notice names a person one of three ways: a claim uses the claimer's bare handle, an assignment
 * addresses the assignee as `@handle`, and every other line reads as prose with the actor's display
 * name. The three are distinct types so a call site cannot pass one where another belongs.
 */
export type Handle = string & { readonly [brand]: "handle" };
export type AssigneeMention = `@${string}` & { readonly [brand]: "mention" };
export type DisplayName = string & { readonly [brand]: "displayName" };

/** How a notice may name the member who made a change. */
export type NoticeActor = { memberId: string; handle: Handle; displayName: DisplayName };

type NamedMember = {
  id: string;
  user?: HumanNames | null;
  agent?: { name: string; displayName?: string | null } | null;
};

/** A conversation member is exactly one of a User or an Agent; neither is a broken row. */
export function noticeActor(member: NamedMember): NoticeActor {
  const handle = member.user?.username ?? member.agent?.name;
  if (!handle) throw new AppError("INTERNAL_ERROR");
  return {
    memberId: member.id,
    handle: handle as Handle,
    displayName: browserSenderName(member) as DisplayName,
  };
}

export function assigneeMention(member: {
  user?: { username: string } | null;
  agent?: { name: string } | null;
}): AssigneeMention {
  const handle = member.user?.username ?? member.agent?.name;
  if (!handle) throw new AppError("INTERNAL_ERROR");
  return `@${handle}` as AssigneeMention;
}

/** A Task as a notice quotes it; build it with `quotedTask`, never from a raw title. */
export type QuotedTask = {
  /** Null for a hidden Task: nothing but that it exists is shown. */
  taskId: string | null;
  number: number;
  title: string & { readonly [brand]: "quotedTitle" };
  /** The channel it is in, when that is not the conversation the notice is posted in. */
  channel?: string;
  /** In a channel the notice's readers may not be able to read: named by nothing else. */
  hidden?: true;
};

/** Where a Task is, as the conversation a notice is posted in sees it (`placeFrom`). */
export type QuotedPlace = { channel: string } | { hidden: true };

const QUOTED_TITLE_LIMIT = 80;
const BLOCK_MARKER = /^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/;

/**
 * A title can be a whole converted message: stored mention and task tokens, Markdown and many
 * lines. A notice is one short line, so it quotes the first line of prose outside fenced code,
 * with tokens read back as `@handle` / `task #N`, block markers dropped, whitespace collapsed, and
 * at most 80 characters. A title with no such line quotes as empty and is named by number alone.
 */
export function quotedTask(
  task: { id: string; number: number; title: string },
  mentions: readonly MessageMentionRef[],
  place?: QuotedPlace,
): QuotedTask {
  if (place && "hidden" in place)
    return { taskId: null, number: 0, title: "" as QuotedTask["title"], hidden: true };
  let inFence = false;
  const firstLine =
    agentReadableBody(task.title, mentions)
      .split("\n")
      .map((line) => line.trim())
      .find((line) => {
        if (line.startsWith("```")) inFence = !inFence;
        else if (!inFence && line) return true;
        return false;
      }) ?? "";
  const text = firstLine.replace(BLOCK_MARKER, "").replace(/\s+/g, " ");
  const characters = Array.from(text);
  const title =
    characters.length > QUOTED_TITLE_LIMIT
      ? `${characters
          .slice(0, QUOTED_TITLE_LIMIT - 1)
          .join("")
          .trimEnd()}…`
      : text;
  return {
    taskId: task.id,
    number: task.number,
    title: title as QuotedTask["title"],
    ...(place && { channel: place.channel }),
  };
}

const STATUS_WORDING: Record<TaskStatus, { emoji: string; label: string }> = {
  todo: { emoji: "📝", label: "Todo" },
  in_progress: { emoji: "🔄", label: "In Progress" },
  in_review: { emoji: "👀", label: "In Review" },
  done: { emoji: "✅", label: "Done" },
  closed: { emoji: "🚫", label: "Closed" },
};

const reference = (task: QuotedTask) => {
  if (task.hidden) return "a task in another channel";
  const name = task.channel ? `#${task.channel}/${task.number}` : `#${task.number}`;
  return task.title ? `${name} "${task.title}"` : name;
};
const references = (tasks: readonly QuotedTask[]) => tasks.map(reference).join(", ");
/** A notice's text, followed by the owner it addresses when it names one. */
const addressed = (text: string, owner: AssigneeMention | null) =>
  owner ? `${text}: ${owner}` : text;
const plural = (tasks: readonly QuotedTask[], noun: string) =>
  tasks.length === 1 ? noun : `${noun}s`;

export const noticeText = {
  created: (tasks: readonly QuotedTask[]) =>
    `📋 ${tasks.length} new ${plural(tasks, "task")} created: ${references(tasks)}`,
  converted: (actor: DisplayName, task: QuotedTask) =>
    `📋 ${actor} converted a message to task ${reference(task)}`,
  fromMessage: (actor: DisplayName, task: QuotedTask) =>
    `📋 ${actor} made task ${reference(task)} from this message`,
  assigned: (actor: DisplayName, task: QuotedTask, assignee: AssigneeMention) =>
    `📌 ${actor} assigned ${reference(task)} to ${assignee}`,
  claimed: (claimer: Handle, task: QuotedTask) => `📌 ${claimer} claimed ${reference(task)}`,
  moved: (actor: DisplayName, task: QuotedTask, status: TaskStatus) =>
    `${STATUS_WORDING[status].emoji} ${actor} moved ${reference(task)} to ${STATUS_WORDING[status].label}`,
  unassigned: (actor: DisplayName, task: QuotedTask) => `🔓 ${actor} unassigned ${reference(task)}`,
  /** The notice that a Task's last unfinished blocker finished; it names the owner when there is one. */
  unblocked: (blocker: QuotedTask, task: QuotedTask, owner: AssigneeMention | null) =>
    addressed(`🚦 ${reference(blocker)} is finished, so ${reference(task)} can start`, owner),
  /** The last blocker of a Task went away without finishing: it was removed or deleted. */
  released: (task: QuotedTask, owner: AssigneeMention | null) =>
    addressed(`🚦 ${reference(task)} is no longer blocked and can start`, owner),
  /** A Task under way gained blockers that are not finished: it waits now. */
  blocked: (task: QuotedTask, blockers: readonly QuotedTask[], owner: AssigneeMention | null) =>
    addressed(`⛔ ${reference(task)} is now blocked by ${references(blockers)}`, owner),
  /** The last open sub-task of a Task finished. */
  subtasksFinished: (task: QuotedTask, owner: AssigneeMention | null) =>
    addressed(`✅ All sub-tasks of ${reference(task)} are finished`, owner),
};

/**
 * The kind a rendered notice has, by the same templates above. The backfill migration embeds
 * these pattern sources, so a notice written after it (`unblocked`, which carries its kind from
 * the start) has no pattern here; `task-notice-classification.test.ts` renders every template and checks
 * that it classifies back to its kind.
 */
export const NOTICE_PATTERNS = [
  { kind: "task.created", pattern: "^📋 [0-9]+ new tasks? created: " },
  { kind: "task.converted", pattern: "^📋 .+ converted a message to task #[0-9]+" },
  { kind: "task.from_message", pattern: "^📋 .+ made task #[0-9]+ .*from this message" },
  { kind: "task.assigned", pattern: "^📌 .+ assigned #[0-9]+ .+ to @" },
  { kind: "task.assigned", pattern: "^📌 Assigned @[^ ]+ to tasks? #[0-9]+" },
  { kind: "task.claimed", pattern: "^📌 .+ claimed #[0-9]+" },
  {
    kind: "task.moved",
    pattern: "^.+ moved #[0-9]+ .+ to (Todo|In Progress|In Review|Done|Closed)$",
  },
  { kind: "task.unassigned", pattern: "^🔓 .+ unassigned #[0-9]+" },
  { kind: "task.assigned_you", pattern: "^@?[^ ]+ assigned you task #[0-9]+: " },
  { kind: "task.unfollowed", pattern: "^.+ stopped following this task" },
  {
    kind: "channel.coordinator_changed",
    pattern: "^.+ (made @[^ ]+ the coordinator of #|removed @[^ ]+ as coordinator of #)",
  },
  { kind: "channel.coordinator_changed", pattern: "^\\[CoForge coordinator change\\] #" },
  { kind: "agent_dm.chain_limit", pattern: "^\\[CoForge paused\\] These Agents have exchanged" },
  { kind: "agent_dm.rate_limit", pattern: "^\\[CoForge paused\\] An Agent here has sent" },
] as const;

export function noticeKind(body: string): (typeof NOTICE_PATTERNS)[number]["kind"] | undefined {
  return NOTICE_PATTERNS.find((entry) => new RegExp(entry.pattern).test(body))?.kind;
}
