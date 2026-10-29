import { getDatabaseClient } from "#src/server/db/client.server";
import { seedPlatformOperators } from "./platform-operators.server";

/**
 * Grants the first platform operators from `COFORGE_PLATFORM_OPERATORS` at server start. It only
 * looks when the operator table is empty, so a removed operator is never added back, and it never
 * blocks the Web: a deployment typo, an unreadable address or a database hiccup is logged and the
 * server serves on. Without an operator the review queue answers 403 to everyone, exactly as it
 * did before this existed — an optional feature must not take the whole product down.
 */
export function startPlatformOperatorSeedingFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  const db = getDatabaseClient();
  if (!db) return;
  void seedPlatformOperators(db, env.COFORGE_PLATFORM_OPERATORS, (message, detail) =>
    console.error(JSON.stringify({ event: "platform_operator_seed_problem", message, detail })),
  )
    .then((outcome) => {
      if (!outcome.seeded) return;
      console.info(JSON.stringify({ event: "platform_operator_seed", ...outcome }));
    })
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: "platform_operator_seed_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
}
