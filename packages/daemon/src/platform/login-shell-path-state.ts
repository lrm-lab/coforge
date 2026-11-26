import { statSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { z } from "zod";
import { type LoginShellPathFailureReason, type LoginShellPathResult } from "./login-shell-path";
import { writePrivateFileAtomic } from "./private-file";

export const LOGIN_SHELL_PATH_FILE = "login-shell-path.json";

/** What the Coordinator last learned from the login shell, and when. The probe's `env` is
 * deliberately absent: credential-shaped variables are never persisted. */
export type LoginShellPathRecord =
  | { ok: true; path: string[]; shell: string; durationMs: number; at: string }
  | {
      ok: false;
      reason: LoginShellPathFailureReason;
      shell?: string;
      durationMs: number;
      at: string;
    };

/**
 * Replaces the stored result. A failure overwrites an earlier success on purpose: a PATH the
 * latest probe could not confirm must not keep steering the executable search.
 */
export async function writeLoginShellPath(
  stateDirectory: string,
  result: LoginShellPathResult,
  at: Date = new Date(),
): Promise<void> {
  // `env` carries credential-shaped variables: it is handed to children in memory only and must
  // never reach this file. The stored record keeps the PATH result shape exactly.
  const record: LoginShellPathRecord = result.ok
    ? {
        ok: true,
        path: result.path,
        shell: result.shell,
        durationMs: result.durationMs,
        at: at.toISOString(),
      }
    : {
        ok: false,
        reason: result.reason,
        ...(result.shell ? { shell: result.shell } : {}),
        durationMs: result.durationMs,
        at: at.toISOString(),
      };
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

const loginShellPathRecordSchema = z.discriminatedUnion("ok", [
  z.object({
    version: z.literal(1),
    ok: z.literal(true),
    path: z.array(z.string().refine((entry) => posix.isAbsolute(entry))),
    shell: z.string().min(1),
    durationMs: z.number().catch(0),
    at: z.string(),
  }),
  z.object({
    version: z.literal(1),
    ok: z.literal(false),
    reason: z.string(),
    shell: z.string().min(1).optional().catch(undefined),
    durationMs: z.number().catch(0),
    at: z.string(),
  }),
]);

function parseRecord(text: string): LoginShellPathRecord | undefined {
  const parsed = loginShellPathRecordSchema.safeParse(JSON.parse(text));
  if (!parsed.success) return undefined;
  if (parsed.data.ok) {
    const { path, shell, durationMs, at } = parsed.data;
    return { ok: true, path, shell, durationMs, at };
  }
  const { reason, shell, durationMs, at } = parsed.data;
  return {
    ok: false,
    reason: reason as LoginShellPathFailureReason,
    ...(shell !== undefined ? { shell } : {}),
    durationMs,
    at,
  };
}
