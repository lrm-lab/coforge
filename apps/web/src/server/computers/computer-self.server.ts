import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { prepareDaemonApiKey } from "#src/server/auth/daemon-api-key.server";
import type { DaemonApiKeyClaims } from "#src/server/auth/daemon-api-key.server";
import {
  reconnectDaemon,
  type CentrifugoConnections,
} from "#src/server/centrifugo/server-api.server";
import { removeComputerFromWorkspace } from "#src/server/computers/computer-membership.server";

type Db =
  | Prisma.TransactionClient
  | Pick<PrismaClient, "daemonApiKey" | "workspaceComputer" | "computer">;

const audit = (detail: Record<string, unknown>) =>
  console.info(JSON.stringify({ event: "computer_credential", ...detail }));

/** The key a swap-key issued: `kind: "computer"`, `revokedAt` still null until confirm. A
 * daemonApiKey holds the lock on its Computer's row so a double-swap cannot leave two live
 * `sk_computer`s. */
export async function swapKey(tx: Prisma.TransactionClient, principal: DaemonApiKeyClaims) {
  if (principal.kind !== "daemon")
    return Response.json({ error: "only a daemonApiKey may swap" }, { status: 403 });
  await tx.$queryRaw`SELECT "id" FROM "computers" WHERE "id" = ${principal.computerId}::uuid FOR UPDATE`;
  await tx.daemonApiKey.updateMany({
    where: {
      computerId: principal.computerId,
      workspaceId: principal.workspaceId,
      kind: "computer",
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  const computer = await tx.computer.findUniqueOrThrow({
    where: { id: principal.computerId },
    select: { id: true, name: true },
  });
  const { apiKey, record } = prepareDaemonApiKey({
    principal: { userId: principal.userId },
    workspaceId: principal.workspaceId,
    computerId: principal.computerId,
    kind: "computer",
  });
  await tx.daemonApiKey.create({ data: record });
  audit({
    action: "key_swapped",
    computer_id: principal.computerId,
    workspace_id: principal.workspaceId,
  });
  return Response.json({ apiKey, computerName: computer.name }, { status: 200 });
}

/** The confirm an `sk_computer` runs after it verified itself: revokes the daemonApiKey it
 * replaced, plus every other unconfirmed `sk_computer` a repeated swap-key left. Only a
 * `computer` key may confirm — the old `daemonApiKey` cannot confirm itself away. */
export async function confirmKey(tx: Prisma.TransactionClient, principal: DaemonApiKeyClaims) {
  if (principal.kind !== "computer")
    return Response.json({ error: "only an sk_computer may confirm" }, { status: 403 });
  await tx.$queryRaw`SELECT "id" FROM "computers" WHERE "id" = ${principal.computerId}::uuid FOR UPDATE`;
  await tx.daemonApiKey.updateMany({
    where: {
      computerId: principal.computerId,
      workspaceId: principal.workspaceId,
      kind: "daemon",
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  const others = await tx.daemonApiKey.findMany({
    where: {
      computerId: principal.computerId,
      workspaceId: principal.workspaceId,
      kind: "computer",
      revokedAt: null,
      apiKeyHash: { not: principal.apiKeyHash },
    },
    select: { id: true },
  });
  if (others.length)
    await tx.daemonApiKey.updateMany({
      where: { id: { in: others.map(({ id }) => id) } },
      data: { revokedAt: new Date() },
    });
  audit({
    action: "key_confirmed",
    computer_id: principal.computerId,
    workspace_id: principal.workspaceId,
  });
  return Response.json({ ok: true }, { status: 200 });
}

/** The computer's own row, for the daemon's startup check. Only `kind: "computer"`. */
export async function selfComputer(db: Db, principal: DaemonApiKeyClaims) {
  if (principal.kind !== "computer")
    return Response.json({ error: "only an sk_computer may read self" }, { status: 403 });
  const computer = await db.computer.findUniqueOrThrow({
    where: { id: principal.computerId },
    select: { id: true, name: true, machineId: true, platform: true },
  });
  return Response.json(computer, { status: 200 });
}

/** The computer unlinks itself from the Workspace — `removeComputerFromWorkspace` with the
 * `computerId` its key carries rather than an owner's choice: the `sk_computer`'s owner is the
 * Computer's owner, so the membership check passes. The transaction commits the revocation and
 * the link removal; `notify` and `reconnectDaemon` run after, so the open connection meets the
 * refusal only once the revoke is durable, and a Centrifugo failure leaves the unlink in place.
 * Only `kind: "computer"`. */
export async function detachComputer(
  db: Pick<PrismaClient, "computer" | "$transaction">,
  api: CentrifugoConnections,
  notify: (computerId: string) => void,
  principal: DaemonApiKeyClaims,
) {
  if (principal.kind !== "computer")
    return Response.json({ error: "only an sk_computer may detach" }, { status: 403 });
  await removeComputerFromWorkspace(db, {
    userId: principal.userId,
    workspaceId: principal.workspaceId,
    computerId: principal.computerId,
  });
  notify(principal.computerId);
  audit({
    action: "detached",
    actor: "computer",
    computer_id: principal.computerId,
    workspace_id: principal.workspaceId,
  });
  try {
    await reconnectDaemon(api, principal.workspaceId, principal.computerId);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "computer:detach_reconnect_failed",
        workspace_id: principal.workspaceId,
        computer_id: principal.computerId,
        error_type: error instanceof Error ? error.name : "unknown",
      }),
    );
  }
  return Response.json({ ok: true }, { status: 200 });
}
