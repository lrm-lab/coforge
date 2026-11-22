import type { AgentSessionOptions } from "@coforge/agent";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function isSafeRegularOrMissing(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function acquireInstructionsDirectory(
  instructions: string,
  scopeKey?: string,
): Promise<string> {
  const digest = createHash("sha256")
    .update(scopeKey ?? "")
    .update("\0")
    .update(instructions)
    .digest("hex")
    .slice(0, 16);
  const candidate = join(tmpdir(), `coforge-opencode-${digest}`);
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
  const directory = await acquireInstructionsDirectory(instructions, scopeKey);
  liveInstructionRefs.set(directory, (liveInstructionRefs.get(directory) ?? 0) + 1);
  const release = async (): Promise<void> => {
    const remaining = (liveInstructionRefs.get(directory) ?? 1) - 1;
    if (remaining > 0) {
      liveInstructionRefs.set(directory, remaining);
      return;
    }
    liveInstructionRefs.delete(directory);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await chmod(directory, 0o700);
    const path = join(directory, "instructions.md");
    await writeFile(path, instructions, { mode: 0o600 });
    await chmod(path, 0o600);
    let removal: Promise<void> | undefined;
    return {
      directory,
      path,
      configContent: JSON.stringify({ instructions: [path] }),
      remove: () => (removal ??= release()),
    };
  } catch (error) {
    await release();
    throw error;
  }
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
