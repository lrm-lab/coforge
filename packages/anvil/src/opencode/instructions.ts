import type { AgentSessionOptions } from "@coforge/agent";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Inline OpenCode config. It is not the CLI's own `OPENCODE_CLI_CONFIG_CONTENT`. */
export const OPENCODE_CONFIG_CONTENT_ENV = "OPENCODE_CONFIG_CONTENT";

export interface OpenCodeInstructions {
  readonly directory: string;
  readonly path: string;
  /** `{instructions:[absolute path]}` for `OPENCODE_CONFIG_CONTENT`. */
  readonly configContent: string;
  remove(): Promise<void>;
}

/**
 * Private instructions file for one session. The directory is 0700 and the file is 0600.
 * `remove` deletes the directory. Nothing is written into the Agent workspace or the user's
 * OpenCode config.
 */
export async function createOpenCodeInstructions(
  instructions: string,
): Promise<OpenCodeInstructions> {
  const directory = await mkdtemp(join(tmpdir(), "coforge-opencode-"));
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
      remove: () => (removal ??= rm(directory, { recursive: true, force: true })),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
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
