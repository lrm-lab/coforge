import {
  TASK_STATUSES,
  type TaskClaimConflict,
  type TaskClaimResult,
  type TaskCommand,
  type TaskHistoryEvent,
  type TaskMember,
  type TaskResult,
  type TaskStatus,
  type TaskView,
} from "@lrm/coforge-sdk/internal";
import { CliError } from "#src/cli-error";
import { formatMessageLine, formatUtcTimestamp } from "#src/message-format";
import { shortId } from "#src/short-id";
import { fenceMessageBody } from "#src/message-body-format";
import { blockedClaimRow, relationMarks, showRelationLines } from "#src/task-relations-format";

/** The status filter a `task list` was given; `undefined` when none was passed. */
export type TaskListStatus = TaskStatus | "all" | undefined;

/** Why a named member no longer acts in the conversation, if they do not. */
function departure(member: TaskMember): "deleted" | "left" | undefined {
  if (member.deleted) return "deleted";
  if (member.left) return "left";
  return undefined;
}

function resourceReceipt(task: TaskView): string {
  if (!task.requiresResourceReceipt) return "";
  return ` resource-receipt=${task.resourceReceiptRecordedAt ? "recorded" : "pending"}`;
}

/** `msg=` is the channel message the Task sits on; a Task made from a message (`create --message-id`)
 * sits on none and shows only the `source=` message. */
function messageField(task: TaskView): string {
  if (task.messageId) return `msg=${shortId(task.messageId)}`;
  return task.sourceMessage ? `source=${shortId(task.sourceMessage.messageId)}` : "msg=-";
}

function times(task: TaskView): string {
  return ` created=${formatUtcTimestamp(task.createdAt)} updated=${formatUtcTimestamp(task.updatedAt)}`;
}

function boardRow(task: TaskView): string {
  const ownerMark = task.owner && departure(task.owner);
  const owner = task.owner ? ` → @${task.owner.handle}${ownerMark ? ` [${ownerMark}]` : ""}` : "";
  const creatorMark = departure(task.creator);
  const creator = ` (by @${task.creator.handle}${creatorMark ? ` [${creatorMark}]` : ""})`;
  const details = task.description ? `\n  details: ${fenceMessageBody(task.description)}` : "";
  return `#${task.number} [${task.status}] ${fenceMessageBody(task.title)}${owner}${creator} ${messageField(task)} rev=${task.revision}${resourceReceipt(task)}${relationMarks(task)}${times(task)}${details}`;
}

/** One conversation's Tasks, in board order, as `coforge task list --target` prints them. */
export function formatTaskBoard(
  target: string,
  result: TaskResult,
  status: TaskListStatus,
): string {
  if (result.tasks.length === 0)
    return `No${status && status !== "all" ? ` ${status}` : ""} tasks in ${target}.`;
  return `## Task Board for ${target} (${result.tasks.length} tasks)\n\n${result.tasks.map(boardRow).join("\n")}`;
}

function ownRow(task: TaskView): string {
  const mark = departure(task.creator);
  const creator = ` by=@${task.creator.handle}${mark ? ` creator=${mark}` : ""}`;
  const title = task.title.replace(/\s+/g, " ").trim();
  return `- ${task.channelRef ?? "<unknown conversation>"} task #${task.number} [${task.status}]${creator} ${messageField(task)}${resourceReceipt(task)}${relationMarks(task)}${times(task)} ${title}`;
}

/**
 * The Tasks assigned to this Agent across its conversations, grouped by status, as
 * `coforge task list --mine` prints them. The coverage and output lines repeat what the server
 * reported about the query; a field it did not send reads `unknown`.
 */
export function formatMyTaskList(result: TaskResult, status: TaskListStatus): string {
  const { tasks, coverage, pagination } = result;
  const archived =
    coverage === undefined ? "unknown" : coverage.includesArchived ? "included" : "not included";
  const header = [
    `## My assigned tasks in this Workspace (${status ? `status=${status}` : "unfinished"})`,
    "",
    [
      `Coverage: ${coverage?.status ?? "unknown"}`,
      `visible kinds=${coverage?.visibleConversationKinds.join("|") ?? "unknown"}`,
      `archived=${archived}`,
      `inaccessible scope=${coverage?.inaccessibleScope ?? "unknown"}`,
    ].join(" · "),
    `Output: showing ${tasks.length} of ${tasks.length} visible matches · mode=${pagination?.mode ?? "unknown"} · truncated=${pagination ? String(pagination.truncated) : "unknown"}`,
    "",
  ];
  if (tasks.length === 0)
    return [...header, "No tasks matched in the covered visible scope."].join("\n");
  const sections = TASK_STATUSES.flatMap((section) => {
    const rows = tasks.filter((task) => task.status === section);
    return rows.length ? [`### ${section} (${rows.length})`, ...rows.map(ownRow)] : [];
  });
  return [...header, ...sections].join("\n");
}

function assigneeField(task: TaskView): string {
  return `assignee=${task.owner ? `@${task.owner.handle}` : "unassigned"}`;
}

/** The command that replies in a Task's own thread: its conversation target plus its short id. A
 * Task without a channel message has no such thread. */
function threadReplies(target: string, tasks: readonly TaskView[]): string[] {
  return tasks.flatMap((task) => {
    const reply = threadReply(target, task);
    return reply ? [`#${task.number} → ${reply}`] : [];
  });
}

function threadReply(target: string, task: TaskView): string | null {
  return task.messageId
    ? `coforge message send --target "${target}:${shortId(task.messageId)}"`
    : null;
}

/** What `coforge task create` made: each new Task, the assignee's receipt, and each Task's thread. */
export function formatTasksCreated(target: string, result: TaskResult): string {
  const rows = result.tasks.map(
    (task) =>
      `#${task.number} [${task.status}] ${assigneeField(task)} claimedAt=${task.claimedAt ?? "null"} ${messageField(task)}${resourceReceipt(task)} "${fenceMessageBody(task.title)}"`,
  );
  const receipt = (result.assignmentReceipts ?? []).flatMap((receipt) => [
    "",
    `Assignment receipt (msg=${shortId(receipt.messageId)}):`,
    receipt.content,
  ]);
  if (result.state === "duplicate")
    return [
      `Existing task found in ${target}; no duplicate was created:`,
      ...rows,
      "Claim or coordinate in this task's thread before starting work:",
      ...threadReplies(target, result.tasks),
    ].join("\n");
  return [
    `Created ${result.tasks.length} task(s) in ${target}:`,
    ...rows,
    ...receipt,
    "",
    "To follow up in each task's thread:",
    ...threadReplies(target, result.tasks),
  ].join("\n");
}

/** The Task `coforge task convert` made from a message, and its thread. */
export function formatTaskConverted(target: string, task: TaskView): string {
  return [
    `Converted msg=${task.messageId ? shortId(task.messageId) : "-"} to task #${task.number} [${task.status}] ${assigneeField(task)} "${fenceMessageBody(task.title)}"`,
    ...(threadReply(target, task)
      ? ["", "To follow up in the task's thread:", threadReply(target, task)!]
      : []),
  ].join("\n");
}

export function formatTaskUnclaimed(task: TaskView): string {
  return `#${task.number} unclaimed — now open.`;
}

/** `coforge task assign` and `unassign`: who holds the Task now. */
export function formatTaskAssigned(task: TaskView): string {
  return task.owner
    ? `#${task.number} assigned to @${task.owner.handle}.`
    : `#${task.number} unassigned — now open.`;
}

export function formatTaskStatusUpdated(task: TaskView): string {
  return `#${task.number} moved to ${task.status}.`;
}

export function formatTaskDeleted(number: number): string {
  return `#${number} deleted.`;
}

/** The current title and description of one board Task. */
export function formatTaskShow(
  task: TaskView,
  relations?: Pick<TaskResult, "blocking" | "subtree">,
): string {
  return [
    `## Task #${task.number} [${task.status}]`,
    `Title: ${fenceMessageBody(task.title)}`,
    `Description: ${task.description ? fenceMessageBody(task.description) : "(none set)"}`,
    ...showRelationLines(task, relations),
  ].join("\n");
}

function historyActor(event: TaskHistoryEvent): string {
  if (event.actorType === "system") return "@system";
  return event.actorName ? `@${event.actorName}` : "<unresolved>";
}

export function formatTaskHistory(result: TaskResult): string {
  const task = result.tasks[0]!;
  const events = result.history?.length
    ? result.history
        .map((event) => {
          const lines = [
            `seq=${event.seq} time=${event.createdAt} actor=${historyActor(event)} type=${event.eventType}`,
            `  ${JSON.stringify(event.payload)}`,
          ];
          if (event.eventType === "amended") {
            const { title, description } = event.payload.changes;
            lines.push(
              "  Superseded card:",
              ...(title ? [`    title: ${fenceMessageBody(title.from)}`] : []),
              ...(description
                ? [`    description: ${fenceMessageBody(description.from ?? "(none set)")}`]
                : []),
            );
          }
          return lines.join("\n");
        })
        .join("\n")
    : "No recorded events.";
  const description = task.description ? fenceMessageBody(task.description) : "(none set)";
  return `## Task #${task.number} history — revision ${task.revision}\n\nCurrent title: ${fenceMessageBody(task.title)}\nCurrent description: ${description}\n\n${events}`;
}

/** The card after `coforge task amend`, with the revision and the history event it recorded. */
export function formatTaskAmended(result: TaskResult): string {
  const task = result.tasks[0]!;
  const event = result.history?.at(-1);
  const details =
    task.description === null || task.description === undefined
      ? "details: <none>"
      : `details:\n  ${fenceMessageBody(task.description)}`;
  const superseded =
    event?.eventType === "amended"
      ? [
          "superseded card:",
          ...(event.payload.changes.title
            ? [`  title: ${fenceMessageBody(event.payload.changes.title.from)}`]
            : []),
          ...(event.payload.changes.description
            ? [
                `  description: ${fenceMessageBody(event.payload.changes.description.from ?? "(none set)")}`,
              ]
            : []),
        ]
      : [];
  return [
    `#${task.number} amended — revision ${task.revision}${event ? `, event seq ${event.seq}.` : "; no change recorded."}`,
    `title: ${fenceMessageBody(task.title)}`,
    details,
    ...superseded,
    ...showRelationLines(task),
  ].join("\n");
}

/** `coforge task receipt`: the recorded receipt's expiry follow-up and where it is anchored. */
export function formatResourceReceiptRecorded(target: string, result: TaskResult): string {
  const task = result.tasks[0]!;
  const followup = result.resourceFollowup;
  const lines = [`Resource receipt recorded for task #${task.number} in ${target}.`];
  if (followup)
    lines.push(
      `Expiry follow-up ${shortId(followup.id)} owned by ${followup.owner} fires ${followup.fireAt}.`,
      `Follow-up anchor: msg=${shortId(followup.messageId)} targetChannelId=${followup.targetChannelId}.`,
    );
  return lines.join("\n");
}

/** How a claim conflict's blocked actions read. */
const BLOCKED_ACTION_COPY: Record<string, string> = {
  start_conflicting_execution: "starting conflicting implementation/change work",
};

function claimLabel(claim: TaskClaimResult): string {
  return claim.number ? `#${claim.number}` : `msg:${claim.messageId}`;
}

function holder(conflict: TaskClaimConflict): string {
  const { name, deleted } = conflict.currentAssignee;
  return `@${name}${deleted ? " [deleted]" : ""}`;
}

function claimRow(claim: TaskClaimResult): string {
  const label = claimLabel(claim);
  if (claim.success) return `${label} (msg:${shortId(claim.messageId ?? "")}): claimed`;
  if (claim.conflict) {
    const { conflict } = claim;
    const blocked = conflict.blockedActions
      .map((action) => BLOCKED_ACTION_COPY[action] ?? action)
      .join("; ");
    return [
      `${label}: Claim failed — ${holder(conflict)} currently holds the implementation lock (assignment state as of ${conflict.observedAt}).`,
      `  Blocked: ${blocked}.`,
      `  Not blocked by this claim conflict (each still subject to its own authority/policy): ${conflict.unblockedActionExamples.join(" · ")}.`,
      "  This is not a ruling on who owns or leads this lane. If you are its canonical owner or believe it is misrouted, correct the routing in the original thread.",
    ].join("\n");
  }
  if (claim.reason === "blocked" && claim.blockedBy) return blockedClaimRow(label, claim);
  return `${label}: FAILED — ${claim.reason || "refused"}. Do not start conflicting execution on this task or take over its scope without a redirect; a failed claim is a concurrency lock, not a ruling on lane ownership.`;
}

/** Each claim selector's outcome as `coforge task claim` prints it, then the claimed Tasks' threads. */
export function formatClaimResults(target: string, result: TaskResult): string {
  const claims = result.claims ?? [];
  const claimed = claims.filter((claim) => claim.success && claim.messageId);
  const failed = claims.length - claims.filter((claim) => claim.success).length;
  const lines = [
    `Claim results (${claims.length - failed} claimed${failed ? `, ${failed} failed` : ""}):`,
    ...claims.map(claimRow),
  ];
  if (claimed.length)
    lines.push(
      "",
      "Follow up in each task's thread:",
      ...claimed.map(
        (claim) =>
          `#${claim.number} → coforge message send --target "${target}:${shortId(claim.messageId!)}"`,
      ),
    );
  return lines.join("\n");
}

/**
 * The refusal `coforge task claim` fails with when no selector was claimed, carrying the printed
 * rows; undefined when at least one claim authorises work.
 */
export function claimRefusal(target: string, result: TaskResult): CliError | undefined {
  const claims = result.claims ?? [];
  if (claims.some((claim) => claim.success)) return undefined;
  const summary = claims
    .map(
      (claim) =>
        `${claimLabel(claim)} ${claim.conflict ? `held by ${holder(claim.conflict)}` : claim.reason || "refused"}`,
    )
    .join("; ");
  return new CliError({
    code: claims.some((claim) => claim.conflict) ? "CLAIM_CONFLICT" : "CLAIM_FAILED",
    message: `Claim refused — ${summary}. This is a concurrency lock or refusal, not a tool error and not a ruling on lane ownership.`,
    retryable: false,
    contextText: formatClaimResults(target, result),
    suggestedNextAction:
      "Do not retry the identical claim and do not start conflicting execution. If you are this lane's canonical owner, correct the routing in the original thread.",
  });
}

/** The unread context a task write that proceeded anyway (`unclaim`/`update`/`amend`) attached:
 * withheld mode reports a count, inline mode the messages themselves. */
function appendTaskRecentContext(
  command: TaskCommand,
  result: TaskResult,
  rendered: string,
): string {
  const target = command.target ?? "the task's board";
  if (result.freshnessContextMode === "withheld") {
    const count = result.withheldMessageCount ?? result.newMessageCount ?? 0;
    return `${rendered}\n\nApplied. Meanwhile ${target} has messages you had not seen; ${count} withheld for reviewer isolation.`;
  }
  if (!result.recentUnread?.length) return rendered;
  return [
    rendered,
    "",
    `Applied. Meanwhile ${target} has messages you had not seen; if they change what you just did, change it again:`,
    ...result.recentUnread.map(formatMessageLine),
  ].join("\n");
}

/** What a `task` subcommand prints for the server's answer. */
export function formatTaskResult(command: TaskCommand, result: TaskResult): string {
  const target = command.target!;
  const task = result.tasks[0];
  switch (command.operation) {
    case "list":
      return command.mine
        ? formatMyTaskList(result, command.status)
        : formatTaskBoard(target, result, command.status);
    case "show":
      if (!task) throw new Error(`the server returned no task for task ${command.operation}`);
      return formatTaskShow(task, result);
    case "history":
      return formatTaskHistory(result);
    case "create":
      return formatTasksCreated(target, result);
    case "delete":
      return formatTaskDeleted(command.number!);
    case "receipt":
      return formatResourceReceiptRecorded(target, result);
    case "amend":
      return appendTaskRecentContext(command, result, formatTaskAmended(result));
    case "claim": {
      const refusal = claimRefusal(target, result);
      if (refusal) throw refusal;
      return formatClaimResults(target, result);
    }
  }
  if (!task) throw new Error(`the server returned no task for task ${command.operation}`);
  switch (command.operation) {
    case "convert":
      return formatTaskConverted(target, task);
    case "unclaim":
      return appendTaskRecentContext(command, result, formatTaskUnclaimed(task));
    case "assign":
    case "unassign":
      return formatTaskAssigned(task);
    case "update":
      return appendTaskRecentContext(command, result, formatTaskStatusUpdated(task));
    default:
      throw new Error(`no output is defined for task ${command.operation}`);
  }
}
