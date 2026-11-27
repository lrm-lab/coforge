import { timingSafeEqual } from "node:crypto";
import {
  COMPUTER_ATTACH_SESSION_PROTOCOL_MAJOR,
  ComputerAttachErrorCode,
} from "@lrm/coforge-sdk/internal/computer-attach-session";
import type { ComputerAttachSession, Prisma } from "#src/generated/prisma/client";
import { sha256Hex } from "#src/server/auth/opaque-token.server";

export const ATTACH_COMPLETION_MS = 600_000;
export const ATTACH_POLL_MS = 3_000;

export class AttachSessionError extends Error {
  constructor(
    readonly code: ComputerAttachErrorCode,
    readonly retryAfterSeconds?: number,
  ) {
    super(ComputerAttachErrorCode[code]);
    this.name = "AttachSessionError";
  }
}

export function matchesAttachSecret(expected: string | null, value: string): boolean {
  if (!expected) return false;
  const expectedBytes = Buffer.from(expected, "hex");
  const actualBytes = Buffer.from(sha256Hex(value), "hex");
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export async function lockAttachSession(tx: Prisma.TransactionClient, id: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM computer_attach_sessions
      WHERE id = ${id}::uuid AND protocol_major = ${COMPUTER_ATTACH_SESSION_PROTOCOL_MAJOR}
      FOR UPDATE`;
  if (!locked.length) return null;
  return tx.computerAttachSession.findUnique({ where: { id } });
}

export async function lockAttachMembership(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  userId: string,
): Promise<string | undefined> {
  const [membership] = await tx.$queryRaw<{ role: string }[]>`
    SELECT role FROM workspace_memberships
      WHERE "workspaceId" = ${workspaceId}::uuid AND "userId" = ${userId}::uuid
      FOR SHARE`;
  return membership?.role;
}

export function isAttachAdministrator(role: string | undefined): boolean {
  return role === "admin" || role === "owner";
}

export function completionDeadline(session: ComputerAttachSession): number {
  return session.approvedAt ? session.approvedAt.getTime() + ATTACH_COMPLETION_MS : 0;
}

export async function expireAttachSession(
  tx: Prisma.TransactionClient,
  session: ComputerAttachSession,
  now: Date,
): Promise<AttachSessionError | undefined> {
  if (session.status === "denied")
    return new AttachSessionError(ComputerAttachErrorCode.ATTACH_DENIED);
  if (session.status === "failed")
    return new AttachSessionError(ComputerAttachErrorCode.COMPLETION_TIMEOUT);
  if (session.status === "expired")
    return new AttachSessionError(ComputerAttachErrorCode.ATTACH_SESSION_EXPIRED);

  const approvalExpired = session.status === "awaiting_approval" && session.expiresAt <= now;
  const completionExpired =
    ["approved", "completing"].includes(session.status) &&
    completionDeadline(session) <= now.getTime();
  if (!approvalExpired && !completionExpired) return undefined;

  await tx.computerAttachSession.update({
    where: { id: session.id },
    data: {
      status: approvalExpired ? "expired" : "failed",
      terminalAt: now,
      failureReason: approvalExpired ? "approval_expired" : "completion_timeout",
      nonceHash: null,
      candidateKeyHash: null,
      attachTokenHash: null,
    },
  });
  return new AttachSessionError(
    approvalExpired
      ? ComputerAttachErrorCode.ATTACH_SESSION_EXPIRED
      : ComputerAttachErrorCode.COMPLETION_TIMEOUT,
  );
}
