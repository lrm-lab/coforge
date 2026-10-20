import type { PrismaClient } from "#src/generated/prisma/client";
import { AppAgentAccess } from "#src/server/app-agent-access/app-agent-access.server";
import { PrismaAppAgentAccessStore } from "#src/server/db/repositories/app-agent-access.repositories.server";

/** Agents' app access over PostgreSQL. */
export function createAppAgentAccess(db: PrismaClient) {
  return new AppAgentAccess(new PrismaAppAgentAccessStore(db));
}
