import { chmod, mkdir, open, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Replaces a JSON record through a private temporary file; filesystem errors reach the caller. */
export async function writePrivateJsonRecord(
  path: string,
  value: unknown,
  { durable = false }: { durable?: boolean } = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const text = JSON.stringify(value) + "\n";
  if (durable) await writeSynced(temporary, text);
  else await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
  if (durable) await syncDirectory(dirname(path));
}

async function writeSynced(path: string, text: string): Promise<void> {
  const handle = await open(path, "w", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
