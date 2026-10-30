import type { PrismaClient } from "#src/generated/prisma/client";

import type { ExperimentsRepository } from "./experiments.server";

export class PrismaExperimentsRepository implements ExperimentsRepository {
  constructor(private readonly db: PrismaClient) {}

  async read(workspaceId: string) {
    const row = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { experiments: true },
    });
    const stored = row?.experiments;
    return stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, boolean>)
      : {};
  }

  /** One statement, so two admins setting different keys never overwrite each other. */
  async write(workspaceId: string, key: string, enabled: boolean) {
    await this.db.$executeRaw`
      UPDATE workspaces
      SET experiments = COALESCE(experiments, '{}'::jsonb)
            || jsonb_build_object(${key}::text, ${enabled}::boolean)
      WHERE id = ${workspaceId}::uuid`;
  }
}
