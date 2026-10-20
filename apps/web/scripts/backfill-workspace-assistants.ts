import { requireDatabaseClient } from "../src/server/db/client.server";
import { backfillWorkspaceAssistants } from "../src/server/agents/workspace-assistants.server";

import { workspaceAssistantOnboarding } from "../src/server/agents/workspace-assistant-onboarding.server";

const db = requireDatabaseClient();
try {
  console.info(
    JSON.stringify(
      await backfillWorkspaceAssistants(db, (workspaceId, userId) =>
        workspaceAssistantOnboarding(db).ensure(workspaceId, userId),
      ),
    ),
  );
} finally {
  await db.$disconnect();
}
