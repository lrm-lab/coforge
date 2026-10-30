import { Pool, type PoolClient } from "pg";
import { databasePoolConfig } from "#src/server/db/pool-config.server";

export interface AgentRuntimeLock {
  run<T>(agentId: string, callback: () => Promise<T>): Promise<T>;
}

export class PostgresAgentRuntimeLock implements AgentRuntimeLock {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async run<T>(agentId: string, callback: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    // A checked-out connection is not the pool's to watch: one lost under the lock (keepalive
    // finds it) would throw from its "error" event. The unlock then fails and destroys it.
    const lost = (error: Error) => logLost("agent_runtime_lock:connection_lost", error, agentId);
    client.on("error", lost);
    let locked = false;
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [agentId]);
      locked = true;
      return await callback();
    } finally {
      try {
        await releaseLock(client, agentId, locked);
      } finally {
        client.removeListener("error", lost);
      }
    }
  }
}

let defaultLock: AgentRuntimeLock | undefined;

export function getAgentRuntimeLock(): AgentRuntimeLock {
  if (defaultLock) return defaultLock;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Agent runtime lock persistence is unavailable");
  const pool = new Pool(databasePoolConfig(databaseUrl));
  // The pool drops an idle connection that breaks; unheard, the event would throw.
  pool.on("error", (error) => logLost("agent_runtime_lock:idle_connection_lost", error));
  return (defaultLock = new PostgresAgentRuntimeLock(pool));
}

function logLost(event: string, error: Error, agentId?: string) {
  console.error(
    JSON.stringify({ event, ...(agentId && { agent_id: agentId }), error_type: error.name }),
  );
}

async function releaseLock(client: PoolClient, agentId: string, locked: boolean): Promise<void> {
  let destroy = false;
  try {
    if (!locked) return;
    const result = await client.query<{ unlocked: boolean }>(
      "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked",
      [agentId],
    );
    if (!result.rows[0]?.unlocked) throw new Error("Agent runtime lock was not held");
  } catch (error) {
    destroy = true;
    throw error;
  } finally {
    client.release(destroy);
  }
}
