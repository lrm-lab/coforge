import type {
  AgentTaskFollowResponse,
  AgentTaskFollowingResponse,
  AgentTaskReplyResponse,
  AgentTaskViewResponse,
} from "@lrm/coforge-sdk/agent";
import { fenceMessageBody } from "./message-body-format";
import { formatUtcTimestamp } from "./message-format";
import { shortId } from "./short-id";

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function followingLine(view: AgentTaskViewResponse): string {
  return view.following
    ? `Following: yes (${view.followReason ?? "manual"}) - its replies wake you`
    : "Following: no - replies do not wake you unless you are @mentioned";
}

/** The window of the conversation `task view` shows: its latest messages, oldest first. */
function discussion(view: AgentTaskViewResponse): string[] {
  if (!view.conversation.exists)
    return ["Discussion: none yet - the first reply starts the task's conversation."];
  const { recentMessages: messages } = view;
  if (messages.length === 0) return ["Discussion: no messages yet."];
  const total = view.hasOlder ? ` of ${view.conversation.replyCount}` : "";
  return [
    `Discussion (latest ${messages.length}${total}, oldest first):`,
    ...messages.map(
      (message) =>
        `- [msg=${message.id} seq=${message.sequence} time=${formatUtcTimestamp(message.createdAt)}] ${message.sender ? `@${message.sender}` : "system"}: ${fenceMessageBody(message.body)}`,
    ),
  ];
}

/** `coforge task view`: the task, whether its replies wake the Agent, the latest of its
 * conversation, and the commands that act on it. */
function sourceLine({ taskRef, task }: AgentTaskViewResponse): string {
  const source = task.sourceMessage!;
  const board = taskRef.replace(/:#\d+$/, "");
  return `Source: msg=${shortId(source.messageId)} in ${board} - ${source.senderName ?? "system"}: ${source.preview}`;
}

export function formatTaskView(view: AgentTaskViewResponse): string {
  const ref = view.taskRef;
  const older = view.hasOlder ? ` --before ${shortId(view.recentMessages[0]!.id)}` : "";
  return [
    `## Task ${ref} [${view.task.status}]`,
    "",
    `Current title: ${fenceMessageBody(view.task.title)}`,
    `Assignee: ${view.task.owner ? `@${view.task.owner.handle}` : "unassigned"}`,
    ...(view.task.creator
      ? [
          `Created by: @${view.task.creator.handle}${
            view.task.createdAt ? ` at ${formatUtcTimestamp(view.task.createdAt)}` : ""
          }`,
        ]
      : []),
    ...(view.task.sourceMessage ? [sourceLine(view)] : []),
    followingLine(view),
    view.task.description
      ? `Current description: ${fenceMessageBody(view.task.description)}`
      : "Current description: (none set)",
    "",
    ...discussion(view),
    "",
    "Next:",
    `  Reply (the body is read from stdin): coforge task reply "${ref}"`,
    `  Read the discussion: coforge task read "${ref}"${older}`,
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
