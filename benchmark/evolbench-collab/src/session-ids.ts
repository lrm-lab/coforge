import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Ids of the runtime sessions in an Agent workspace, oldest first. The Agent row's
 * `currentSessionId` is the Web's session id, not the runtime's, and an Agent may open
 * more than one runtime session per episode; the session files are the source of truth.
 */
export async function listSessionIds(cwd: string): Promise<string[]> {
  const dir = join(cwd, ".builtin-sessions");
  const names = (await readdir(dir).catch(() => [] as string[]))
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  const ids: string[] = [];
  for (const name of names) {
    const first = (await readFile(join(dir, name), "utf8")).split("\n", 1)[0] ?? "";
    try {
      const header = JSON.parse(first) as { type?: string; id?: unknown };
      if (header.type === "session" && typeof header.id === "string") ids.push(header.id);
    } catch {
      // a partially written session file is skipped
    }
  }
  return ids;
}
