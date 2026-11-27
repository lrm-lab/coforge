import {
  COMPUTER_ATTACH_SESSION_PROTOCOL_MAJOR,
  ComputerAttachErrorCode,
  ComputerAttachSessionIntent,
  ComputerAttachSessionState,
  type ComputerAttachSessionCreateRequest,
} from "@lrm/coforge-sdk/internal/computer-attach-session";
import { RFC_UUID_PATTERN } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { mintOpaqueToken, sha256Hex } from "#src/server/auth/opaque-token.server";
import { mintComputerAttachUserCode } from "./computer-attach.server";
import {
  ATTACH_COMPLETION_MS,
  ATTACH_POLL_MS,
  AttachSessionError,
  completionDeadline,
  expireAttachSession,
  isAttachAdministrator,
  lockAttachMembership,
  lockAttachSession,
  matchesAttachSecret,
} from "./computer-attach-session-state.server";

const ATTACH_TICKET_MS = 300_000;

type AttachStartOptions = {
  origin: string;
  now?: Date;
  linkedComputer?: { computerId: string; ownerId: string };
};

function validateCreate(request: ComputerAttachSessionCreateRequest) {
  const fields = [request.machineId, request.machineName, request.hostname, request.platform];
  if (
    request.protocolMajor !== COMPUTER_ATTACH_SESSION_PROTOCOL_MAJOR ||
    !fields.every((field) => field.trim() && field.length <= 200) ||
    request.osVersion.length > 200 ||
    request.computerVersion.length > 100 ||
    request.machinePublicKey.length !== 32 ||
    (request.existingComputerId != null && !RFC_UUID_PATTERN.test(request.existingComputerId)) ||
    (request.workspaceSlug != null &&
      (!request.workspaceSlug.trim() || request.workspaceSlug.length > 200)) ||
    ![ComputerAttachSessionIntent.ATTACH, ComputerAttachSessionIntent.RECOVER].includes(
      request.intent,
    )
  )
    throw new AttachSessionError(ComputerAttachErrorCode.INVALID_REQUEST);
}

export async function createComputerAttachSession(
  db: PrismaClient,
  request: ComputerAttachSessionCreateRequest,
  options: AttachStartOptions,
) {
  validateCreate(request);
  const now = options.now ?? new Date();
  const recovering = request.intent === ComputerAttachSessionIntent.RECOVER;
  const machinePublicKey = Uint8Array.from(request.machinePublicKey);
  const workspace = request.workspaceSlug
    ? await db.workspace.findUnique({
        where: { slug: request.workspaceSlug },
        select: { id: true },
      })
    : undefined;
  if (request.workspaceSlug && !workspace)
    throw new AttachSessionError(ComputerAttachErrorCode.SERVER_NOT_FOUND);

  let recoveryOwnerId: string | undefined;
  let machineId = request.machineId;
  if (recovering) {
    if (!workspace || !request.existingComputerId)
      throw new AttachSessionError(ComputerAttachErrorCode.INVALID_REQUEST);
    const binding = await db.workspaceComputer.findFirst({
      where: {
        workspaceId: workspace.id,
        computerId: request.existingComputerId,
        attachMachinePublicKey: { equals: machinePublicKey },
        computer: { kind: "local", deletedAt: null },
      },
      select: { computer: { select: { ownerId: true, machineId: true } } },
    });
    if (!binding) throw new AttachSessionError(ComputerAttachErrorCode.RECOVERY_UNAVAILABLE);
    recoveryOwnerId = binding.computer.ownerId;
    machineId = binding.computer.machineId;
  } else if (
    request.existingComputerId &&
    request.existingComputerId !== options.linkedComputer?.computerId
  ) {
    throw new AttachSessionError(ComputerAttachErrorCode.INVALID_CREDENTIAL);
  }

  const pollSecret = mintOpaqueToken();
  const userCode = recovering ? undefined : mintComputerAttachUserCode();
  const session = await db.computerAttachSession.create({
    data: {
      protocolMajor: COMPUTER_ATTACH_SESSION_PROTOCOL_MAJOR,
      status: recovering ? "completing" : "awaiting_approval",
      attachIntent: recovering ? "recover" : "attach",
      deviceCodeHash: sha256Hex(pollSecret),
      userCode: userCode ? sha256Hex(userCode) : "",
      machineName: request.machineName.trim(),
      hostname: request.hostname.trim(),
      os: request.platform,
      machineId,
      machinePublicKey,
      computerVersion: request.computerVersion,
      osVersion: request.osVersion,
      existingComputerId: request.existingComputerId,
      targetWorkspaceId: workspace?.id,
      approvedWorkspaceId: recovering ? workspace?.id : undefined,
      approvedUserId: recoveryOwnerId,
      approvedAt: recovering ? now : undefined,
      expiresAt: new Date(now.getTime() + ATTACH_COMPLETION_MS),
      createdAt: now,
    },
    select: { id: true },
  });
  return {
    sessionId: session.id,
    pollSecret,
    userCode,
    verificationUri: userCode ? `${options.origin}/computers/attach/${session.id}` : undefined,
    expiresInSeconds: ATTACH_COMPLETION_MS / 1000,
    pollIntervalSeconds: ATTACH_POLL_MS / 1000,
  };
}

export async function decideComputerAttachSession(
  db: PrismaClient,
  input: {
    sessionId: string;
    userId: string;
    workspaceId: string;
    userCode?: string;
    action: "approve" | "deny";
  },
  now = new Date(),
): Promise<boolean> {
  if (!RFC_UUID_PATTERN.test(input.sessionId) || !RFC_UUID_PATTERN.test(input.workspaceId))
    return false;
  return db.$transaction(async (tx) => {
    const session = await lockAttachSession(tx, input.sessionId);
    if (
      !session ||
      session.status !== "awaiting_approval" ||
      session.expiresAt <= now ||
      (session.targetWorkspaceId && session.targetWorkspaceId !== input.workspaceId) ||
      (input.action === "approve" &&
        !matchesAttachSecret(session.userCode, input.userCode?.trim().toUpperCase() ?? ""))
    )
      return false;
    if (!isAttachAdministrator(await lockAttachMembership(tx, input.workspaceId, input.userId)))
      return false;
    await tx.computerAttachSession.update({
      where: { id: input.sessionId },
      data: {
        targetWorkspaceId: input.workspaceId,
        ...(input.action === "approve"
          ? {
              status: "approved",
              approvedAt: now,
              approvedUserId: input.userId,
              approvedWorkspaceId: input.workspaceId,
            }
          : { status: "denied", terminalAt: now, failureReason: "denied" }),
      },
    });
    return true;
  });
}

type AttachPollResult = {
  state: ComputerAttachSessionState;
  workspaceId?: string;
  workspaceSlug?: string;
  challenge?: { nonce: string; attachTicket?: string; expiresInSeconds: number };
};

export async function pollComputerAttachSession(
  db: PrismaClient,
  id: string,
  pollSecret: string,
  now = new Date(),
): Promise<AttachPollResult> {
  if (!RFC_UUID_PATTERN.test(id))
    throw new AttachSessionError(ComputerAttachErrorCode.ATTACH_SESSION_EXPIRED);
  const result = await db.$transaction(async (tx) => {
    const session = await lockAttachSession(tx, id);
    if (!session || !matchesAttachSecret(session.deviceCodeHash, pollSecret))
      return new AttachSessionError(ComputerAttachErrorCode.ATTACH_SESSION_EXPIRED);
    const expired = await expireAttachSession(tx, session, now);
    if (expired) return expired;
    if (session.lastPolledAt && now.getTime() - session.lastPolledAt.getTime() < ATTACH_POLL_MS)
      return new AttachSessionError(ComputerAttachErrorCode.SLOW_DOWN, ATTACH_POLL_MS / 1000);
    if (session.status === "awaiting_approval") {
      await tx.computerAttachSession.update({ where: { id }, data: { lastPolledAt: now } });
      return { state: ComputerAttachSessionState.AWAITING_APPROVAL };
    }

    const workspace = session.approvedWorkspaceId
      ? await tx.workspace.findUnique({
          where: { id: session.approvedWorkspaceId },
          select: { id: true, slug: true },
        })
      : null;
    if (!workspace) return new AttachSessionError(ComputerAttachErrorCode.ATTACH_SESSION_EXPIRED);
    const binding = { workspaceId: workspace.id, workspaceSlug: workspace.slug };

    if (session.status === "bound" || session.status === "ready")
      return {
        ...binding,
        state:
          session.status === "ready"
            ? ComputerAttachSessionState.READY
            : ComputerAttachSessionState.BOUND,
      };
    const nonce = mintOpaqueToken();
    const attachTicket = session.status === "approved" ? mintOpaqueToken() : undefined;
    const expiresAt = new Date(
      Math.min(now.getTime() + ATTACH_TICKET_MS, completionDeadline(session)),
    );
    await tx.computerAttachSession.update({
      where: { id },
      data: {
        lastPolledAt: now,
        nonceHash: sha256Hex(nonce),
        nonceExpiresAt: expiresAt,
        attachTokenHash: attachTicket ? sha256Hex(attachTicket) : null,
        attachTokenExpiresAt: attachTicket ? expiresAt : null,
      },
    });
    return {
      ...binding,
      state: attachTicket
        ? ComputerAttachSessionState.APPROVED
        : ComputerAttachSessionState.COMPLETING,
      challenge: {
        nonce,
        attachTicket,
        expiresInSeconds: Math.ceil((expiresAt.getTime() - now.getTime()) / 1000),
      },
    };
  });
  if (result instanceof AttachSessionError) throw result;
  return result;
}
