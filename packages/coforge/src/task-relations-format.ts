import { foldUntrustedLine } from "@lrm/coforge-sdk/internal";
import {
  isBlockerSatisfied,
  taskNameLabel,
  type TaskClaimResult,
  type TaskLink,
  type TaskName,
  type TaskResult,
  type TaskTreeNode,
  type TaskView,
} from "@lrm/coforge-sdk/internal";
import { fenceMessageBody } from "#src/message-body-format";

/** How a task's blockers, parent and subtasks print in the task commands' output. */

const isOpen = (status: string) => !isBlockerSatisfied(status);

const names = (list: readonly TaskName[]) => list.map(taskNameLabel).join(" ");

/** ` blocked by #3 #5` while a blocker is unfinished, and ` ↳ #7` under a parent. */
export function relationMarks(task: TaskView): string {
  const open = task.blockedBy.filter((blocker) => isOpen(blocker.status));
  return `${open.length ? ` blocked by ${names(open)}` : ""}${task.parent ? ` ↳ ${taskNameLabel(task.parent)}` : ""}`;
}

/** A Task the reader may not read shows its status and nothing else. */
const hiddenLine = (status: string) => `${taskNameLabel({ hidden: true })} ([${status}])`;

const linkLine = (link: TaskLink) =>
  link.hidden
    ? `  ${hiddenLine(link.status)}`
    : `  ${taskNameLabel(link)} [${link.status}] ${fenceMessageBody(link.title)}`;

function treeLines(nodes: readonly TaskTreeNode[], depth: number): string[] {
  return nodes.flatMap((node) => [
    node.hidden
      ? `${"  ".repeat(depth)}- ${hiddenLine(node.status)}`
      : `${"  ".repeat(depth)}- ${taskNameLabel(node)} [${node.status}] ${foldUntrustedLine(node.title)}${
          node.owner ? ` → @${foldUntrustedLine(node.owner.handle)}` : ""
        }${node.blocked ? ` (blocked by ${names(node.blockedBy)})` : ""}`,
    ...treeLines(node.children, depth + 1),
  ]);
}

/** What `task show` adds below a card: blockers, dependents, parent and the subtask tree. */
export function showRelationLines(
  task: TaskView,
  relations: Pick<TaskResult, "blocking" | "subtree"> = {},
): string[] {
  return [
    ...(task.parent
      ? [
          `Parent task:${task.parent.hidden ? ` ${hiddenLine(task.parent.status)}` : ` ${taskNameLabel(task.parent)} ${fenceMessageBody(task.parent.title)}`}`,
        ]
      : []),
    ...(task.blockedBy.length
      ? [`Blocked by${task.blocked ? "" : " (all finished)"}:`, ...task.blockedBy.map(linkLine)]
      : []),
    ...(relations.blocking?.length ? ["Blocking:", ...relations.blocking.map(linkLine)] : []),
    ...(task.subtasks
      ? [`Sub-tasks: ${task.subtasks.finished}/${task.subtasks.total} finished`]
      : []),
    ...(relations.subtree?.length ? treeLines(relations.subtree, 1) : []),
  ];
}

/** A refused claim of a blocked task: what it waits for and what to do instead. */
export function blockedClaimRow(label: string, claim: TaskClaimResult): string {
  return `${label}: blocked — waiting for ${names(claim.blockedBy ?? [])}. Do not start it. Its owner is notified in the task's thread when the last blocker is done or closed; claim another task meanwhile, or claim this one again then.`;
}
