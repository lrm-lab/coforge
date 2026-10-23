import { requireDatabaseClient } from "../src/server/db/client.server";
import { grantPlatformOperator } from "../src/server/app-marketplace/platform-operators.server";

const email = process.argv[2];
if (!email) {
  console.error("usage: bun run scripts/grant-platform-operator.ts <sign-in email>");
  process.exit(2);
}
const db = requireDatabaseClient();
try {
  const outcome = await grantPlatformOperator(db, email);
  console.info(JSON.stringify({ event: "platform_operator_grant", outcome }));
  if (outcome === "no-user" || outcome === "ambiguous") process.exitCode = 1;
} finally {
  await db.$disconnect();
}
