import { DEV_BROWSER_USER } from "../src/server/auth/dev-skip-auth.server";
import { getDatabaseClient } from "../src/server/db/client.server";
import { workspaceIdForUser } from "../src/server/workspaces/enrollment.server";
import { seedDevBrowserUser } from "./seed-dev-baseline";

const db = getDatabaseClient();
if (!db) throw new Error("DATABASE_URL is required to seed development data");

await seedDevBrowserUser(db);
await workspaceIdForUser(db, { ...DEV_BROWSER_USER, displayName: DEV_BROWSER_USER.name }, "en");
await db.$disconnect();
