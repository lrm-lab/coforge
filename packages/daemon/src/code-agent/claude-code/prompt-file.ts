import type { ClaudePromptFile } from "@lrm/coforge-anvil/claude-code";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Writes `instructions` to a fresh private directory. `remove` is injectable for tests. */
export async function createPromptFile(
  instructions: string,
  remove: (path: string) => Promise<void> = (path) => rm(path, { recursive: true, force: true }),
): Promise<ClaudePromptFile> {
  const directory = await mkdtemp(join(tmpdir(), "coforge-claude-prompt-"));
  const path = join(directory, "system-prompt.md");
  await writeFile(path, instructions, { mode: 0o600 });
  let removal: Promise<void> | undefined;
  return {
    path,
    remove: () => (removal ??= remove(directory)),
  };
}
