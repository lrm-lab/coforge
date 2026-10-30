/**
 * How long an idle pooled connection stays open. `pg`'s default closes it after 10 s, so any
 * request after a 10 s lull first opens a new connection (TCP, startup, SCRAM) for each query it
 * runs concurrently: about 20 ms on a local PostgreSQL. Agents check and send in bursts minutes
 * apart, so most of their requests landed after such a lull.
 */
export const DATABASE_POOL_IDLE_TIMEOUT_MS = 5 * 60_000;

/**
 * Every pooled connection runs with PostgreSQL's JIT off. The planner compiles a query with LLVM
 * once its estimated cost passes `jit_above_cost`, and an estimate that a correlated bound leaves
 * wide crosses it on short OLTP reads: the channel list's per-channel unread count, on a Workspace
 * of 60 channels with 10,000 messages each, spent 280 ms compiling to run for 3 ms. This app
 * runs no query long enough for compiled code to pay that back.
 *
 * And PostgreSQL probes each connection after 30 s idle, every 10 s, three times: a NAT or proxy
 * between the server and the database drops a connection it has seen nothing on for a while,
 * silently (task #348). Probes keep an idle connection seen, and a dead one is found within a
 * minute — its session ended, the locks it held released — instead of the operating system's
 * two hours.
 */
export const DATABASE_SESSION_OPTIONS =
  "-c jit=off -c tcp_keepalives_idle=30 -c tcp_keepalives_interval=10 -c tcp_keepalives_count=3";

/** Every pool on the database: the web's, pg-boss's and the Agent runtime lock's. The client
 * probes an idle connection too (`keepAlive`); the operating system sets how often after that. */
export function databasePoolConfig(url: string) {
  return {
    connectionString: url,
    idleTimeoutMillis: DATABASE_POOL_IDLE_TIMEOUT_MS,
    options: DATABASE_SESSION_OPTIONS,
    keepAlive: true,
    keepAliveInitialDelayMillis: 30_000,
  };
}
