import { foldUntrustedLine, mergeTimeline } from "@lrm/coforge-sdk/internal";
import type {
  AgentTaskFollowResponse,
  AgentTaskFollowingResponse,
  AgentTaskReplyResponse,
  AgentTaskViewResponse,
} from "@lrm/coforge-sdk/agent";
import { fenceMessageBody } from "./message-body-format";
import { formatUtcTimestamp } from "./message-format";
import { shortId } from "./short-id";
import { projectLine } from "./task-format";
import { formatRelatedTaskMemory } from "./task-memory-format";
import { timelineEventLine } from "./task-timeline-format";

const oneLine = foldUntrustedLine;

function followingLine(view: AgentTaskViewResponse): string {
  return view.following
    ? `Following: yes (${view.followReason ?? "manual"}) - its replies wake you`
    : "Following: no - replies do not wake you unless you are @mentioned";
}

/** The window of the task's stream `task view` shows: its latest messages and history events,
 * oldest first. */
function discussion(view: AgentTaskViewResponse): string[] {
  const { recentMessages: messages, recentEvents: events = [] } = view;
  if (!view.conversation.exists && events.length === 0)
    return ["Discussion: none yet - the first reply starts the task's conversation."];
  if (messages.length === 0 && events.length === 0) return ["Discussion: no messages yet."];
  const entries = mergeTimeline(messages, events);
  const heading =
    events.length === 0
      ? `Discussion (latest ${messages.length}${view.hasOlder ? ` of ${view.conversation.replyCount}` : ""}, oldest first):`
      : `Discussion and history (latest ${entries.length}${view.hasOlder ? ", older exist" : ""}, oldest first):`;
  return [
    heading,
    ...entries.map((entry) =>
      entry.kind === "event"
        ? timelineEventLine(entry.event)
        : `- [msg=${entry.message.id} seq=${entry.message.sequence} time=${formatUtcTimestamp(entry.message.createdAt)}] ${entry.message.sender ? `@${foldUntrustedLine(entry.message.sender)}` : "system"}: ${fenceMessageBody(entry.message.body)}`,
    ),
  ];
}

/** `coforge task view`: the task, whether its replies wake the Agent, the latest of its
 * conversation, and the commands that act on it. */
function sourceLine({ taskRef, task }: AgentTaskViewResponse): string {
  const source = task.sourceMessage!;
  const board = taskRef.replace(/:#\d+$/, "");
  const sender = source.senderName ? foldUntrustedLine(source.senderName) : "system";
  return `Source: msg=${shortId(source.messageId)} in ${board} - ${sender}: ${foldUntrustedLine(source.preview)}`;
}

export function formatTaskView(view: AgentTaskViewResponse): string {
  const ref = view.taskRef;
  const oldest = view.recentMessages[0];
  const older = view.hasOlder && oldest ? ` --before ${shortId(oldest.id)}` : "";
  return [
    `## Task ${ref} [${view.task.status}]`,
    "",
    `Current title: ${fenceMessageBody(view.task.title)}`,
    `Assignee: ${view.task.owner ? `@${view.task.owner.handle}` : "unassigned"}`,
    ...projectLine(view.task.project),
    ...(view.task.creator
      ? [
          `Created by: @${view.task.creator.handle}${
            view.task.createdAt ? ` at ${formatUtcTimestamp(view.task.createdAt)}` : ""
          }`,
        ]
      : []),
    ...(view.task.sourceMessage ? [sourceLine(view)] : []),
    ...(view.earlierDiscussion && view.earlierDiscussion.replyCount > 0
      ? [
          `Source thread discussion: ${view.earlierDiscussion.target} - ${view.earlierDiscussion.replyCount} ${view.earlierDiscussion.replyCount === 1 ? "reply" : "replies"}; read with: coforge message read --target "${view.earlierDiscussion.target}"`,
        ]
      : []),
    followingLine(view),
    view.task.description
      ? `Current description: ${fenceMessageBody(view.task.description)}`
      : "Current description: (none set)",
    "",
    ...discussion(view),
    ...formatRelatedTaskMemory(view.relatedMemory),
    "",
    "Next:",
    ...(ref.startsWith("dm:@")
      ? [
          `  Answer on the DM timeline (1-on-1 DM, unless they wrote in this task): coforge message send --target "${ref.replace(/^dm:/, "").replace(/:#\d+$/, "")}"`,
        ]
      : []),
    `  Reply (the body is read from stdin): coforge task reply "${ref}"`,
    `  Read the discussion: coforge task read "${ref}"${older}`,
    ...(view.hasOlder && view.recentEvents
      ? [`  Every recorded change: coforge task history "${ref}"`]
      : []),
    view.following
      ? `  Stop following: coforge task unfollow "${ref}"`
      : `  Follow: coforge task follow "${ref}"`,
  ].join("\n");
}

export function formatTaskReply(ref: string, reply: AgentTaskReplyResponse): string {
  return `Reply sent to ${ref}. Message ID: ${reply.messageId}`;
}

/** `coforge task follow|unfollow`: what changed, and the command that undoes it. */
export function formatTaskFollow(ref: string, result: AgentTaskFollowResponse): string {
  if (result.following)
    return [
      result.changed ? `Following ${ref}: its replies now wake you.` : `Already following ${ref}.`,
      `To stop: coforge task unfollow "${ref}"`,
    ].join("\n");
  return [
    result.changed
      ? `Unfollowed ${ref}: its ordinary replies no longer wake you.`
      : `Not following ${ref}.`,
    "A later @mention, being assigned the task or claiming it follows it again; replying in it does too.",
    `To follow again: coforge task follow "${ref}"`,
  ].join("\n");
}

/** `coforge task list --following`: each followed task with its unread count. */
export function formatTaskFollowing({ tasks }: AgentTaskFollowingResponse): string {
  if (tasks.length === 0) return "You follow no task conversations in your Workspace.";
  const rows = tasks.map((task) =>
    [
      `- ${task.taskRef} "${oneLine(task.title)}" [${task.status}]`,
      `${task.unread} unread`,
      ...(task.unread > 0 ? [`coforge task read "${task.taskRef}" --unread`] : []),
      ...(task.followedAt
        ? [`followed ${formatUtcTimestamp(task.followedAt)} (${task.reason})`]
        : [`(${task.reason})`]),
    ].join(" · "),
  );
  return [
    `## Task conversations you follow in your Workspace (${tasks.length})`,
    "",
    ...rows,
    "",
    'Stop following one: coforge task unfollow "<ref>"',
  ].join("\n");
}
