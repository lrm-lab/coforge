import { statSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { type LoginShellPathFailureReason, type LoginShellPathResult } from "./login-shell-path";
import { writePrivateFileAtomic } from "./private-file";

export const LOGIN_SHELL_PATH_FILE = "login-shell-path.json";

/** What the Coordinator last learned from the login shell, and when. */
export type LoginShellPathRecord = LoginShellPathResult & { at: string };

/**
 * Replaces the stored result. A failure overwrites an earlier success on purpose: a PATH the
 * latest probe could not confirm must not keep steering the executable search.
 */
export async function writeLoginShellPath(
  stateDirectory: string,
  result: LoginShellPathResult,
  at: Date = new Date(),
): Promise<void> {
  const record: LoginShellPathRecord = { ...result, at: at.toISOString() };
  await writePrivateFileAtomic(
    join(stateDirectory, LOGIN_SHELL_PATH_FILE),
    `${JSON.stringify({ version: 1, ...record })}\n`,
  );
}

const cache = new Map<string, { key: string; record: LoginShellPathRecord | undefined }>();

/**
 * The stored result, or undefined when none was written or the file is unreadable. Synchronous
 * and keyed on the file's identity, mtime and size, so a repeated lookup costs one `stat`.
 */
export function readLoginShellPath(stateDirectory: string): LoginShellPathRecord | undefined {
  const file = join(stateDirectory, LOGIN_SHELL_PATH_FILE);
  try {
    const info = statSync(file);
    const key = `${info.ino}:${info.mtimeMs}:${info.size}`;
    const cached = cache.get(file);
    if (cached?.key === key) return cached.record;
    const record = parseRecord(readFileSync(file, "utf8"));
    cache.set(file, { key, record });
    return record;
  } catch {
    cache.delete(file);
    return undefined;
  }
}

/** The Coordinator's state directory as a Workspace Daemon knows it: the supervisor sets
 * `COFORGE_SUPERVISOR_STATE_PATH` (a file directly in that directory) on every child it starts. */
export function supervisorStateDirectory(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const statePath = environment.COFORGE_SUPERVISOR_STATE_PATH;
  return statePath ? dirname(statePath) : undefined;
}

/** The directories the last successful probe found, or none. */
export function loginShellPathDirectories(stateDirectory: string | undefined): string[] {
  const record = stateDirectory ? readLoginShellPath(stateDirectory) : undefined;
  return record?.ok ? record.path : [];
}

function parseRecord(text: string): LoginShellPathRecord | undefined {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.at !== "string") return undefined;
  const durationMs = typeof record.durationMs === "number" ? record.durationMs : 0;
  const shell = typeof record.shell === "string" ? record.shell : undefined;
  if (record.ok === true) {
    const path = record.path;
    if (!shell || !Array.isArray(path)) return undefined;
    if (!path.every((entry) => typeof entry === "string" && posix.isAbsolute(entry)))
      return undefined;
    return { ok: true, path: path as string[], shell, durationMs, at: record.at };
  }
  if (record.ok !== false || typeof record.reason !== "string") return undefined;
  return {
    ok: false,
    reason: record.reason as LoginShellPathFailureReason,
    ...(shell ? { shell } : {}),
    durationMs,
    at: record.at,
  };
}
