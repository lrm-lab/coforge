/**
 * Bounds every PostgreSQL connection the Web tests open, so one abandoned query cannot take the
 * whole `bun test` process down with it. `bun test` runs every integration file in one process
 * against one scratch database, and a test that times out does not cancel its pending work: an
 * abandoned `$transaction` keeps its pool connection and row locks, `afterAll`'s `$disconnect`
 * then waits on that connection forever, and the pool leaks for the rest of the run. Enough
 * leaks exhaust PostgreSQL's `max_connections`, and later files fail with `too many clients
 * already` — the cascade behind the recurring five-second timeouts.
 *
 * Preloaded from `bunfig.toml` before any test file, so it reaches the hundreds of suites that
 * build a `PrismaClient` on a bare `{ connectionString }` without editing them:
 *
 * - Session timeouts go through `pg.defaults`, which `pg` sends as startup parameters on every
 *   connection, pooled or not: a stuck statement fails after 60 s, a lock wait after 10 s —
 *   including the app-notification emitter suites' deferred `CREATE CONSTRAINT TRIGGER`, which
 *   otherwise queues behind whatever leaked transaction holds the table — and a session left
 *   idle inside a transaction is terminated after 30 s, releasing its locks and connection. All
 *   three are wider than a test's own 5 s timeout on purpose: they exist to reap work a
 *   timed-out test abandoned, not to police a running test.
 * - `DATABASE_SESSION_OPTIONS` is the startup `options`, the same JIT-off and TCP-keepalive
 *   settings `databasePoolConfig` gives every pooled connection in the application.
 * - Pool size is capped at 4. `pg-pool` reads `max` only from the constructor options —
 *   `pg.defaults` cannot reach it — so `pg.Pool` is wrapped once here. pg-boss passes its own
 *   explicit `max` and keeps it; a file's concurrent queries still fit in 4. The wrapper returns
 *   a real `pg.Pool` rather than subclassing it: a `class extends` over pg's pool breaks queries
 *   under Bun (`invalid message format`), while a plain forwarding function does not.
 */
import pg from "pg";

import { DATABASE_SESSION_OPTIONS } from "#src/server/db/pool-config.server";

pg.defaults.statement_timeout = 60_000;
pg.defaults.lock_timeout = 10_000;
pg.defaults.idle_in_transaction_session_timeout = 30_000;
pg.defaults.options = DATABASE_SESSION_OPTIONS;

const TEST_POOL_MAX = 4;
const Pool = pg.Pool;
function GuardedPool(this: unknown, options?: pg.PoolConfig) {
  return new Pool(options?.max === undefined ? { ...options, max: TEST_POOL_MAX } : options);
}
Object.setPrototypeOf(GuardedPool, Pool);
GuardedPool.prototype = Pool.prototype;
pg.Pool = GuardedPool as unknown as typeof Pool;
