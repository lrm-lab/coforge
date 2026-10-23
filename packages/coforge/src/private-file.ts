import { open } from "node:fs/promises";

/** A new file the caller writes once, then closes. */
export type NewPrivateFile = { write(text: string): Promise<void>; close(): Promise<void> };

/** Creates `path` as a new file with mode 0600, failing with `EEXIST` if anything is there. `wx` is
 * O_CREAT | O_EXCL, which refuses an existing path, a symbolic link included. */
export async function createPrivateFile(path: string): Promise<NewPrivateFile> {
  const handle = await open(path, "wx", 0o600);
  return {
    write: async (text) => void (await handle.writeFile(text)),
    close: () => handle.close(),
  };
}
