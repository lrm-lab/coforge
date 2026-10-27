import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Reads the sibling instructions file once. `appendSystemPrompt` returns that cached text.
 * `loaded` is written only after that read, so a missing marker means the factory never ran. */
const COMMAND_CODE_INSTRUCTION_MOD = `import { readFileSync, writeFileSync } from "node:fs";

export default function (cmd) {
  const instructions = readFileSync(new URL("./instructions.md", import.meta.url), "utf8");
  writeFileSync(new URL("./loaded", import.meta.url), "loaded\\n");
  cmd.hooks({
    appendSystemPrompt() {
      return instructions;
    },
  });
}
`;

export const COMMAND_CODE_INSTRUCTION_MOD_LOADED = "loaded";

export interface CommandCodeInstructionMod {
  readonly directory: string;
  readonly modPath: string;
  remove(): Promise<void>;
}

/** Private session mod. Directory is 0700 and both files are 0600; `remove` deletes the directory. */
export async function createCommandCodeInstructionMod(
  instructions: string,
): Promise<CommandCodeInstructionMod> {
  const directory = await mkdtemp(join(tmpdir(), "coforge-command-code-"));
  try {
    await chmod(directory, 0o700);
    const instructionsPath = join(directory, "instructions.md");
    const modPath = join(directory, "mod.mjs");
    await writeFile(instructionsPath, instructions, { mode: 0o600 });
    await writeFile(modPath, COMMAND_CODE_INSTRUCTION_MOD, { mode: 0o600 });
    await chmod(instructionsPath, 0o600);
    await chmod(modPath, 0o600);
    let removal: Promise<void> | undefined;
    return {
      directory,
      modPath,
      remove: () => (removal ??= rm(directory, { recursive: true, force: true })),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
