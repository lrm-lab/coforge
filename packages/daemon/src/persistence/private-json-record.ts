import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Replaces a JSON record through a private temporary file; filesystem errors reach the caller. */
export async function writePrivateJsonRecord(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}
