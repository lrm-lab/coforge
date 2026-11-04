import type { PrismaClient } from "#src/generated/prisma/client";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import { humanLabel } from "#src/lib/human-label";
import { ownerAgentLanguage, ownerAgentName } from "#src/server/agents/owner-agent-name.server";
import type { Locale } from "#src/paraglide/runtime";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";

export const WEEKLY_REPORT_ASSISTANT_DISPLAY_NAME = "周报助手";

/** The name members see: 「李健的周报助手」 / "Ada's Weekly Report Assistant", the owner's name
 * cut to fit an Agent's display name. A blank person name keeps the generic label. */
export function weeklyReportAssistantDisplayName(
  personName: string,
  language: Locale = "zh-CN",
): string {
  const person = personName.trim();
  if (person.length === 0) return WEEKLY_REPORT_ASSISTANT_DISPLAY_NAME;
  return ownerAgentName(person, language === "zh-CN" ? "的周报助手" : "'s Weekly Report Assistant");
}

async function assistantLabelForUser(
  tx: {
    user: {
      findUnique: (args: {
        where: { id: string };
        select: {
          username: true;
          displayName: true;
          preferences: { select: { language: true } };
        };
      }) => Promise<{
        username: string;
        displayName: string | null;
        preferences?: { language: string | null } | null;
      } | null>;
    };
  },
  userId: string,
): Promise<string> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: {
      username: true,
      displayName: true,
      preferences: { select: { language: true } },
    },
  });
  if (!user) return WEEKLY_REPORT_ASSISTANT_DISPLAY_NAME;
  return weeklyReportAssistantDisplayName(
    humanLabel(user),
    ownerAgentLanguage(user.preferences?.language),
  );
}

export function weeklyReportAssistantAgentName(userId: string): string {
  return `weekly-report-assistant-${userId}`;
}

const UNCONFIGURED_RUNTIME = {
  runtime: RUNTIME_PROVIDER.COFORGE,
  provider: { kind: "default" as const },
  model: "",
  modelProvider: "",
  reasoning: "",
};

/** Pi with an empty model: the runtime's own default model. */
const PI_DEFAULT_RUNTIME = {
  runtime: RUNTIME_PROVIDER.PI,
  provider: { kind: "default" as const },
  model: "",
  modelProvider: "",
  reasoning: "",
};

type ComputerLookup = Pick<PrismaClient, "computer">;

/** The owner's live default cloud computer, or undefined when the id is not that. */
async function ownDefaultCloudComputerId(
  db: ComputerLookup,
  input: { userId: string; computerId: string },
): Promise<string | undefined> {
  const computer = await db.computer.findFirst({
    where: {
      id: input.computerId,
      ownerId: input.userId,
      deletedAt: null,
      kind: "cloud",
      cloudSlot: "default",
    },
    select: { id: true },
  });
  return computer?.id;
}

/** A live Computer this User owns. Extra cloud computers and local computers count. */
export async function userOwnsLiveComputer(
  db: ComputerLookup,
  input: { userId: string; computerId: string },
): Promise<boolean> {
  const computer = await db.computer.findFirst({
    where: { id: input.computerId, ownerId: input.userId, deletedAt: null },
    select: { id: true },
  });
  return computer !== null;
}

export type WeeklyReportAssistantRecord = {
  id: string;
  workspaceId: string;
  userId: string;
  agentId: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Returns the User's stable weekly-report Agent, creating its unconfigured
 * Agent identity atomically on first use.
 *
 * Reclaims an orphan Agent left by a previous partial create (Agent row exists,
 * WeeklyReportAssistant link missing) so Members loader does not die on
 * `agents_workspaceId_name_key`.
 *
 * New and reclaimed assistants are always private: they work on one
 * User's Records and must not appear Workspace-wide.
 */
export async function ensureWeeklyReportAssistant(
  db: PrismaClient,
  input: { workspaceId: string; userId: string; computerId?: string },
): Promise<WeeklyReportAssistantRecord> {
  const agentName = weeklyReportAssistantAgentName(input.userId);
  try {
    return await db.$transaction(async (tx) => {
      const existing = await tx.weeklyReportAssistant.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: input.workspaceId,
            userId: input.userId,
          },
        },
      });
      if (existing) {
        const agent = await tx.agent.findUnique({
          where: {
            workspaceId_name: { workspaceId: input.workspaceId, name: agentName },
          },
          select: { id: true, displayName: true, computerId: true },
        });
        // The display name is not recomputed here: the owner's name and language changes rename
        // it directly (task #495, `renameOwnerAgents`), so ensuring the assistant never
        // overwrites a name the owner chose by hand, nor renames passively on use.
        const patch: { computerId?: string; runtimeConfig?: object } = {};
        if (agent && !agent.computerId && input.computerId) {
          const computerId = await ownDefaultCloudComputerId(tx, {
            userId: input.userId,
            computerId: input.computerId,
          });
          if (computerId) {
            patch.computerId = computerId;
            patch.runtimeConfig = PI_DEFAULT_RUNTIME;
          }
        }
        if (agent && Object.keys(patch).length > 0) {
          await tx.agent.update({
            where: { id_workspaceId: { id: agent.id, workspaceId: input.workspaceId } },
            data: patch,
          });
        }
        return existing;
      }

      const orphan = await tx.agent.findUnique({
        where: {
          workspaceId_name: { workspaceId: input.workspaceId, name: agentName },
        },
        select: { id: true, ownerId: true, deletedAt: true, visibility: true, computerId: true },
      });

      let agentId: string;
      if (orphan) {
        if (orphan.ownerId !== input.userId) throw new AppError("ACCESS_DENIED");
        const patch: {
          deletedAt?: null;
          displayName?: string;
          visibility?: typeof AGENT_VISIBILITY.PRIVATE;
          computerId?: string;
          runtimeConfig?: object;
        } = {};
        if (orphan.deletedAt) {
          patch.deletedAt = null;
          patch.displayName = await assistantLabelForUser(tx, input.userId);
        }
        if (orphan.visibility !== AGENT_VISIBILITY.PRIVATE) {
          patch.visibility = AGENT_VISIBILITY.PRIVATE;
        }
        if (!orphan.computerId && input.computerId) {
          const computerId = await ownDefaultCloudComputerId(tx, {
            userId: input.userId,
            computerId: input.computerId,
          });
          if (computerId) {
            patch.computerId = computerId;
            patch.runtimeConfig = PI_DEFAULT_RUNTIME;
          }
        }
        if (Object.keys(patch).length > 0) {
          await tx.agent.update({
            where: { id_workspaceId: { id: orphan.id, workspaceId: input.workspaceId } },
            data: patch,
          });
        }
        agentId = orphan.id;
      } else {
        const computerId = input.computerId
          ? await ownDefaultCloudComputerId(tx, {
              userId: input.userId,
              computerId: input.computerId,
            })
          : undefined;
        const agent = await tx.agent.create({
          data: {
            workspaceId: input.workspaceId,
            ownerId: input.userId,
            name: agentName,
            displayName: await assistantLabelForUser(tx, input.userId),
            description: "",
            visibility: AGENT_VISIBILITY.PRIVATE,
            ...(computerId ? { computerId } : {}),
            runtimeConfig: computerId ? PI_DEFAULT_RUNTIME : UNCONFIGURED_RUNTIME,
          },
        });
        agentId = agent.id;
      }

      return tx.weeklyReportAssistant.create({
        data: {
          workspaceId: input.workspaceId,
          userId: input.userId,
          agentId,
        },
      });
    });
  } catch (error) {
    // A concurrent first request may lose the unique insert race; reuse its row.
    const existing = await db.weeklyReportAssistant.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: input.workspaceId,
          userId: input.userId,
        },
      },
    });
    if (existing) return existing;
    throw error;
  }
}

export async function weeklyReportAssistantOwner(
  db: PrismaClient,
  input: { workspaceId: string; agentId: string },
): Promise<{ userId: string } | undefined> {
  const row = await db.weeklyReportAssistant.findFirst({
    where: { workspaceId: input.workspaceId, agentId: input.agentId },
    select: { userId: true },
  });
  return row ?? undefined;
}
