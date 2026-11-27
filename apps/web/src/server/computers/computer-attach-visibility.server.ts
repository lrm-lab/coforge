import { COMPUTER_ATTACH_SESSION_PROTOCOL_MAJOR as protocolMajor } from "@lrm/coforge-sdk/internal/computer-attach-session";
import { attachPublicKeyFingerprint } from "@lrm/coforge-sdk/internal/computer-attach-proof";
import type { PrismaClient } from "#src/generated/prisma/client";
import { ATTACH_COMPLETION_MS, lockAttachMembership } from "./computer-attach-session-state.server";

const TERMINAL_RETENTION_MS = 86_400_000;
const MAX_VISIBLE_REQUESTS = 50;
const SWEEP_BATCH = 150;

export async function readMachineAttachApproval(
  db: PrismaClient,
  id: string,
  viewerId: string,
  now = new Date(),
) {
  const session = await db.computerAttachSession.findUnique({
    where: { id, protocolMajor },
    select: {
      machineName: true,
      hostname: true,
      os: true,
      machinePublicKey: true,
      targetWorkspaceId: true,
      status: true,
      expiresAt: true,
    },
  });
  if (
    !session?.machinePublicKey ||
    session.status !== "awaiting_approval" ||
    session.expiresAt <= now
  )
    return null;
  const workspaces = await db.workspace.findMany({
    where: {
      ...(session.targetWorkspaceId ? { id: session.targetWorkspaceId } : {}),
      members: { some: { userId: viewerId, role: { in: ["owner", "admin"] } } },
    },
    select: { id: true, slug: true },
    orderBy: { slug: "asc" },
  });
  if (!workspaces.length) return null;
  return {
    machineName: session.machineName,
    hostname: session.hostname,
    os: session.os,
    fingerprint: await attachPublicKeyFingerprint(session.machinePublicKey),
    workspaces,
  };
}

export async function listMachineAttachRequests(
  db: PrismaClient,
  workspaceId: string,
  viewerId: string,
  now = new Date(),
) {
  return db.$transaction(async (tx) => {
    const role = await lockAttachMembership(tx, workspaceId, viewerId);
    if (role !== "admin") return [];
    const rows = await tx.computerAttachSession.findMany({
      where: {
        protocolMajor,
        targetWorkspaceId: workspaceId,
        attachIntent: "attach",
        expiresAt: { gte: new Date(now.getTime() - TERMINAL_RETENTION_MS) },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_VISIBLE_REQUESTS,
      select: {
        id: true,
        machineName: true,
        status: true,
        failureReason: true,
        createdAt: true,
        approvedAt: true,
        expiresAt: true,
        terminalAt: true,
        boundAt: true,
        readyAt: true,
      },
    });
    return rows.map((row) => {
      const deadline = row.approvedAt
        ? new Date(row.approvedAt.getTime() + ATTACH_COMPLETION_MS)
        : row.expiresAt;
      const pending = row.status === "awaiting_approval";
      const completing = row.status === "approved" || row.status === "completing";
      const timedOut = (pending || completing) && deadline <= now;
      return {
        id: row.id,
        machineName: row.machineName,
        createdAt: row.createdAt.toISOString(),
        status: timedOut ? (pending ? "expired" : "failed") : row.status,
        failureReason: timedOut
          ? pending
            ? "approval_expired"
            : "completion_timeout"
          : row.failureReason,
        expiresAt: deadline.toISOString(),
        finishedAt: (timedOut
          ? deadline
          : (row.terminalAt ?? row.readyAt ?? row.boundAt)
        )?.toISOString(),
      };
    });
  });
}

export async function sweepMachineAttachSessions(db: Pick<PrismaClient, "$executeRaw">, now: Date) {
  await db.$executeRaw`
    WITH due AS (
      SELECT id, status, CASE WHEN status = 'awaiting_approval' THEN expires_at
        ELSE approved_at + INTERVAL '10 minutes' END AS deadline
      FROM computer_attach_sessions
      WHERE protocol_major = ${protocolMajor}
        AND ((status = 'awaiting_approval' AND expires_at <= ${now})
          OR (status IN ('approved', 'completing') AND approved_at <= ${new Date(now.getTime() - ATTACH_COMPLETION_MS)}))
      ORDER BY expires_at, id LIMIT ${SWEEP_BATCH} FOR UPDATE SKIP LOCKED
    )
    UPDATE computer_attach_sessions AS session
       SET status = CASE WHEN due.status = 'awaiting_approval' THEN 'expired' ELSE 'failed' END,
           failure_reason = CASE WHEN due.status = 'awaiting_approval' THEN 'approval_expired' ELSE 'completion_timeout' END,
           terminal_at = due.deadline, nonce_hash = NULL, candidate_key_hash = NULL, attach_token_hash = NULL
      FROM due WHERE session.id = due.id`;
  return db.$executeRaw`
    DELETE FROM computer_attach_sessions
     WHERE id IN (
       SELECT id FROM computer_attach_sessions
        WHERE protocol_major = ${protocolMajor}
          AND COALESCE(terminal_at, ready_at, bound_at) < ${new Date(now.getTime() - TERMINAL_RETENTION_MS)}
        ORDER BY expires_at, id LIMIT ${SWEEP_BATCH} FOR UPDATE SKIP LOCKED
     )`;
}
