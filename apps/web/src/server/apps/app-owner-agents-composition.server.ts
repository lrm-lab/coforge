import type { Prisma } from "#src/generated/prisma/client";
import { AppOwnerAgents } from "#src/server/apps/app-owner-agents.server";
import { PrismaAppOwnerAgentStore } from "#src/server/db/repositories/app-owner-agents.repositories.server";

/** An Agent's management of the apps it registered, over PostgreSQL. */
export function createAppOwnerAgents(db: Prisma.TransactionClient) {
  return new AppOwnerAgents(new PrismaAppOwnerAgentStore(db));
}
