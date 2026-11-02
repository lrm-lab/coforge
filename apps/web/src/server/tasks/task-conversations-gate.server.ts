import { AsyncLocalStorage } from "node:async_hooks";
import { AppError } from "#src/lib/app-error";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import type { TaskPrincipal } from "@lrm/coforge-sdk/internal";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { Experiments } from "#src/server/experiments/experiments.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";

/** The switch each Workspace had when the running Task operation first read it. */
const switchesRead = new AsyncLocalStorage<Map<string, Promise<boolean>>>();

/**
 * Run one Task operation so that the experiment is read once for it, however many Tasks, gates and
 * views ask: the first read per Workspace is kept for everything the operation awaits.
 */
export const withExperimentRead = <T>(run: () => Promise<T>) => switchesRead.run(new Map(), run);

/** Whether task conversations apply in the principal's Workspace: its owner or an admin switched
 * the `taskConversations` experiment on, for everyone and every Agent in it. */
export function taskConversationsEnabled(
  db: PrismaClient,
  principal: Pick<TaskPrincipal, "workspaceId">,
) {
  const reads = switchesRead.getStore();
  const kept = reads?.get(principal.workspaceId);
  if (kept) return kept;
  const read = readSwitch(db, principal);
  reads?.set(principal.workspaceId, read);
  return read;
}

/**
 * Whether Task relations (blockers and subtasks) apply in a Workspace. They are part of the same
 * experiment as task conversations ("Tasks v2"): off, the Workspace behaves as it did before them
 * and the rows already written wait, unread, for it to be switched on again. `db` may be a
 * transaction: the read touches only the Workspace row.
 */
export const taskRelationsEnabled = (
  db: PrismaClient | Prisma.TransactionClient,
  workspaceId: string,
) => taskConversationsEnabled(db as PrismaClient, { workspaceId });

async function readSwitch(db: PrismaClient, principal: Pick<TaskPrincipal, "workspaceId">) {
  const workspace = await db.workspace.findUnique({
    where: { id: principal.workspaceId },
    select: { slug: true },
  });
  if (!workspace) return false;
  return new Experiments(new PrismaExperimentsRepository(db), isFeatureEnabled).enabled(
    "taskConversations",
    { workspaceId: principal.workspaceId, workspaceSlug: workspace.slug },
  );
}

/** `taskConversationsEnabled` for one Agent, as the gate the task conversation routes take. */
export function taskConversationsGate(
  db: PrismaClient,
  principal: { workspaceId: string; agentId: string },
) {
  return () => taskConversationsEnabled(db, principal);
}

export const TASK_RELATIONS_OFF = "task_relations_off";

/** The refusal of a blocker, a parent or `--ready` in a Workspace that has not switched on Tasks v2. */
export const relationsOffRefusal = () =>
  new AppError("INVALID_INPUT", {
    errorId: TASK_RELATIONS_OFF,
    hint: "this Workspace has not enabled task dependencies and sub-tasks (Tasks v2 under Settings > Experiments, switched on by a Workspace owner or admin); --blocked-by, --parent and --ready are not available",
  });
