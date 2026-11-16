import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export const MEMORY_FILE_BYTES = 512 * 1024;

export async function safeMemoryDirectory(
  root: string,
  relative: string,
  create = false,
): Promise<string> {
  if (relative === ".") return root;
  let path = root;
  for (const part of relative.split("/").filter(Boolean)) {
    if (part === "." || part === ".." || part.includes("\\")) throw new Error("memory_unsafe_path");
    path = join(path, part);
    if (create)
      await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    if (!(await lstat(path)).isDirectory()) throw new Error("memory_unsafe_path");
  }
  return path;
}

export async function readMemoryFile(
  root: string,
  relative: string,
  previewBytes = MEMORY_FILE_BYTES,
): Promise<string | undefined> {
  try {
    await safeMemoryDirectory(root, dirname(relative));
    if (!(await lstat(join(root, relative))).isFile()) throw new Error("memory_unsafe_path");
    const handle = await open(
      join(root, relative),
      constants.O_RDONLY |
        constants.O_NONBLOCK |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("memory_unsafe_path");
      if (stat.size > MEMORY_FILE_BYTES) throw new Error("memory_file_too_large");
      const bytes = new Uint8Array(Math.min(stat.size, previewBytes));
      let read = 0;
      while (read < bytes.length) {
        const next = await handle.read(bytes, read, bytes.length - read, read);
        if (next.bytesRead === 0) break;
        read += next.bytesRead;
      }
      return new TextDecoder().decode(bytes.subarray(0, read)).replace(/\uFFFD$/, "");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function replaceMemoryFile(
  root: string,
  relative: string,
  text: string,
): Promise<void> {
  const directory = await safeMemoryDirectory(root, dirname(relative), true);
  const temporary = join(directory, `.memory-${crypto.randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, join(root, relative));
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function listMemoryFiles(
  root: string,
): Promise<{ paths: string[]; incomplete: boolean }> {
  const paths = ["MEMORY.md"];
  const pending = ["notes"];
  let visited = 0;
  while (pending.length && visited < 8_192) {
    const relative = pending.shift()!;
    try {
      const path = await safeMemoryDirectory(root, relative);
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (++visited > 8_192) break;
        const next = `${relative}/${entry.name}`;
        if (entry.name.startsWith(".") || next === "notes/history") continue;
        if (entry.isDirectory()) pending.push(next);
        else if (entry.isFile() && entry.name.endsWith(".md")) paths.push(next);
      }
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof Error && error.message === "memory_unsafe_path")
      )
        throw error;
    }
  }
  return { paths: paths.sort(), incomplete: pending.length > 0 || visited > 8_192 };
}

export async function historyFiles(root: string, key: string): Promise<string[]> {
  try {
    const directory = await safeMemoryDirectory(root, `notes/history/${key}`);
    return (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.md$/.test(name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
