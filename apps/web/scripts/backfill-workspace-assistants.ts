import { requireDatabaseClient } from "../src/server/db/client.server";
import { backfillWorkspaceAssistants } from "../src/server/agents/workspace-assistants.server";

const db = requireDatabaseClient();
try {
  console.info(JSON.stringify(await backfillWorkspaceAssistants(db)));
} finally {
  await db.$disconnect();
}
