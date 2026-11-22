import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export const DEVIN_RULE_PREFIX = "coforge-runtime-";
const STALE_RULE_AGE_MS = 60_000;
const liveRuleRefs = new Map<string, number>();
const ruleLocks = new Map<string, Promise<void>>();

export interface DevinRuleFile {
  readonly path: string;
  remove(): Promise<void>;
}

async function withRuleLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = ruleLocks.get(key) ?? Promise.resolve();
  let unlock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const tail = previous.then(() => gate);
  ruleLocks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    unlock();
    if (ruleLocks.get(key) === tail) ruleLocks.delete(key);
  }
}

async function assertNotSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error("Devin rule file must not be a symlink");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function writeRuleAtomically(
  directory: string,
  digest: string,
  path: string,
  text: string,
): Promise<void> {
  const temp = join(directory, `.${DEVIN_RULE_PREFIX}${digest}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, text, { mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
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
  const text = `---\ndescription: "CoForge runtime instructions"\ntrigger: always_on\n---\n\n${instructions.trimEnd()}\n`;

  await withRuleLock(path, async () => {
    await assertNotSymlink(path);
    const existingRefs = liveRuleRefs.get(path) ?? 0;
    liveRuleRefs.set(path, existingRefs + 1);
    try {
      await removeStaleRuleFiles(directory);
      if (existingRefs === 0 || !(await isRegularFile(path))) {
        await writeRuleAtomically(directory, digest, path, text);
      }
    } catch (error) {
      const remaining = (liveRuleRefs.get(path) ?? 1) - 1;
      if (remaining > 0) liveRuleRefs.set(path, remaining);
      else {
        liveRuleRefs.delete(path);
        await rm(path, { force: true });
      }
      throw error;
    }
  });

  const release = () =>
    withRuleLock(path, async () => {
      const remaining = (liveRuleRefs.get(path) ?? 1) - 1;
      if (remaining > 0) {
        liveRuleRefs.set(path, remaining);
        return;
      }
      liveRuleRefs.delete(path);
      await rm(path, { force: true });
    });

  let removal: Promise<void> | undefined;
  return {
    path,
    remove: () => (removal ??= release()),
  };
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
