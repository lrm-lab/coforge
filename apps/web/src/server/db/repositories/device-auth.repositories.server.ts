import type { PrismaClient } from "#src/generated/prisma/client";
import type {
  DeviceAuthorizationRecord,
  DeviceAuthorizationStore,
} from "#src/server/auth/device-auth.server";

const recordShape = {
  id: true,
  userId: true,
  status: true,
  expiresAt: true,
  lastPolledAt: true,
} as const;

export class PrismaDeviceAuthorizationStore implements DeviceAuthorizationStore {
  constructor(private readonly db: PrismaClient) {}

  create(input: { deviceCodeHash: string; userCodeHash: string; expiresAt: Date }) {
    return this.db.deviceAuthorization.create({ data: input, select: recordShape });
  }

  findByDeviceCodeHash(hash: string): Promise<DeviceAuthorizationRecord | null> {
    return this.db.deviceAuthorization.findUnique({
      where: { deviceCodeHash: hash },
      select: recordShape,
    });
  }

  findByUserCodeHash(hash: string): Promise<DeviceAuthorizationRecord | null> {
    return this.db.deviceAuthorization.findUnique({
      where: { userCodeHash: hash },
      select: recordShape,
    });
  }

  async markPolled(id: string, at: Date): Promise<void> {
    await this.db.deviceAuthorization.update({ where: { id }, data: { lastPolledAt: at } });
  }

  async approve(id: string, userId: string, at: Date): Promise<boolean> {
    // Conditional on the row still being pending and unexpired, so two browser tabs racing on
    // the same code cannot rebind an already-approved grant to a second user, and a grant that
    // expired between the lookup and this write is not approved after the fact.
    const { count } = await this.db.deviceAuthorization.updateMany({
      where: { id, status: "pending", expiresAt: { gt: at } },
      data: { status: "approved", userId, approvedAt: at },
    });
    return count === 1;
  }

  async deny(id: string, at: Date): Promise<boolean> {
    const { count } = await this.db.deviceAuthorization.updateMany({
      where: { id, status: "pending", expiresAt: { gt: at } },
      data: { status: "denied" },
    });
    return count === 1;
  }

  /**
   * Whether `userId` approved a device sign-in at or after `since`. A grant the daemon already
   * polled is `consumed`, which still means the person approved it.
   */
  async approvedSince(userId: string, since: Date): Promise<boolean> {
    const grant = await this.db.deviceAuthorization.findFirst({
      where: { userId, status: { in: ["approved", "consumed"] }, approvedAt: { gte: since } },
      select: { id: true },
    });
    return grant !== null;
  }

  async consume(id: string): Promise<boolean> {
    const { count } = await this.db.deviceAuthorization.updateMany({
      where: { id, status: "approved" },
      data: { status: "consumed" },
    });
    return count === 1;
  }
}
