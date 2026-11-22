import type { AgentSessionOptions } from "@coforge/agent";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const OPENCODE_CONFIG_CONTENT_ENV = "OPENCODE_CONFIG_CONTENT";

export interface OpenCodeInstructions {
  readonly directory: string;
  readonly path: string;
  readonly configContent: string;
  remove(): Promise<void>;
}

const liveInstructionRefs = new Map<string, number>();
const directoryLocks = new Map<string, Promise<void>>();

async function withDirectoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = directoryLocks.get(key) ?? Promise.resolve();
  let unlock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const tail = previous.then(() => gate);
  directoryLocks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    unlock();
    if (directoryLocks.get(key) === tail) directoryLocks.delete(key);
  }
}

async function isOwnedPrivateDirectory(directory: string): Promise<boolean> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    const uid = process.getuid?.();
    return uid === undefined || info.uid === uid;
  } catch {
    return false;
  }
}

async function isSafeRegularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function isSafeRegularOrMissing(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function writeInstructionsAtomically(
  directory: string,
  path: string,
  instructions: string,
): Promise<void> {
  const temp = join(directory, `.instructions.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, instructions, { mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function acquireInstructionsDirectory(candidate: string): Promise<string> {
  try {
    await mkdir(candidate, { mode: 0o700 });
    return candidate;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "EEXIST" &&
      (await isOwnedPrivateDirectory(candidate)) &&
      (await isSafeRegularOrMissing(join(candidate, "instructions.md")))
    ) {
      return candidate;
    }
    return mkdtemp(join(tmpdir(), "coforge-opencode-"));
  }
}

export async function createOpenCodeInstructions(
  instructions: string,
  scopeKey?: string,
): Promise<OpenCodeInstructions> {
  const digest = createHash("sha256")
    .update(scopeKey ?? "")
    .update("\0")
    .update(instructions)
    .digest("hex")
    .slice(0, 16);
  const candidate = join(tmpdir(), `coforge-opencode-${digest}`);

  const { directory, path } = await withDirectoryLock(candidate, async () => {
    const acquired = await acquireInstructionsDirectory(candidate);
    const filePath = join(acquired, "instructions.md");
    const existingRefs = liveInstructionRefs.get(acquired) ?? 0;
    liveInstructionRefs.set(acquired, existingRefs + 1);
    try {
      await chmod(acquired, 0o700);
      if (existingRefs === 0 || !(await isSafeRegularFile(filePath))) {
        await writeInstructionsAtomically(acquired, filePath, instructions);
      }
      return { directory: acquired, path: filePath };
    } catch (error) {
      const remaining = (liveInstructionRefs.get(acquired) ?? 1) - 1;
      if (remaining > 0) liveInstructionRefs.set(acquired, remaining);
      else {
        liveInstructionRefs.delete(acquired);
        await rm(acquired, { recursive: true, force: true });
      }
      throw error;
    }
  });

  const release = () =>
    withDirectoryLock(directory, async () => {
      const remaining = (liveInstructionRefs.get(directory) ?? 1) - 1;
      if (remaining > 0) {
        liveInstructionRefs.set(directory, remaining);
        return;
      }
      liveInstructionRefs.delete(directory);
      await rm(directory, { recursive: true, force: true });
    });

  let removal: Promise<void> | undefined;
  return {
    directory,
    path,
    configContent: JSON.stringify({ instructions: [path] }),
    remove: () => (removal ??= release()),
  };
}

/**
 * True when the child would already inherit `OPENCODE_CONFIG_CONTENT`. The turn host applies
 * `policy.environment` last, so a value here would be overwritten unless the launch refuses.
 * Declared Agent environment wins over runtime `envVars`, which wins over the process environment;
 * any of the three counts as already set, including an empty string.
 */
export function openCodeConfigContentAlreadySet(options: AgentSessionOptions): boolean {
  const name = OPENCODE_CONFIG_CONTENT_ENV;
  return (
    options.environment?.[name] !== undefined ||
    options.runtime?.envVars?.[name] !== undefined ||
    Bun.env[name] !== undefined
  );
}
