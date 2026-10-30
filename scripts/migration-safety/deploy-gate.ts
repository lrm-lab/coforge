// The last guard before `prisma migrate deploy`: every migration not yet applied is checked against
// the live catalog, and one that is high risk and not annotated for these table sizes stops the
// deploy before any migration runs (the running version keeps serving).
import { existsSync, readFileSync } from "node:fs";
import type { CatalogSource } from "./catalog-query";
import { isGrandfathered } from "./grandfather";
import { listMigrations } from "./migration-files";
import { createdTables } from "./rules";
import { catalogOf } from "./snapshot";
import { verifyMigration } from "./verify";

export async function deployGate(
  source: CatalogSource,
  migrationsDir: string,
  now: Date,
): Promise<number> {
  if (!existsSync(migrationsDir)) {
    console.error(`migration-safety: ${migrationsDir} not found`);
    return 2;
  }
  try {
    const applied = new Set(await source.applied());
    const pending = listMigrations(migrationsDir).filter(({ name }) => !applied.has(name));
    const catalog = catalogOf({ tables: await source.tables() });
    // Tables the pending migrations create one after another are not in the live catalog yet.
    const created = new Set<string>();
    const problems: string[] = [];
    for (const { name, file } of pending) {
      const text = readFileSync(file, "utf8");
      // Migrations from before the check existed are applied as they are.
      if (isGrandfathered(name)) {
        for (const table of createdTables(text)) created.add(table);
        continue;
      }
      const result = verifyMigration(text, {
        file,
        now,
        createdElsewhere: () => created,
        catalog: () => ({ tables: catalog }),
      });
      problems.push(...result.problems.map((problem) => `${file}: ${problem}`));
      for (const table of result.analysis.creates) created.add(table);
    }
    if (problems.length > 0) {
      console.error(
        `migration-safety: the deploy is stopped before any migration runs; the running version keeps serving.`,
      );
      for (const problem of problems) console.error(`  ${problem}`);
      return 1;
    }
    console.error(
      `migration-safety: ${pending.length} pending migration(s) pass against the live catalog`,
    );
    return 0;
  } catch (error) {
    console.error(
      `migration-safety: the live catalog could not be read (${(error as Error).message}); the deploy is stopped.`,
    );
    return 2;
  } finally {
    await source.close();
  }
}
