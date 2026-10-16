import type { PrismaClient } from "#src/generated/prisma/client";
import { humanLabel } from "#src/lib/human-label";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import {
  ServerConnectionError,
  type ServerConnectionPorts,
  type ServerConnectionRow,
} from "#src/server/workspaces/server-connection.server";

export class PrismaServerConnection implements ServerConnectionPorts {
  constructor(private readonly db: PrismaClient) {}

  async insert(row: ServerConnectionRow): Promise<void> {
    try {
      await this.db.workspaceServerConnection.create({
        data: {
          workspaceId: row.workspaceId,
          installOrigin: row.installOrigin,
          workspaceSlug: row.workspaceSlug,
          submittedByUserId: row.submittedByUserId,
          submittedAt: row.submittedAt,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ServerConnectionError(409, "server connection already submitted");
      }
      throw error;
    }
  }

  async find(workspaceId: string): Promise<ServerConnectionRow | undefined> {
    const row = await this.db.workspaceServerConnection.findUnique({
      where: { workspaceId },
      include: { submittedBy: { select: { displayName: true, username: true } } },
    });
    if (!row) return undefined;
    return {
      workspaceId: row.workspaceId,
      installOrigin: row.installOrigin,
      workspaceSlug: row.workspaceSlug,
      submittedByUserId: row.submittedByUserId,
      submittedByName: humanLabel(row.submittedBy),
      submittedAt: row.submittedAt,
    };
  }

  async hostLastSeen(): Promise<Date | undefined> {
    const row = await this.db.hostNode.findFirst({
      where: { nodeKey: { not: null }, lastSeenAt: { not: null } },
      orderBy: { lastSeenAt: "desc" },
      select: { lastSeenAt: true },
    });
    return row?.lastSeenAt ?? undefined;
  }
}
