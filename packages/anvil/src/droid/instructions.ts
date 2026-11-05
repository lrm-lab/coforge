import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface DroidInstructions {
  /** The private instruction file's absolute path, outside the workspace. */
  readonly path: string;
  remove(): Promise<void>;
}

/**
 * Standing instructions ride Droid's own `--append-system-prompt-file` flag, which `droid exec
 * --output-format acp` accepts (verified on 1.4.1). The file lives in a private temporary
 * directory rather than the workspace, so a launch never adds a file a person or a repository
 * sees, and each session removes its own copy.
 */
export async function createDroidInstructions(instructions: string): Promise<DroidInstructions> {
  const directory = await mkdtemp(join(tmpdir(), "coforge-droid-"));
  await chmod(directory, 0o700);
  const path = join(directory, "instructions.md");
  await writeFile(path, instructions, { mode: 0o600 });
  let removal: Promise<void> | undefined;
  return {
    path,
    remove: () =>
      (removal ??= rm(directory, { recursive: true, force: true }).catch(() => undefined)),
  };
}
