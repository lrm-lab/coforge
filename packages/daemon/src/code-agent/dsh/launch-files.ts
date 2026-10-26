import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type RenderDshLaunchContents = (
  instructions: string,
  pluginPath: string,
) => { plugin: string; patch: string };

/** Native file modes and cleanup belong to the host; the renderer supplies only inert content. */
export async function prepareDshLaunchFiles(
  instructions: string,
  render: RenderDshLaunchContents,
  temporaryRoot = tmpdir(),
) {
  const directory = await mkdtemp(join(temporaryRoot, "coforge-dsh-"));
  let cleanup: Promise<void> | undefined;
  const remove = () => (cleanup ??= rm(directory, { recursive: true, force: true }));
  try {
    await chmod(directory, 0o700);
    const pluginPath = join(directory, "instructions.mjs");
    const patchPath = join(directory, "launch.patch.yml");
    const contents = render(instructions, pluginPath);
    // fs writes are intentional: Bun.write has no exclusive-create/mode options.
    await writeFile(pluginPath, contents.plugin, { flag: "wx", mode: 0o600 });
    await writeFile(patchPath, contents.patch, { flag: "wx", mode: 0o600 });
    return { patchPath, cleanup: remove };
  } catch (error) {
    await remove();
    throw error;
  }
}
