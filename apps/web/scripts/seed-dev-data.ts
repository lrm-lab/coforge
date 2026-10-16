import { DEV_BROWSER_USER } from "../src/server/auth/dev-skip-auth.server";
import { getDatabaseClient } from "../src/server/db/client.server";
import { workspaceIdForUser } from "../src/server/workspaces/enrollment.server";

const db = getDatabaseClient();
if (!db) throw new Error("DATABASE_URL is required to seed development data");

await db.user.upsert({
  where: { id: DEV_BROWSER_USER.id },
  create: {
    id: DEV_BROWSER_USER.id,
    username: DEV_BROWSER_USER.username,
    displayName: DEV_BROWSER_USER.name,
    // Past first sign-in: the dev session opens the Workspace, not the name step.
    welcomedAt: new Date(),
  },
  update: {
    username: DEV_BROWSER_USER.username,
    displayName: DEV_BROWSER_USER.name,
    welcomedAt: new Date(),
  },
});
await workspaceIdForUser(db, { ...DEV_BROWSER_USER, displayName: DEV_BROWSER_USER.name }, "en");
await db.$disconnect();
