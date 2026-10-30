import { createHash } from "node:crypto";
import { Client, Pool, type PoolConfig, type QueryConfig, type QueryResult } from "pg";

/** `pg`'s errors for a connection that stopped answering or went away under a statement. */
function lostConnection(error: unknown): "timeout" | "connection_lost" | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.message === "Query read timeout") return "timeout";
  // Not the pool's "Connection terminated due to connection timeout": no connection was had.
  if (error.message === "Connection terminated unexpectedly") return "connection_lost";
  const code = (error as { code?: unknown }).code;
  return code === "ECONNRESET" || code === "EPIPE" ? "connection_lost" : undefined;
}

/** A read with no side effect: what Prisma's reads send. A locking read belongs in a transaction. */
function plainSelect(sql: string) {
  return (
    /^\s*SELECT\b/i.test(sql) && !/\bFOR\s+(NO\s+KEY\s+)?(UPDATE|SHARE|KEY\s+SHARE)\b/i.test(sql)
  );
}

/** The same statement text, the same fingerprint: Prisma sends values as parameters. */
function fingerprint(sql: string) {
  return createHash("sha256").update(sql).digest("hex").slice(0, 16);
}

/**
 * The web server's database pool (task #348). A connection a NAT dropped silently would hold a
 * statement until TCP gave up, minutes later; so a single statement — what Prisma runs outside a
 * transaction, through `pool.query` — waits at most `timeoutMs`, and `pg` then drops its
 * connection. A plain `SELECT` is run once more, on a connection opened for it: the pool's other
 * idle ones went quiet as long and may be dead too. A write is not, since it may have been
 * applied. Transactions (`pool.connect`) keep Prisma's own timeouts. Each lost statement is
 * logged with its reason and fingerprint, so reads a slow database made run twice show.
 */
export class StatementPool extends Pool {
  constructor(config: PoolConfig, timeoutMs = 10_000) {
    super(config);
    // `pg` reads a per-statement `query_timeout` that its types leave out.
    const query = super.query.bind(this) as (
      statement: QueryConfig & { query_timeout: number },
    ) => Promise<QueryResult>;
    const fresh = async (statement: QueryConfig) => {
      const client = new Client({ ...config, query_timeout: timeoutMs });
      // A connection that breaks reports it to its query too; unheard, the event would throw.
      client.on("error", () => undefined);
      try {
        await client.connect();
        return await client.query(statement);
      } finally {
        void client.end().catch(() => undefined);
      }
    };
    // `pg` types `query` as overloads; Prisma calls `query(config)`, or `query(sql)` for a script.
    this.query = ((sent: QueryConfig | string) => {
      const statement = typeof sent === "string" ? { text: sent } : sent;
      return query({ ...statement, query_timeout: timeoutMs }).catch((error: unknown) => {
        const reason = lostConnection(error);
        if (!reason) throw error;
        const retried = plainSelect(statement.text);
        console.warn(
          JSON.stringify({
            event: retried ? "database:statement_retried" : "database:statement_lost",
            reason,
            sql_fingerprint: fingerprint(statement.text),
          }),
        );
        if (!retried) throw error;
        return fresh(statement);
      });
    }) as Pool["query"];
  }
}
