import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_MIGRATION_IGNORE_FILE, AGENT_MIGRATION_IGNORE_SEED } from "./selection-rules";

/**
 * Gives a workspace the default migration ignore file when it has none. The workspace seed calls
 * it at launch, and a migration calls it again before selecting files, for a workspace whose Agent
 * has not launched since. Create-only (`wx`), so an Agent's own copy, or anything else at that
 * path, is never touched.
 */
export async function ensureAgentMigrationIgnoreFile(workspaceDirectory: string): Promise<void> {
  try {
    await writeFile(
      join(workspaceDirectory, AGENT_MIGRATION_IGNORE_FILE),
      AGENT_MIGRATION_IGNORE_SEED,
      {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      },
    );
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
  }
}
