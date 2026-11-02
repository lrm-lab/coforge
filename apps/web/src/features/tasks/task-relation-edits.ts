import {
  isBlockerSatisfied,
  MAX_TASK_BLOCKERS,
  type TaskLink,
  type TaskName,
  type TaskRef,
  type TaskTreeNode,
  type TaskView,
  taskNameLabel,
} from "@lrm/coforge-sdk/internal";

import { isAppError } from "#src/lib/app-error";

/**
 * What a Task popup edits of a Task's blockers and parent, as pure functions over the views the
 * server sends: the refs an amendment carries, which Tasks a picker offers, and who may edit.
 * Related Tasks are named as the viewed Task's conversation names them (`channel` null: its own).
 */

/** A related Task the reader may name; the others come as `hidden`, with only a status. */
export type VisibleTaskName = Extract<TaskName, { hidden: false }>;
export type VisibleTaskLink = Extract<TaskLink, { hidden: false }>;

/** What every Task view carries of its dependencies and sub-tasks. All of it is empty unless the
 * Workspace has Tasks v2 on. */
export type TaskRelations = Pick<TaskView, "blockedBy" | "blocked" | "parent" | "subtasks">;

/** What only `show` reads: the Tasks waiting for this one, and its whole sub-task tree. */
export type TaskDetailRelations = {
  blocking: readonly TaskLink[];
  subtree: readonly TaskTreeNode[];
};

/** How a command names the Task: a bare number in the Task's own conversation. */
export function taskRefOf(name: VisibleTaskName): TaskRef {
  return name.channel === null
    ? { number: name.number }
    : { number: name.number, channel: name.channel };
}

/** Whether a Task waits for a Task it cannot name. Such a blocker has no ref to send, and an
 * amendment replaces the whole set, so editing the set would drop it without a word. */
const hasHiddenBlocker = (blockedBy: readonly TaskLink[]) => blockedBy.some((link) => link.hidden);

/** Whether blockers may be removed: only while every one of them can be named. */
export const canRemoveBlockers = (blockedBy: readonly TaskLink[]) => !hasHiddenBlocker(blockedBy);

/** Whether a blocker may be added: every current one can be named, and there is room. */
export const canAddBlocker = (blockedBy: readonly TaskLink[]) =>
  !hasHiddenBlocker(blockedBy) && blockedBy.length < MAX_TASK_BLOCKERS;

/**
 * The whole `blockedBy` set to amend to: the current blockers with `add` joined or `remove` taken
 * out. Undefined when the set holds a blocker that cannot be named, which no amendment may replace.
 */
export function blockerRefs(
  blockedBy: readonly TaskLink[],
  change: { add?: VisibleTaskName; remove?: VisibleTaskName },
): TaskRef[] | undefined {
  if (hasHiddenBlocker(blockedBy)) return undefined;
  const kept = blockedBy.flatMap((link) =>
    link.hidden || (change.remove && taskNameLabel(link) === taskNameLabel(change.remove))
      ? []
      : [link],
  );
  const added =
    change.add && !kept.some((link) => taskNameLabel(link) === taskNameLabel(change.add!))
      ? [change.add]
      : [];
  return [...kept, ...added].map(taskRefOf);
}

/** What a picker keeps out and what it lists but refuses. */
export type PickerRules = {
  /** Labels left out of the list: the Task itself and what it already has. */
  excluded: ReadonlySet<string>;
  /** Labels listed but not pickable: picking one would make the chain loop back. */
  loops: ReadonlySet<string>;
};

/** The labels of every Task in a sub-task tree. */
function treeLabels(nodes: readonly TaskTreeNode[]): string[] {
  return nodes.flatMap((node) =>
    node.hidden ? [] : [taskNameLabel(node), ...treeLabels(node.children)],
  );
}

/** The Task itself, as its own conversation names it. */
const ownLabel = (task: Pick<TaskView, "number">) =>
  taskNameLabel({ hidden: false, number: task.number, channel: null });

const labelsOf = (links: readonly TaskLink[]) =>
  links.flatMap((link) => (link.hidden ? [] : [taskNameLabel(link)]));

/** A Task waits for no Task that already waits for it (or that is part of it): the server refuses
 * a deeper cycle, and says so. */
export function blockerPickerRules(
  task: Pick<TaskView, "number" | "blockedBy">,
  detail: TaskDetailRelations,
): PickerRules {
  return {
    excluded: new Set([ownLabel(task), ...labelsOf(task.blockedBy)]),
    loops: new Set([...labelsOf(detail.blocking), ...treeLabels(detail.subtree)]),
  };
}

/** A Task is no sub-task of its own sub-tasks. */
export function parentPickerRules(
  task: Pick<TaskView, "number" | "parent">,
  detail: Pick<TaskDetailRelations, "subtree">,
): PickerRules {
  return {
    excluded: new Set([
      ownLabel(task),
      ...(task.parent && !task.parent.hidden ? [taskNameLabel(task.parent)] : []),
    ]),
    loops: new Set(treeLabels(detail.subtree)),
  };
}

/** What a picker knows of the viewer: their member in the Task's own conversation, and whether
 * they are a Workspace owner or admin. */
export type CandidateViewer = { memberId: string | null; manager: boolean };

/** A candidate, and whether the viewer may put a Task under it: that is its owner's, its creator's
 * or a manager's call, as the server's `assertMayAddSubtasks` decides. */
export type TaskCandidate = VisibleTaskLink & { canBeParent: boolean };

type CandidateRow = Pick<
  TaskView,
  "conversationId" | "number" | "title" | "status" | "owner" | "creator"
>;

/** The Workspace-wide read also says which member of that Task's conversation is the viewer. */
type WorkspaceCandidateRow = CandidateRow & {
  currentMemberId: string | null;
  source: { channelName: string | null };
};

const mayAddSubtasks = (row: CandidateRow, memberId: string | null, manager: boolean) =>
  manager ||
  (memberId !== null && (row.owner?.memberId === memberId || row.creator.memberId === memberId));

/**
 * The unfinished Tasks a picker can offer for a Task of `conversationId`, named as that conversation
 * names them: those of the conversation (any kind, a direct message's too) first, then channels' by name.
 * `workspace` is the Workspace-wide read, which lists channel Tasks only. Each candidate also says
 * whether the viewer may add a sub-task under it, which only the parent picker needs.
 */
export function candidateLinks(
  conversationId: string,
  own: readonly CandidateRow[],
  workspace: readonly WorkspaceCandidateRow[],
  viewer: CandidateViewer,
): TaskCandidate[] {
  const named = new Map<string, TaskCandidate>();
  const add = (row: CandidateRow, channel: string | null, memberId: string | null) => {
    if (isBlockerSatisfied(row.status)) return;
    const link: TaskCandidate = {
      hidden: false,
      number: row.number,
      channel,
      title: row.title,
      status: row.status,
      canBeParent: mayAddSubtasks(row, memberId, viewer.manager),
    };
    named.set(taskNameLabel(link), link);
  };
  for (const row of [...own].sort((a, b) => a.number - b.number)) add(row, null, viewer.memberId);
  for (const row of workspace) {
    if (row.conversationId === conversationId) add(row, null, row.currentMemberId ?? null);
    else if (row.source.channelName) add(row, row.source.channelName, row.currentMemberId ?? null);
  }
  return [...named.values()].sort(
    (a, b) =>
      Number(a.channel !== null) - Number(b.channel !== null) ||
      (a.channel ?? "").localeCompare(b.channel ?? "") ||
      a.number - b.number,
  );
}

/** The candidates a picker lists, without those its rules leave out. */
export const pickable = <T extends VisibleTaskLink>(
  candidates: readonly T[],
  rules: PickerRules,
): T[] => candidates.filter((candidate) => !rules.excluded.has(taskNameLabel(candidate)));

/** The candidates the parent picker offers: the Tasks the viewer may add sub-tasks under. */
export const parentCandidates = (candidates: readonly TaskCandidate[]) =>
  candidates.filter((candidate) => candidate.canBeParent);

/** Whether the viewer may change what the Task waits for, its parent and its sub-tasks, as the
 * server allows: its owner, its creator, or a Workspace owner or admin. Only an affordance. */
export function canEditTaskRelations(
  task: Pick<TaskView, "owner" | "creator">,
  currentMemberId: string | null,
  manager: boolean,
) {
  return (
    manager ||
    (currentMemberId !== null &&
      (task.owner?.memberId === currentMemberId || task.creator.memberId === currentMemberId))
  );
}

// The ids the server answers a refused relation write with (`task-relations-write.server.ts`). A
// refusal's sentence stays on the server; the browser gets only these.
const TASK_RELATION_INVALID = "task_relation_invalid";
const TASK_RELATION_DENIED = "task_relation_denied";

/** Why a relation write was refused, when it was refused for the relation itself. */
export function relationRefusal(failure: unknown): "denied" | "invalid" | undefined {
  if (!isAppError(failure)) return undefined;
  if (failure.code === "ACCESS_DENIED" && failure.errorId === TASK_RELATION_DENIED) return "denied";
  if (failure.code === "INVALID_INPUT" && failure.errorId === TASK_RELATION_INVALID)
    return "invalid";
  return undefined;
}

/** What still blocks a Task: a blocker the server counts as satisfied no longer does
 * (`isBlockerSatisfied`). A tree node's blockers come without a status, all of them still open.
 * Ones the reader can see go first, so a mark or a sentence names one. */
export function openBlockers<T extends TaskName | TaskLink>(blockedBy: readonly T[]): T[] {
  return blockedBy
    .filter((task) => !("status" in task) || !isBlockerSatisfied(task.status))
    .sort((a, b) => Number(a.hidden) - Number(b.hidden));
}
