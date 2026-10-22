import type { PrismaClient } from "#src/generated/prisma/client";
import type { ServerConnectionPorts } from "#src/server/workspaces/server-connection.server";

export class PrismaServerConnection implements ServerConnectionPorts {
  constructor(private readonly db: PrismaClient) {}

  async hostLastSeen(): Promise<Date | undefined> {
    const row = await this.db.hostNode.findFirst({
      where: { nodeKey: { not: null }, lastSeenAt: { not: null } },
      orderBy: { lastSeenAt: "desc" },
      select: { lastSeenAt: true },
    });
    return row?.lastSeenAt ?? undefined;
  }
}
