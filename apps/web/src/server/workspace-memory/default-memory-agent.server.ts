import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { AGENT_NAME_MAX_LENGTH } from "#src/features/agents/agent.schemas";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { isOpenVikingPrototypeEnabled } from "./prototype-gate";
import {
  sanitizeWorkspaceMemoryFailure,
  type WorkspaceMemoryFailureCode,
  WORKSPACE_MEMORY_FAILURE_CODES,
} from "./errors";
import {
  createDefaultWorkspaceMemoryProfile,
  parseDesiredWorkspaceMemoryProfile,
  parseObservedWorkspaceMemoryState,
  type PrototypeGate,
  type ReconcileKind,
  type WorkspaceMemoryProfile,
} from "./profile";
import {
  WORKSPACE_MEMORY_AGENT_DISPLAY_NAME,
  WORKSPACE_MEMORY_AGENT_HANDLE,
  computerIdToBind,
  profileForNewMemoryAgent,
} from "./default-memory-agent";

type MemoryDb = PrismaClient | Prisma.TransactionClient;

/**
 * Adds the Workspace Memory Agent to one newly created public channel.
 * Creates the agent when the workspace has none and `memory` is free.
 * A taken handle leaves the channel without that member and does not touch the profile.
 * A unique-constraint race joins the agent the other transaction provisioned.
 */
export async function attachDefaultMemoryAgent(
  db: PrismaClient,
  input: {
    workspaceId: string;
    conversationId: string;
    actorUserId: string;
    now: Date;
    gate: PrototypeGate;
  },
): Promise<void> {
  try {
    await db.$transaction((tx) => attachOnce(tx, input));
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    try {
      await db.$transaction(async (tx) => {
        const existing = await liveMemoryAgentId(tx, input.workspaceId);
        if (existing) await addUnmutedMember(tx, input, existing);
      });
    } catch (retryError) {
      if (!isUniqueViolation(retryError)) throw retryError;
    }
  }
}

async function attachOnce(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    conversationId: string;
    actorUserId: string;
    now: Date;
    gate: PrototypeGate;
  },
): Promise<void> {
  const existing = await liveMemoryAgentId(tx, input.workspaceId);
  if (existing) {
    await addUnmutedMember(tx, input, existing);
    return;
  }
  await tx.workspaceMemoryAgent.deleteMany({ where: { workspaceId: input.workspaceId } });
  if (await memoryHandleTaken(tx, input.workspaceId)) return;

  await releaseDeletedHandle(tx, input.workspaceId);
  const computerId = await earliestOwnerComputerId(tx, input.workspaceId, input.actorUserId);
  const agent = await tx.agent.create({
    data: {
      workspaceId: input.workspaceId,
      ownerId: input.actorUserId,
      name: WORKSPACE_MEMORY_AGENT_HANDLE,
      displayName: WORKSPACE_MEMORY_AGENT_DISPLAY_NAME,
      description: "",
      visibility: AGENT_VISIBILITY.PUBLIC,
      ...(computerId ? { computerId } : {}),
      runtimeConfig: {
        runtime: RUNTIME_PROVIDER.COFORGE,
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
    },
    select: { id: true },
  });
  await tx.workspaceMemoryAgent.create({
    data: { workspaceId: input.workspaceId, agentId: agent.id },
  });
  await addUnmutedMember(tx, input, agent.id);
  await writeProvisionedProfile(tx, input.workspaceId, input.now, input.gate);
}

export async function attachDefaultMemoryAgentToGeneral(
  db: PrismaClient,
  workspaceId: string,
  actorUserId: string,
): Promise<void> {
  const general = await db.conversation.findUnique({
    where: { workspaceId_channelName: { workspaceId, channelName: "general" } },
    select: { id: true },
  });
  if (!general) return;
  await attachDefaultMemoryAgent(db, {
    workspaceId,
    conversationId: general.id,
    actorUserId,
    now: new Date(),
    gate: { prototypeEnabled: isOpenVikingPrototypeEnabled(Bun.env) },
  });
}

/**
 * Binds an unbound Memory Agent to its owner's earliest Computer in the Workspace.
 * An agent that already has a Computer is left alone. No Computer leaves it unbound.
 */
export async function bindUnboundMemoryAgentComputer(
  db: MemoryDb,
  workspaceId: string,
): Promise<void> {
  const link = await db.workspaceMemoryAgent.findUnique({
    where: { workspaceId },
    select: {
      agent: { select: { id: true, ownerId: true, computerId: true, deletedAt: true } },
    },
  });
  if (!link || link.agent.deletedAt) return;
  const computerId = computerIdToBind(
    link.agent.computerId,
    await ownerComputerLinks(db, workspaceId, link.agent.ownerId),
  );
  if (!computerId) return;
  await db.agent.updateMany({
    where: { id: link.agent.id, computerId: null, deletedAt: null },
    data: { computerId },
  });
}

async function earliestOwnerComputerId(
  db: MemoryDb,
  workspaceId: string,
  ownerId: string,
): Promise<string | null> {
  return computerIdToBind(null, await ownerComputerLinks(db, workspaceId, ownerId));
}

async function ownerComputerLinks(db: MemoryDb, workspaceId: string, ownerId: string) {
  const links = await db.workspaceComputer.findMany({
    where: { workspaceId, computer: { ownerId } },
    select: { id: true, computerId: true, createdAt: true },
  });
  return links.map((link) => ({
    linkId: link.id,
    computerId: link.computerId,
    linkedAt: link.createdAt,
  }));
}

export async function liveMemoryAgentId(db: MemoryDb, workspaceId: string): Promise<string | null> {
  const link = await db.workspaceMemoryAgent.findUnique({
    where: { workspaceId },
    select: { agentId: true, agent: { select: { deletedAt: true } } },
  });
  if (!link || link.agent.deletedAt) return null;
  return link.agentId;
}

async function memoryHandleTaken(tx: Prisma.TransactionClient, workspaceId: string) {
  const [agent, member] = await Promise.all([
    tx.agent.findFirst({
      where: { workspaceId, name: WORKSPACE_MEMORY_AGENT_HANDLE, deletedAt: null },
      select: { id: true },
    }),
    tx.workspaceMembership.findFirst({
      where: { workspaceId, user: { username: WORKSPACE_MEMORY_AGENT_HANDLE } },
      select: { userId: true },
    }),
  ]);
  return agent !== null || member !== null;
}

async function releaseDeletedHandle(tx: Prisma.TransactionClient, workspaceId: string) {
  const deleted = await tx.agent.findFirst({
    where: {
      workspaceId,
      name: WORKSPACE_MEMORY_AGENT_HANDLE,
      deletedAt: { not: null },
    },
    select: { id: true },
  });
  if (!deleted) return;
  await tx.agent.update({
    where: { id: deleted.id },
    data: { name: releasedDeletedAgentName(WORKSPACE_MEMORY_AGENT_HANDLE, deleted.id) },
  });
}

function releasedDeletedAgentName(name: string, agentId: string): string {
  const suffix = `-deleted-${agentId.replaceAll("-", "").slice(0, 12)}`;
  return `${name.slice(0, AGENT_NAME_MAX_LENGTH - suffix.length).replace(/-+$/, "")}${suffix}`;
}

async function addUnmutedMember(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; conversationId: string },
  agentId: string,
) {
  await tx.conversationMember.upsert({
    where: { conversationId_agentId: { conversationId: input.conversationId, agentId } },
    create: {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      agentId,
      channelMuted: false,
    },
    update: { leftAt: null, channelMuted: false },
  });
}

async function writeProvisionedProfile(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  now: Date,
  gate: PrototypeGate,
) {
  const current = await readProfile(tx, workspaceId);
  const next = profileForNewMemoryAgent(current, now, gate);
  if (next === current) return;
  const data = profileColumns(next);
  const row = await tx.workspaceMemoryProfile.findUnique({ where: { workspaceId } });
  if (!row) {
    await tx.workspaceMemoryProfile.create({ data });
    return;
  }
  const { workspaceId: _workspaceId, ...patch } = data;
  await tx.workspaceMemoryProfile.update({ where: { workspaceId }, data: patch });
}

async function readProfile(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<WorkspaceMemoryProfile> {
  const row = await tx.workspaceMemoryProfile.findUnique({ where: { workspaceId } });
  if (!row) return createDefaultWorkspaceMemoryProfile(workspaceId);
  const desired = parseDesiredWorkspaceMemoryProfile(row.desired);
  const observed = parseObservedWorkspaceMemoryState(row.observed);
  if (!desired || !observed) return createDefaultWorkspaceMemoryProfile(workspaceId);
  return {
    workspaceId,
    desired,
    observed,
    generation: row.generation,
    activationCursor: cursorOf(row),
    reconcileKind: reconcileOf(row.reconcileKind),
    sanitizedFailure: failureOf(row.sanitizedFailureCode, row.sanitizedFailureMessage),
  };
}

function cursorOf(row: {
  activationCursorKind: string | null;
  activationOccurredAt: Date | null;
  activationMessageId: string | null;
}): WorkspaceMemoryProfile["activationCursor"] {
  if (row.activationCursorKind === "time" && row.activationOccurredAt) {
    return { kind: "time", occurredAt: row.activationOccurredAt.toISOString() };
  }
  if (
    row.activationCursorKind === "message" &&
    row.activationOccurredAt &&
    row.activationMessageId
  ) {
    return {
      kind: "message",
      occurredAt: row.activationOccurredAt.toISOString(),
      messageId: row.activationMessageId,
    };
  }
  return null;
}

function reconcileOf(value: string | null): ReconcileKind | null {
  return value === "provision" || value === "switch" ? value : null;
}

function failureOf(code: string | null, message: string | null) {
  if (!code || !message) return null;
  if (!(WORKSPACE_MEMORY_FAILURE_CODES as readonly string[]).includes(code)) return null;
  return sanitizeWorkspaceMemoryFailure(code as WorkspaceMemoryFailureCode);
}

function profileColumns(profile: WorkspaceMemoryProfile) {
  return {
    workspaceId: profile.workspaceId,
    desired: profile.desired,
    observed: profile.observed,
    generation: profile.generation,
    activationCursorKind: profile.activationCursor?.kind ?? null,
    activationOccurredAt: profile.activationCursor
      ? new Date(profile.activationCursor.occurredAt)
      : null,
    activationMessageId:
      profile.activationCursor?.kind === "message" ? profile.activationCursor.messageId : null,
    reconcileKind: profile.reconcileKind,
    sanitizedFailureCode: profile.sanitizedFailure?.code ?? null,
    sanitizedFailureMessage: profile.sanitizedFailure?.message ?? null,
  };
}
