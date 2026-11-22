import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export const DEVIN_RULE_PREFIX = "coforge-runtime-";
const STALE_RULE_AGE_MS = 60_000;
const liveRuleRefs = new Map<string, number>();

export interface DevinRuleFile {
  readonly path: string;
  remove(): Promise<void>;
}

async function assertNotSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error("Devin rule file must not be a symlink");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function createDevinRuleFile(
  agentWorkspaceDirectory: string,
  instructions: string,
): Promise<DevinRuleFile> {
  const directory = join(await realpath(agentWorkspaceDirectory), ".devin", "rules");
  await mkdir(directory, { recursive: true });
  if ((await realpath(directory)) !== directory)
    throw new Error("Devin rules directory must not be a symlink");
  const digest = createHash("sha256").update(instructions).digest("hex").slice(0, 16);
  const path = join(directory, `${DEVIN_RULE_PREFIX}${digest}.md`);
  await assertNotSymlink(path);
  liveRuleRefs.set(path, (liveRuleRefs.get(path) ?? 0) + 1);
  const release = async (): Promise<void> => {
    const remaining = (liveRuleRefs.get(path) ?? 1) - 1;
    if (remaining > 0) {
      liveRuleRefs.set(path, remaining);
      return;
    }
    liveRuleRefs.delete(path);
    await rm(path, { force: true });
  };
  const text = `---\ndescription: "CoForge runtime instructions"\ntrigger: always_on\n---\n\n${instructions.trimEnd()}\n`;
  try {
    await removeStaleRuleFiles(directory);
    await writeFile(path, text, { mode: 0o600 });
    await chmod(path, 0o600);
    let removal: Promise<void> | undefined;
    return {
      path,
      remove: () => (removal ??= release()),
    };
  } catch (error) {
    await release();
    throw error;
  }
}

async function removeStaleRuleFiles(directory: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_RULE_AGE_MS;
  for (const name of names) {
    if (!name.startsWith(DEVIN_RULE_PREFIX) || !name.endsWith(".md")) continue;
    const path = join(directory, name);
    if (liveRuleRefs.has(path)) continue;
    try {
      if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
    } catch {
      continue;
    }
  }
}
