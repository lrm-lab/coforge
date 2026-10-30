// The migration directories of a Prisma migrations folder.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Each directory holding a migration.sql, in name (so application) order. */
export function listMigrations(dir: string): { name: string; file: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "migration.sql")))
    .map((entry) => ({ name: entry.name, file: join(dir, entry.name, "migration.sql") }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}
