import {
  isBlockerSatisfied,
  MAX_TASK_BLOCKERS,
  type TaskHistoryChange,
  type TaskName,
  type TaskRef,
} from "@lrm/coforge-sdk/internal";
import type { Prisma } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import type { ChannelActor } from "#src/server/conversations/channel-actor.server";
import { visibleChannelWhere } from "#src/server/conversations/channel-read-access.server";
import {
  assertDepth,
  assertNoTreeDependency,
  describe,
  loadParentTree,
  loadWaitsFor,
  pathBetween,
  TASK_RELATION_INVALID,
  treeWithChildren,
  treeWithParent,
} from "./task-relation-graph.server";
import type { Member, Transaction } from "./task-board-ports.server";
import { historyRows } from "./task-history.server";
import { byName, descend } from "./task-relations.server";
import { NAMED_CONVERSATION_SELECT, taskName } from "./task-view.server";

/**
 * Writes a Task's blockers and parent (`task_dependencies`, `task_parents`) and decides whether a
 * change keeps them valid: the Tasks are in this Workspace and readable by whoever names them, no
 * self edge, no dependency cycle across the Workspace, no Task waiting for its own ancestor or
 * descendant in the tree, at most `MAX_TASK_BLOCKERS` blockers and `MAX_TASK_TREE_DEPTH` levels.
 * The tree rule is judged on the tree and edges the write produces, whichever way it changes them.
 * The caller holds the conversation lock; every write here also runs under the Workspace's
 * task-write lock (`lockWorkspaceTaskWrites`), taken before any conversation lock, which is what
 * makes the graph checks race-free across conversations.
 */

export const TASK_RELATION_DENIED = "task_relation_denied";

const invalid = (hint: string) =>
  new AppError("INVALID_INPUT", { errorId: TASK_RELATION_INVALID, hint });

const refLabel = (ref: TaskRef) =>
  ref.channel ? `#${ref.channel}:#${ref.number}` : `#${ref.number}`;
const refKey = (ref: TaskRef) => `${ref.channel ?? ""}/${ref.number}`;

/** `refs` without repeats. */
const distinct = (refs: readonly TaskRef[]) => [
  ...new Map(refs.map((ref) => [refKey(ref), ref])).values(),
];

type TaskKey = { id: string; number: number };
type Scope = { conversationId: string; workspaceId: string };
type Input = { blockedBy?: TaskRef[]; parent?: TaskRef | null };

const PERSON_SELECT = { select: { userId: true, agentId: true } } as const;

/** What a relation write reads of a Task it names. */
const TARGET_SELECT = {
  id: true,
  number: true,
  status: true,
  conversationId: true,
  conversation: { select: NAMED_CONVERSATION_SELECT },
  owner: PERSON_SELECT,
  creator: PERSON_SELECT,
} satisfies Prisma.TaskSelect;

type Target = Prisma.TaskGetPayload<{ select: typeof TARGET_SELECT }> & { ref: TaskRef };

/** Whether `person`, a seat in some conversation, is `member`: the same person or Agent. A Task in
 * another conversation has an owner and creator with other seat ids than the actor's there. */
export const isActor = (
  person: { userId: string | null; agentId: string | null } | null,
  member: Member,
) =>
  !!person &&
  ((person.userId !== null && person.userId === member.userId) ||
    (person.agentId !== null && person.agentId === member.agentId));

const actorOf = (member: Member): ChannelActor =>
  member.userId ? { userId: member.userId } : { agentId: member.agentId! };

const depChange = (
  added: readonly TaskName[],
  removed: readonly TaskName[],
): TaskHistoryChange => ({
  eventType: "dependencies_changed",
  payload: { added: added.slice().sort(byName), removed: removed.slice().sort(byName) },
});

const parentChange = (from: TaskName | null, to: TaskName | null): TaskHistoryChange => ({
  eventType: "parent_changed",
  payload: { from, to },
});

/** The unfinished ones among `blockers`, as the conversation `from` names them. */
const openNames = (
  blockers: ReadonlyArray<{ number: number; status: string; conversation: Target["conversation"] }>,
  from: string,
) =>
  blockers
    .filter((blocker) => !isBlockerSatisfied(blocker.status))
    .map((blocker) => taskName(blocker, from))
    .sort(byName);

/**
 * The Tasks `refs` name: in this conversation, or in the channel a ref names when `member` may
 * read it. One that does not exist, or that `member` may not read, is refused the same way, so
 * the refusal shows nothing of a private channel. Tasks in `except` (those a `create` is making
 * just now) are not there to be named.
 */
async function resolve(
  tx: Transaction,
  scope: Scope,
  member: Member,
  refs: readonly TaskRef[],
  except: readonly TaskKey[] = [],
): Promise<Target[]> {
  const channels = [...new Set(refs.flatMap((ref) => (ref.channel ? [ref.channel] : [])))];
  const readable = channels.length
    ? await tx.conversation.findMany({
        where: {
          AND: [
            visibleChannelWhere(scope.workspaceId, actorOf(member)),
            { channelName: { in: channels } },
          ],
        },
        select: { id: true, channelName: true },
      })
    : [];
  const wanted = refs.map((ref) => ({
    ref,
    conversationId: ref.channel
      ? readable.find((channel) => channel.channelName === ref.channel)?.id
      : scope.conversationId,
  }));
  const numbersIn = new Map<string, number[]>();
  for (const { ref, conversationId } of wanted)
    if (conversationId)
      numbersIn.set(conversationId, [...(numbersIn.get(conversationId) ?? []), ref.number]);
  const rows = numbersIn.size
    ? await tx.task.findMany({
        where: {
          workspaceId: scope.workspaceId,
          id: { notIn: except.map((task) => task.id) },
          OR: [...numbersIn].map(([conversationId, numbers]) => ({
            conversationId,
            number: { in: numbers },
          })),
        },
        select: TARGET_SELECT,
      })
    : [];
  return wanted.map(({ ref, conversationId }) => {
    const row = rows.find((r) => r.conversationId === conversationId && r.number === ref.number);
    if (row) return { ...row, ref };
    throw invalid(
      conversationId === scope.conversationId && except.some((task) => task.number === ref.number)
        ? `task ${refLabel(ref)} is being made by this command; name only tasks that already exist`
        : ref.channel
          ? `task ${refLabel(ref)} does not exist`
          : `task ${refLabel(ref)} does not exist in this conversation`,
    );
  });
}

/** `targets` without repeats: two refs may name one Task, a bare number and its channel. */
const distinctTasks = (targets: readonly Target[]) => [
  ...new Map(targets.map((target) => [target.id, target])).values(),
];

/**
 * Subtasks under a Task freeze it (it cannot finish while they are open), so only its owner, its
 * creator or a manager may add them.
 */
function assertMayAddSubtasks(parent: Target, member: Member, manager: boolean) {
  if (manager || isActor(parent.owner, member) || isActor(parent.creator, member)) return;
  throw new AppError("ACCESS_DENIED", {
    errorId: TASK_RELATION_DENIED,
    hint: `only the owner or creator of task ${refLabel(parent.ref)}, or a Workspace owner or admin, may add sub-tasks under it`,
  });
}

/** `blockers` is already without repeats. */
function checkBlockerCount(blockers: readonly unknown[]) {
  if (blockers.length > MAX_TASK_BLOCKERS)
    throw invalid(`a task may wait for at most ${MAX_TASK_BLOCKERS} others`);
}

/**
 * Link tasks that were just made: they have no edges yet, so only the named Tasks and the depth
 * need checking. History records each link after the creation events. Returns the blockers that
 * are not finished, as this conversation names them.
 */
export async function linkNewTasks(
  tx: Transaction,
  scope: Scope,
  member: Member,
  created: readonly TaskKey[],
  input: Input,
  manager: boolean,
): Promise<TaskName[]> {
  const asked = distinct(input.blockedBy ?? []);
  if (!asked.length && input.parent == null) return [];
  checkBlockerCount(asked);
  // Only tasks that existed before this create: a new task cannot wait for itself or a sibling.
  const blockers = distinctTasks(await resolve(tx, scope, member, asked, created));
  const [parent] =
    input.parent == null ? [] : await resolve(tx, scope, member, [input.parent], created);
  if (parent) assertMayAddSubtasks(parent, member, manager);
  if (parent) {
    const tree = await loadParentTree(tx, scope.workspaceId);
    assertDepth(tree.parentOf, parent.id);
    // Judge what the write produces: each new Task joins the tree under `parent` and waits for
    // `blockers`, so a blocker that is the parent (or above it) is refused.
    const withNew = treeWithChildren(
      tree,
      created.map((task) => task.id),
      parent.id,
    );
    await assertNoTreeDependency(
      tx,
      scope,
      withNew,
      new Map(),
      created.flatMap((task) =>
        blockers.map((blocker) => ({ taskId: task.id, blockerId: blocker.id })),
      ),
      undefined,
      new Map([
        ...created.map((task) => [task.id, `#${task.number}`] as const),
        ...blockers.map((blocker) => [blocker.id, refLabel(blocker.ref)] as const),
      ]),
    );
  }
  const common = { conversationId: scope.conversationId, workspaceId: scope.workspaceId };
  await tx.taskDependency.createMany({
    data: created.flatMap((task) =>
      blockers.map((blocker) => ({
        taskId: task.id,
        blockedByTaskId: blocker.id,
        creatorMemberId: member.id,
        ...common,
      })),
    ),
  });
  if (parent)
    await tx.taskParent.createMany({
      data: created.map((task) => ({ taskId: task.id, parentTaskId: parent.id, ...common })),
    });
  const latest = await tx.taskHistoryEvent.groupBy({
    by: ["taskId"],
    where: { taskId: { in: created.map((task) => task.id) } },
    _max: { seq: true },
  });
  const seqOf = new Map(latest.map((row) => [row.taskId, row._max.seq ?? 0]));
  const changes = [
    ...(blockers.length
      ? [
          depChange(
            blockers.map((blocker) => taskName(blocker, scope.conversationId)),
            [],
          ),
        ]
      : []),
    ...(parent ? [parentChange(null, taskName(parent, scope.conversationId))] : []),
  ];
  await tx.taskHistoryEvent.createMany({
    data: created.flatMap((task) => historyRows(task.id, member, changes, seqOf.get(task.id) ?? 0)),
  });
  return openNames(blockers, scope.conversationId);
}

/** What an amendment of a Task's blockers and parent changes: plain data, nothing written yet. */
export type RelationPlan = {
  /** History events the change records. */
  changes: TaskHistoryChange[];
  /** The Tasks whose blocker rows go, and the Tasks that become blockers. */
  removedIds: string[];
  added: Array<{ id: string }>;
  /** The new parent's id, null to detach; undefined when the parent is not changing. */
  parentTo: string | null | undefined;
  /** The ids of the blockers added that are not finished: what the Task now waits for. */
  newlyOpenBlockers: string[];
  /** Whether the change took away a blocker that was not finished. */
  removedOpenBlocker: boolean;
  /** The parent the Task leaves and the one it joins, whose progress changes. */
  parents: string[];
};

/**
 * Check an amendment of a Task's blockers (the whole new set) and parent (a ref, or null to
 * detach) against the Workspace's graph. Throws `INVALID_INPUT` naming the Tasks when the change
 * is not valid. The Workspace's parent tree and dependency edges are read once; the checks judge
 * the graph the write produces, so a change to both in one command is judged together.
 */
export async function planRelationAmend(
  tx: Transaction,
  scope: Scope,
  member: Member,
  manager: boolean,
  task: TaskKey,
  input: Input,
): Promise<RelationPlan> {
  const plan: RelationPlan = {
    changes: [],
    removedIds: [],
    added: [],
    parentTo: undefined,
    newlyOpenBlockers: [],
    removedOpenBlocker: false,
    parents: [],
  };
  const here = (target: Target) => taskName(target, scope.conversationId);
  // Read both graphs once: the checks below judge the tree and the edges the write produces.
  const [waitsFor, tree] = await Promise.all([
    loadWaitsFor(tx, scope.workspaceId),
    loadParentTree(tx, scope.workspaceId),
  ]);
  /** The blockers the write leaves the Task with, when it changes them. */
  let finalBlockers: string[] | undefined;
  let addedBlockers: Target[] = [];
  /** The Task whose subtree joins a new parent, when the write moves it. */
  let moved: string | undefined;

  if (input.blockedBy !== undefined) {
    const asked = distinct(input.blockedBy);
    checkBlockerCount(asked);
    const blockers = distinctTasks(await resolve(tx, scope, member, asked));
    if (blockers.some((blocker) => blocker.id === task.id))
      throw invalid(`task #${task.number} cannot wait for itself`);
    const own = await tx.taskDependency.findMany({
      where: { taskId: task.id },
      select: {
        blockedByTaskId: true,
        blocker: {
          select: {
            number: true,
            status: true,
            conversation: { select: NAMED_CONVERSATION_SELECT },
          },
        },
      },
    });
    const current = new Set(own.map((edge) => edge.blockedByTaskId));
    const wantedIds = new Set(blockers.map((blocker) => blocker.id));
    const added = blockers.filter((blocker) => !current.has(blocker.id));
    const removed = own.filter((edge) => !wantedIds.has(edge.blockedByTaskId));
    // The Task's own edges are replaced, so the graph the new ones must not close is without them.
    const cycleGraph = new Map(waitsFor);
    cycleGraph.delete(task.id);
    for (const blocker of added) {
      const path = pathBetween(blocker.id, task.id, (id) => cycleGraph.get(id) ?? []);
      if (path)
        throw invalid(
          `${refLabel(blocker.ref)} cannot block #${task.number}: that would make a dependency cycle (${(
            await describe(
              tx,
              scope.conversationId,
              [task.id, ...path],
              new Map([
                [task.id, `#${task.number}`],
                [blocker.id, refLabel(blocker.ref)],
              ]),
            )
          ).join(" → ")}, each waiting for the next)`,
        );
    }
    if (added.length || removed.length) {
      plan.changes.push(
        depChange(
          added.map(here),
          removed.map((edge) => taskName(edge.blocker, scope.conversationId)),
        ),
      );
      plan.removedIds = removed.map((edge) => edge.blockedByTaskId);
      plan.added = added;
      plan.newlyOpenBlockers = added
        .filter((blocker) => !isBlockerSatisfied(blocker.status))
        .map((blocker) => blocker.id);
      plan.removedOpenBlocker = removed.some((edge) => !isBlockerSatisfied(edge.blocker.status));
    }
    finalBlockers = blockers.map((blocker) => blocker.id);
    addedBlockers = added;
  }

  if (input.parent !== undefined) {
    const [ownParent, requested] = await Promise.all([
      tx.taskParent.findUnique({
        where: { taskId: task.id },
        select: {
          parent: {
            select: { id: true, number: true, conversation: { select: NAMED_CONVERSATION_SELECT } },
          },
        },
      }),
      input.parent === null ? [] : resolve(tx, scope, member, [input.parent]),
    ]);
    const from = ownParent?.parent ?? null;
    const parent = requested[0] ?? null;
    if (parent?.id !== from?.id) {
      if (parent) {
        if (parent.id === task.id) throw invalid(`task #${task.number} cannot be its own sub-task`);
        assertMayAddSubtasks(parent, member, manager);
        const up = pathBetween(parent.id, task.id, (id) => {
          const above = tree.parentOf.get(id);
          return above ? [above] : [];
        });
        if (up)
          throw invalid(
            `#${task.number} cannot be a sub-task of ${refLabel(parent.ref)}: ${refLabel(parent.ref)} is already below it (${(
              await describe(
                tx,
                scope.conversationId,
                up.reverse(),
                new Map([
                  [task.id, `#${task.number}`],
                  [parent.id, refLabel(parent.ref)],
                ]),
              )
            ).join(" → ")}, each a sub-task of the previous)`,
          );
        assertDepth(tree.parentOf, parent.id, descend(task.id, tree.childrenOf).length);
      }
      plan.changes.push(
        parentChange(from && taskName(from, scope.conversationId), parent && here(parent)),
      );
      plan.parentTo = parent?.id ?? null;
      plan.parents = [from?.id, parent?.id].filter((id): id is string => !!id);
      // Detaching removes ancestor relations; joining a real parent can create them.
      if (parent) moved = task.id;
    }
  }

  // Judge what the write produces, whichever of the tree and the edges it changed: an added
  // blocker against the post-write tree, and a moved subtree against its new ancestors.
  if (addedBlockers.length || moved) {
    const postTree =
      plan.parentTo !== undefined ? treeWithParent(tree, task.id, plan.parentTo) : tree;
    const postWaits = new Map(waitsFor);
    if (finalBlockers) postWaits.set(task.id, finalBlockers);
    await assertNoTreeDependency(
      tx,
      scope,
      postTree,
      postWaits,
      addedBlockers.map((blocker) => ({ taskId: task.id, blockerId: blocker.id })),
      moved,
      new Map<string, string>([
        [task.id, `#${task.number}`],
        ...addedBlockers.map((blocker) => [blocker.id, refLabel(blocker.ref)] as const),
      ]),
    );
  }
  return plan;
}

/** Write what `planRelationAmend` planned. */
export async function applyRelationPlan(
  tx: Transaction,
  scope: Scope,
  member: Member,
  task: TaskKey,
  plan: RelationPlan,
) {
  const common = { conversationId: scope.conversationId, workspaceId: scope.workspaceId };
  if (plan.removedIds.length)
    await tx.taskDependency.deleteMany({
      where: { taskId: task.id, blockedByTaskId: { in: plan.removedIds } },
    });
  if (plan.added.length)
    await tx.taskDependency.createMany({
      data: plan.added.map((blocker) => ({
        taskId: task.id,
        blockedByTaskId: blocker.id,
        creatorMemberId: member.id,
        ...common,
      })),
    });
  if (plan.parentTo === null) await tx.taskParent.deleteMany({ where: { taskId: task.id } });
  else if (plan.parentTo !== undefined)
    await tx.taskParent.upsert({
      where: { taskId: task.id },
      create: { taskId: task.id, parentTaskId: plan.parentTo, ...common },
      update: { parentTaskId: plan.parentTo },
    });
}
