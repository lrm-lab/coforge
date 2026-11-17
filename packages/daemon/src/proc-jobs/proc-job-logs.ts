import { chmod, lstat, mkdir, open, rename, rm, truncate } from "node:fs/promises";
import { join } from "node:path";
import { PROC_LOG_MAX_BYTES, PROC_LOGS_DEFAULT_TAIL } from "@lrm/coforge-sdk/agent";
import { ProcJobError } from "./proc-job-error";

const MAX_SLICE_BYTES = 256 * 1024;

export function agentProcLogsDirectory(agentWorkspaceDir: string): string {
  return join(agentWorkspaceDir, "proc-logs");
}

async function assertNotSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new ProcJobError(
        "proc_invalid_request",
        400,
        `proc log path must not be a symlink: ${path}`,
      );
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
}

export async function prepareProcJobLogFile(
  agentWorkspaceDir: string,
  name: string,
): Promise<string> {
  const directory = agentProcLogsDirectory(agentWorkspaceDir);
  await assertNotSymlink(agentWorkspaceDir);
  await assertNotSymlink(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
  const logPath = join(directory, `${name}.log`);
  await assertNotSymlink(logPath);
  await assertNotSymlink(`${logPath}.1`);
  await rm(`${logPath}.1`, { force: true });
  const handle = await open(logPath, "w", 0o600);
  await handle.close();
  await chmod(logPath, 0o600).catch(() => {});
  return logPath;
}

export async function removeProcJobLogFiles(logPath: string): Promise<void> {
  await Promise.all([rm(logPath, { force: true }), rm(`${logPath}.1`, { force: true })]).catch(
    () => {},
  );
}

export async function rotateProcLogIfNeeded(
  logPath: string,
  maxBytes: number = PROC_LOG_MAX_BYTES,
): Promise<boolean> {
  let info;
  try {
    info = await lstatIfExists(logPath);
    if (!info || info.isSymbolicLink() || info.size <= maxBytes) return false;
  } catch {
    return false;
  }
  const keptBytes = Math.max(1, Math.floor(maxBytes / 2));
  const backupPath = `${logPath}.1`;
  const backupTmp = `${backupPath}.tmp`;
  const start = Math.max(0, info.size - keptBytes);
  const length = info.size - start;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await assertNotSymlink(logPath);
    await assertNotSymlink(backupPath);
    await assertNotSymlink(backupTmp);
    await rm(backupTmp, { force: true });
    handle = await open(logPath, "r");
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    const out = await open(backupTmp, "w", 0o600);
    try {
      await out.writeFile(buffer.subarray(0, bytesRead));
    } finally {
      await out.close();
    }
    await chmod(backupTmp, 0o600).catch(() => {});
    await rename(backupTmp, backupPath);
  } catch {
    await rm(backupTmp, { force: true }).catch(() => {});
    return false;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  await truncate(logPath, 0);
  return true;
}

async function lstatIfExists(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

function sliceLastLines(text: string, tail: number): string {
  if (tail <= 0) return "";
  const trailingNewline = text.endsWith("\n");
  const rawLines = text.split("\n");
  if (trailingNewline) rawLines.pop();
  const kept = rawLines.slice(-tail);
  if (kept.length === 0) return "";
  return trailingNewline ? `${kept.join("\n")}\n` : kept.join("\n");
}

export async function readProcJobLogSlice(
  logPath: string,
  options: { tail?: number; offset?: number; maxSliceBytes?: number } = {},
): Promise<{ content: string; nextOffset: number; rotated: boolean; truncated: boolean }> {
  const maxSliceBytes = options.maxSliceBytes ?? MAX_SLICE_BYTES;
  await assertNotSymlink(logPath);
  let info;
  try {
    info = await lstat(logPath);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT")
      return { content: "", nextOffset: 0, rotated: false, truncated: false };
    throw error;
  }
  if (info.isSymbolicLink())
    throw new ProcJobError(
      "proc_invalid_request",
      400,
      `proc log path must not be a symlink: ${logPath}`,
    );
  const size = info.size;
  if (options.offset !== undefined) {
    if (options.offset > size)
      return { content: "", nextOffset: 0, rotated: true, truncated: false };
    const available = size - options.offset;
    const readLength = Math.min(available, maxSliceBytes);
    const truncated = available > readLength;
    if (readLength === 0)
      return { content: "", nextOffset: size, rotated: false, truncated: false };
    const handle = await open(logPath, "r");
    try {
      const buffer = Buffer.alloc(readLength);
      const { bytesRead } = await handle.read(buffer, 0, readLength, options.offset);
      return {
        content: buffer.subarray(0, bytesRead).toString("utf8"),
        nextOffset: options.offset + bytesRead,
        rotated: false,
        truncated,
      };
    } finally {
      await handle.close();
    }
  }

  const tail = options.tail ?? PROC_LOGS_DEFAULT_TAIL;
  const start = Math.max(0, size - maxSliceBytes);
  const length = size - start;
  const truncatedBySize = start > 0;
  if (length === 0) return { content: "", nextOffset: 0, rotated: false, truncated: false };
  const handle = await open(logPath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let raw = buffer.subarray(0, bytesRead).toString("utf8");
    if (truncatedBySize) {
      const firstNewline = raw.indexOf("\n");
      if (firstNewline !== -1) raw = raw.slice(firstNewline + 1);
    }
    const content = sliceLastLines(raw, tail);
    return {
      content,
      nextOffset: start + bytesRead,
      rotated: false,
      truncated: truncatedBySize || content.length < raw.length,
    };
  } finally {
    await handle.close();
  }
}
