import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { DaemonCredentialRevocations } from "#src/server/db/repositories/daemon-credential-revocation.repositories.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import {
  visibleAgentWhere,
  type AgentVisibilityViewer,
} from "#src/server/agents/agent-visibility.server";

/**
 * Whether the Computer is connected to the Workspace and the User is a member of that Workspace.
 *
 * The membership filter is declared against `Prisma.WorkspaceWhereInput` on its own rather than
 * inlined under `workspace:`: nested relation filters are a union type, where TypeScript does not
 * report an unknown key, so a misspelt relation (`memberships` is the User side; the Workspace
 * side is `members`) compiled and only failed at request time as a Prisma validation error.
 */
export async function isWorkspaceMemberComputer(
  db: Pick<PrismaClient, "workspaceComputer">,
  scope: { userId: string; workspaceId: string; computerId: string },
): Promise<boolean> {
  const hasMember: Prisma.WorkspaceWhereInput = { members: { some: { userId: scope.userId } } };
  const connection = await db.workspaceComputer.findFirst({
    where: { workspaceId: scope.workspaceId, computerId: scope.computerId, workspace: hasMember },
    select: { id: true },
  });
  return Boolean(connection);
}

/**
 * Who may restart a Computer: its owner, and the Workspace's owners and admins, who must be able to
 * free a Computer that hangs. A restart stops every Agent on it, so an ordinary member may not.
 */
export function mayRestartComputer(
  viewer: { userId: string; role: string | undefined },
  computer: { ownerId: string | null },
): boolean {
  return computer.ownerId === viewer.userId || viewer.role === "owner" || viewer.role === "admin";
}

/** `mayRestartComputer` for a Computer connected to the Workspace the User is a member of. */
export async function canRestartWorkspaceComputer(
  db: Pick<PrismaClient, "workspaceComputer">,
  scope: { userId: string; workspaceId: string; computerId: string },
): Promise<boolean> {
  const connection = await db.workspaceComputer.findFirst({
    where: { workspaceId: scope.workspaceId, computerId: scope.computerId },
    select: {
      computer: { select: { ownerId: true } },
      workspace: {
        select: { members: { where: { userId: scope.userId }, select: { role: true } } },
      },
    },
  });
  const member = connection?.workspace.members[0];
  return Boolean(
    connection &&
    member &&
    mayRestartComputer({ userId: scope.userId, role: member.role }, connection.computer),
  );
}

/** Removes an owner's local Computer from one Workspace while preserving its identity elsewhere. */
export async function removeComputerFromWorkspace(
  db: Pick<PrismaClient, "computer" | "$transaction">,
  scope: { userId: string; workspaceId: string; computerId: string },
  now: Date = new Date(),
): Promise<void> {
  const computer = await db.computer.findFirst({
    where: {
      id: scope.computerId,
      ownerId: scope.userId,
      workspaces: { some: { workspaceId: scope.workspaceId } },
    },
    select: { id: true, kind: true },
  });
  if (!computer) throw new Error("Computer is not available");
  if (computer.kind !== "local") throw new Error("Only local Computers can be removed");

  await db.$transaction(async (tx) => {
    await DaemonCredentialRevocations.recordForComputer(
      tx,
      { workspaceId: scope.workspaceId, computerId: computer.id },
      now,
    );
    await tx.daemonApiKey.updateMany({
      where: { workspaceId: scope.workspaceId, computerId: computer.id, revokedAt: null },
      data: { revokedAt: now },
    });
    const result = await tx.workspaceComputer.deleteMany({
      where: { workspaceId: scope.workspaceId, computerId: computer.id },
    });
    if (result.count !== 1) throw new Error("Computer is not available");
  });
}

// The two halves of "the departing member's Computers in this Workspace": their live daemon
// keys and the links to Computers they own. `departingMemberComputerIds` and
// `unlinkDepartingMemberComputers` share them so a preview can never drift from the unlink.
function departingLiveKeysWhere(scope: {
  workspaceId: string;
  userId: string;
}): Prisma.DaemonApiKeyWhereInput {
  return { workspaceId: scope.workspaceId, ownerId: scope.userId, revokedAt: null };
}

function departingOwnLinksWhere(scope: {
  workspaceId: string;
  userId: string;
}): Prisma.WorkspaceComputerWhereInput {
  return { workspaceId: scope.workspaceId, computer: { ownerId: scope.userId } };
}

/** The Computers a departing member's live daemon keys and owned Workspace links cover in this
 * Workspace — exactly the set `unlinkDepartingMemberComputers` disconnects. */
async function departingMemberComputerIds(
  db: Pick<PrismaClient, "daemonApiKey" | "workspaceComputer">,
  scope: { workspaceId: string; userId: string },
): Promise<string[]> {
  const [keyed, linked] = await Promise.all([
    db.daemonApiKey.findMany({
      where: departingLiveKeysWhere(scope),
      select: { computerId: true },
    }),
    db.workspaceComputer.findMany({
      where: departingOwnLinksWhere(scope),
      select: { computerId: true },
    }),
  ]);
  return [...new Set([...keyed, ...linked].map(({ computerId }) => computerId))];
}

export type DepartingMemberComputer = {
  id: string;
  name: string;
  displayName: string;
  kind: string;
  cloudSlot: string | null;
  /** Every live Agent this Workspace has placed on the Computer, whoever may see them named. */
  agentCount: number;
  /** The live Agents `viewer` may see, so the confirmation can name who goes offline. */
  agents: { id: string; name: string; displayName: string }[];
};

/**
 * What a confirmation dialog lists before a member leaves or is removed: the Computers
 * `unlinkDepartingMemberComputers` would disconnect, each with the live Agents this Workspace
 * placed on it. Names follow `visibleAgentWhere` for `viewer`; `agentCount` stays whole so a
 * hidden Agent still counts toward "N Agents go offline" without leaking its name.
 */
export async function previewDepartingMemberComputers(
  db: Pick<PrismaClient, "computer" | "daemonApiKey" | "workspaceComputer">,
  scope: { workspaceId: string; userId: string; viewer: AgentVisibilityViewer },
): Promise<DepartingMemberComputer[]> {
  const ids = await departingMemberComputerIds(db, scope);
  if (ids.length === 0) return [];
  const rows = await db.computer.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      name: true,
      displayName: true,
      kind: true,
      cloudSlot: true,
      _count: {
        select: {
          agents: { where: { workspaceId: scope.workspaceId, ...ACTIVE_AGENT_WHERE } },
        },
      },
      agents: {
        where: {
          workspaceId: scope.workspaceId,
          ...ACTIVE_AGENT_WHERE,
          ...visibleAgentWhere(scope.viewer),
        },
        select: { id: true, name: true, displayName: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  return rows.map(({ _count, agents, ...computer }) => ({
    ...computer,
    agentCount: _count.agents,
    agents,
  }));
}

/**
 * Takes a person's Computers out of a Workspace they no longer belong to, inside the transaction
 * that ends their membership: records `computer_unlinked` for the live daemon keys they own there,
 * revokes those keys, and removes the links between the Workspace and the Computers they own.
 * Their keys and links for any other Workspace stay. Resolves with the Computers whose daemon
 * connection for this Workspace must reconnect after the commit (`reconnectDaemon`), so the
 * connect proxy refuses it now rather than at its next reconnect.
 */
export async function unlinkDepartingMemberComputers(
  tx: Prisma.TransactionClient,
  scope: { workspaceId: string; userId: string },
  now: Date = new Date(),
): Promise<{ computerIds: string[] }> {
  const liveKeys = departingLiveKeysWhere(scope);
  const ownLinks = departingOwnLinksWhere(scope);
  const computerIds = await departingMemberComputerIds(tx, scope);
  // Recorded before the revoke: only live keys are recorded.
  const revocations = await DaemonCredentialRevocations.recordForMember(tx, scope, now);
  await tx.daemonApiKey.updateMany({ where: liveKeys, data: { revokedAt: now } });
  await tx.workspaceComputer.deleteMany({ where: ownLinks });
  console.info(
    JSON.stringify({
      event: "workspace_member:computers_unlinked",
      workspace_id: scope.workspaceId,
      computer_count: computerIds.length,
      revocations,
    }),
  );
  return { computerIds };
}
