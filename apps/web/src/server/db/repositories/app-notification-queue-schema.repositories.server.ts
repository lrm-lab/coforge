import type { DatabaseScope } from "#src/server/db/transaction.server";

/** Reads whether pg-boss's own schema is in this database. */
export class PrismaAppNotificationQueueSchema {
  constructor(private readonly db: DatabaseScope) {}

  /** Whether pg-boss has ever started on this database, that is, its `pgboss` schema exists. */
  async exists(): Promise<boolean> {
    const rows = await this.db.$queryRaw<
      { present: boolean }[]
    >`SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgboss') AS present`;
    return rows[0]?.present === true;
  }
}
