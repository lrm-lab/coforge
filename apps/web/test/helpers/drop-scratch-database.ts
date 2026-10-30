import type { Pool } from "pg";

/**
 * Drops a scratch database once its backends have exited. `DROP DATABASE ... WITH (FORCE)` kills
 * a connection that is still shutting down, and the pool's client then reports the server's
 * "terminating connection due to administrator command" as an uncaught error.
 */
export async function dropScratchDatabase(admin: Pool, database: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await admin.query(
      `SELECT count(*)::int AS open FROM pg_stat_activity WHERE datname = $1`,
      [database],
    );
    if (rows[0].open === 0) break;
    await Bun.sleep(25);
  }
  await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
}
