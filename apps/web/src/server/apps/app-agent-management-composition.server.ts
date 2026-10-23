import type { Prisma } from "#src/generated/prisma/client";
import { createAppPublishing } from "#src/server/app-marketplace/app-publishing-composition.server";
import { createAppShareLinks } from "#src/server/app-marketplace/app-share-links-composition.server";
import { AppAgentManagement } from "./app-agent-management.server";
import { createAppOwnerAgents } from "./app-owner-agents-composition.server";
import { createAppRegistry } from "./app-registry-composition.server";

/** An Agent's management of its apps, over PostgreSQL. */
export function createAppAgentManagement(db: Prisma.TransactionClient) {
  return new AppAgentManagement(
    createAppOwnerAgents(db),
    createAppRegistry(db),
    createAppShareLinks(db),
    createAppPublishing(db),
  );
}
