import {
  ComputerAttachErrorCode,
  type ComputerAttachSessionCompleteRequest,
} from "@lrm/coforge-sdk/internal/computer-attach-session";
import { verifyAttachProof } from "@lrm/coforge-sdk/internal/computer-attach-proof";
import { RFC_UUID_PATTERN } from "@lrm/coforge-sdk/internal";
import type { ComputerAttachSession, Prisma, PrismaClient } from "#src/generated/prisma/client";
import {
  hashDaemonApiKey,
  isDaemonApiKey,
  prepareDaemonApiKey,
} from "#src/server/auth/daemon-api-key.server";
import {
  AttachSessionError,
  expireAttachSession,
  isAttachAdministrator,
  lockAttachMembership,
  lockAttachSession,
  matchesAttachSecret,
} from "./computer-attach-session-state.server";

async function attachPrincipal(tx: Prisma.TransactionClient, session: ComputerAttachSession) {
  if (
    !session.approvedWorkspaceId ||
    !session.approvedUserId ||
    !session.machineId ||
    !session.machinePublicKey
  )
    return new AttachSessionError(ComputerAttachErrorCode.ATTACH_SESSION_EXPIRED);
  const workspaceId = session.approvedWorkspaceId;
  const recovering = session.attachIntent === "recover";
  const approverRole = await lockAttachMembership(tx, workspaceId, session.approvedUserId);
  if (recovering ? !approverRole : !isAttachAdministrator(approverRole))
    return new AttachSessionError(ComputerAttachErrorCode.REQUIRES_ADMIN);
  const workspace = await tx.workspace.findUnique({
    where: { id: workspaceId },
    select: { slug: true },
  });
  if (!workspace) return new AttachSessionError(ComputerAttachErrorCode.SERVER_NOT_FOUND);

  const existingId = session.existingComputerId;
  if (!existingId) {
    return { workspaceId, workspaceSlug: workspace.slug, ownerId: session.approvedUserId };
  }

  const [computer] = await tx.$queryRaw<{ ownerId: string }[]>`
    SELECT "ownerId" FROM computers WHERE id = ${existingId}::uuid AND "deletedAt" IS NULL
      AND kind = 'local' AND "machineId" = ${session.machineId}
      FOR UPDATE`;
  if (!computer || !(await lockAttachMembership(tx, workspaceId, computer.ownerId)))
    return new AttachSessionError(ComputerAttachErrorCode.INVALID_CREDENTIAL);

  if (recovering) {
    const [binding] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM workspace_computers
        WHERE "workspaceId" = ${workspaceId}::uuid AND "computerId" = ${existingId}::uuid
          AND attach_machine_public_key = ${session.machinePublicKey}
        FOR UPDATE`;
    if (!binding || computer.ownerId !== session.approvedUserId)
      return new AttachSessionError(ComputerAttachErrorCode.RECOVERY_UNAVAILABLE);
  }
  return { workspaceId, workspaceSlug: workspace.slug, ownerId: computer.ownerId };
}

export async function completeComputerAttachSession(
  db: PrismaClient,
  id: string,
  request: Pick<ComputerAttachSessionCompleteRequest, "nonce" | "attachTicket" | "signature">,
  { origin, now = new Date() }: { origin: string; now?: Date },
) {
  if (!RFC_UUID_PATTERN.test(id))
    throw new AttachSessionError(ComputerAttachErrorCode.ATTACH_SESSION_EXPIRED);

  const result = await db.$transaction(async (tx) => {
    const session = await lockAttachSession(tx, id);
    if (!session) return new AttachSessionError(ComputerAttachErrorCode.ATTACH_SESSION_EXPIRED);
    const expired = await expireAttachSession(tx, session, now);
    if (expired) return expired;

    const resumed = session.status === "completing";
    if (
      !(resumed || session.status === "approved") ||
      !session.nonceExpiresAt ||
      session.nonceExpiresAt <= now ||
      !matchesAttachSecret(session.nonceHash, request.nonce) ||
      (resumed && request.attachTicket !== undefined) ||
      (!resumed &&
        (!request.attachTicket ||
          !matchesAttachSecret(session.attachTokenHash, request.attachTicket)))
    )
      return new AttachSessionError(ComputerAttachErrorCode.TICKET_CONSUMED);

    if (
      !session.machinePublicKey ||
      !(await verifyAttachProof(
        session.machinePublicKey,
        { origin, sessionId: id, purpose: resumed ? "resume" : "complete", nonce: request.nonce },
        request.signature,
      ))
    )
      return new AttachSessionError(ComputerAttachErrorCode.MACHINE_KEY_MISMATCH);

    const principal = await attachPrincipal(tx, session);
    if (principal instanceof AttachSessionError) return principal;
    const computerId =
      session.existingComputerId ?? session.candidateComputerId ?? Bun.randomUUIDv7();
    const credential = prepareDaemonApiKey({
      principal: { userId: principal.ownerId },
      workspaceId: principal.workspaceId,
      computerId,
      kind: "computer",
    });
    await tx.computerAttachSession.update({
      where: { id },
      data: {
        status: "completing",
        candidateComputerId: computerId,
        candidateKeyHash: credential.record.apiKeyHash,
        nonceHash: null,
        nonceExpiresAt: null,
        attachTokenHash: null,
        attachTokenExpiresAt: null,
        tokenConsumedAt: now,
      },
    });
    return {
      computerId,
      workspaceId: principal.workspaceId,
      workspaceSlug: principal.workspaceSlug,
      resumed,
      apiKey: credential.apiKey,
    };
  });
  if (result instanceof AttachSessionError) throw result;
  return result;
}

export async function preflightComputerAttachSession(
  db: PrismaClient,
  id: string,
  apiKey: string,
  now = new Date(),
) {
  if (!RFC_UUID_PATTERN.test(id) || !isDaemonApiKey(apiKey) || !apiKey.startsWith("sk_computer_"))
    throw new AttachSessionError(ComputerAttachErrorCode.INVALID_CREDENTIAL);
  const keyHash = hashDaemonApiKey(apiKey);
  const result = await db.$transaction(async (tx) => {
    const session = await lockAttachSession(tx, id);
    if (!session) return new AttachSessionError(ComputerAttachErrorCode.INVALID_CREDENTIAL);
    const expired = await expireAttachSession(tx, session, now);
    if (expired) return expired;

    const computerId = session.candidateComputerId;
    if (!computerId || !session.approvedWorkspaceId)
      return new AttachSessionError(ComputerAttachErrorCode.INVALID_CREDENTIAL);
    if (session.status === "bound" || session.status === "ready") {
      if (!matchesAttachSecret(session.activatedKeyHash, apiKey))
        return new AttachSessionError(ComputerAttachErrorCode.INVALID_CREDENTIAL);
      const active = await tx.daemonApiKey.findFirst({
        where: {
          apiKeyHash: keyHash,
          computerId,
          workspaceId: session.approvedWorkspaceId,
          revokedAt: null,
          computer: {
            deletedAt: null,
            workspaces: { some: { workspaceId: session.approvedWorkspaceId } },
          },
        },
        select: { workspace: { select: { slug: true } }, ownerId: true },
      });
      if (!active || !(await lockAttachMembership(tx, session.approvedWorkspaceId, active.ownerId)))
        return new AttachSessionError(ComputerAttachErrorCode.INVALID_CREDENTIAL);
      return {
        computerId,
        workspaceId: session.approvedWorkspaceId,
        workspaceSlug: active.workspace.slug,
      };
    }
    if (session.status !== "completing" || !matchesAttachSecret(session.candidateKeyHash, apiKey))
      return new AttachSessionError(ComputerAttachErrorCode.INVALID_CREDENTIAL);

    const principal = await attachPrincipal(tx, session);
    if (principal instanceof AttachSessionError) return principal;
    const { workspaceId, workspaceSlug, ownerId } = principal;

    if (!session.existingComputerId) {
      const created = await tx.computer.createMany({
        data: {
          id: computerId,
          ownerId,
          machineId: session.machineId!,
          name: session.machineName,
          displayName: session.machineName,
          platform: session.os,
          osVersion: session.osVersion,
          computerVersion: session.computerVersion,
        },
        skipDuplicates: true,
      });
      if (!created.count) return new AttachSessionError(ComputerAttachErrorCode.COMPUTER_CONFLICT);
    }

    if (session.attachIntent !== "recover") {
      const attachMachinePublicKey = session.machinePublicKey!;
      await tx.workspaceComputer.upsert({
        where: { workspaceId_computerId: { workspaceId, computerId } },
        create: { workspaceId, computerId, attachMachinePublicKey },
        update: { attachMachinePublicKey },
      });
    }
    await tx.daemonApiKey.updateMany({
      where: { workspaceId, computerId, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.daemonApiKey.create({
      data: { workspaceId, computerId, ownerId, apiKeyHash: keyHash, kind: "computer" },
    });
    await tx.computerAttachSession.update({
      where: { id },
      data: { status: "bound", boundAt: now, activatedKeyHash: keyHash, candidateKeyHash: null },
    });
    return { computerId, workspaceId, workspaceSlug };
  });
  if (result instanceof AttachSessionError) throw result;
  return result;
}
