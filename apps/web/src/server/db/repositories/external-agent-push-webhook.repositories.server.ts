import type { PrismaClient } from "#src/generated/prisma/client";
import type { DatabaseScope } from "#src/server/db/transaction.server";
import type {
  PushAttemptUpdate,
  PushDisabledReason,
  PushWebhookRow,
  PushWebhookStore,
} from "#src/server/agents/external-push-webhook-store";

const rowOf = (row: {
  agentId: string;
  workspaceId: string;
  url: string;
  secretSealed: string;
  enabled: boolean;
  disabledReason: string | null;
  revision: number;
  lastDeliveryAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  rejectionStreak: number;
  retryAt: Date | null;
  retryNoticeId: string | null;
}): PushWebhookRow => ({ ...row, disabledReason: row.disabledReason as PushDisabledReason | null });

export class PrismaExternalPushWebhookStore implements PushWebhookStore {
  constructor(private readonly db: PrismaClient) {}

  async find(agentId: string) {
    const row = await this.db.externalAgentPushWebhook.findUnique({ where: { agentId } });
    return row ? rowOf(row) : undefined;
  }

  async save(input: { agentId: string; workspaceId: string; url: string; secretSealed: string }) {
    const fresh = {
      enabled: true,
      disabledReason: null,
      lastError: null,
      consecutiveFailures: 0,
      rejectionStreak: 0,
      retryAt: null,
      retryNoticeId: null,
    };
    await this.db.externalAgentPushWebhook.upsert({
      where: { agentId: input.agentId },
      create: { ...input, ...fresh },
      update: {
        url: input.url,
        secretSealed: input.secretSealed,
        revision: { increment: 1 },
        ...fresh,
      },
    });
  }

  async remove(agentId: string) {
    const { count } = await this.db.externalAgentPushWebhook.deleteMany({ where: { agentId } });
    return count > 0;
  }

  async deliveryTarget(agentId: string) {
    const row = await this.db.externalAgentPushWebhook.findUnique({
      where: { agentId },
      include: {
        agent: { select: { workspaceId: true, deletedAt: true, stoppedAt: true, hosting: true } },
      },
    });
    if (!row) return undefined;
    const { agent, ...webhook } = row;
    return { row: rowOf(webhook), agent };
  }

  async record(agentId: string, revision: number, update: PushAttemptUpdate) {
    const { disabledReason, ...rest } = update;
    const { count } = await this.db.externalAgentPushWebhook.updateMany({
      where: { agentId, revision },
      data: { ...rest, ...(disabledReason ? { enabled: false, disabledReason } : {}) },
    });
    return count > 0;
  }
}

export async function anyExternalPushWebhook(db: DatabaseScope): Promise<boolean> {
  return (await db.externalAgentPushWebhook.findFirst({ select: { agentId: true } })) !== null;
}
