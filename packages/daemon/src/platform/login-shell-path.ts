import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, join, posix } from "node:path";

/** How long the login shell has to start, run its rc files, and print its PATH. */
export const LOGIN_SHELL_PATH_TIMEOUT_MS = 10_000;
/** `COFORGE_LOGIN_SHELL_PATH=0` turns the probe off. */
export const LOGIN_SHELL_PATH_SWITCH = "COFORGE_LOGIN_SHELL_PATH";
/** The hidden subcommand of the Computer executable that the login shell runs. */
export const PRINT_PATH_COMMAND = "__print-path";

const RESULT_MAX_BYTES = 256 * 1024;
const SHELLS = ["zsh", "bash", "sh", "dash", "ksh", "fish"] as const;
type LoginShellKind = (typeof SHELLS)[number];

export type LoginShellPathFailureReason =
  | "disabled"
  | "skipped"
  | "unsupported_shell"
  | "timeout"
  | "exit_nonzero"
  | "no_result"
  | "invalid_result"
  | "spawn_failed"
  | "temp_dir_failed"
  | "aborted"
  | "internal_error";

export type LoginShellPathResult =
  | { ok: true; path: string[]; shell: string; durationMs: number }
  | { ok: false; reason: LoginShellPathFailureReason; shell?: string; durationMs: number };

/** The probe's child: its exit, and a way to kill it together with everything it started. */
export type LoginShellProcess = {
  exited: Promise<number | null>;
  killGroup(): void;
};

export type LoginShellPathProbeOptions = {
  platform?: NodeJS.Platform;
  environment?: Readonly<Record<string, string | undefined>>;
  /** The account's login shell (not `$SHELL`, which a launchd or systemd service may lack). */
  accountShell?: () => string | undefined;
  /** The command that re-enters this executable; defaults to `[process.execPath]`. */
  selfCommand?: readonly string[];
  spawn?: (command: string[], environment: Record<string, string>) => LoginShellProcess;
  timeoutMs?: number;
  now?: () => number;
  tempRoot?: string;
  signal?: AbortSignal;
};

/**
 * Reads PATH, and only PATH, from the user's login shell. The shell runs this executable's
 * `__print-path` subcommand, which writes `{ nonce, path }` to a private file; the shell's own
 * output (rc files may print anything) is never read.
 */
export async function probeLoginShellPath(
  options: LoginShellPathProbeOptions = {},
): Promise<LoginShellPathResult> {
  const environment = options.environment ?? process.env;
  const now = options.now ?? Date.now;
  const started = now();
  const fail = (
    reason: LoginShellPathFailureReason,
    shell?: string,
  ): Extract<LoginShellPathResult, { ok: false }> => ({
    ok: false,
    reason,
    ...(shell ? { shell } : {}),
    durationMs: now() - started,
  });
  if (environment[LOGIN_SHELL_PATH_SWITCH] === "0") return fail("disabled");
  if ((options.platform ?? process.platform) === "win32") return fail("skipped");
  const shell = (options.accountShell ?? accountLoginShell)() ?? environment.SHELL;
  const kind = shell ? shellKind(shell) : undefined;
  if (!shell || !kind) return fail("unsupported_shell", shell);

  let directory: string;
  try {
    directory = await mkdtemp(join(options.tempRoot ?? tmpdir(), "coforge-login-path-"));
  } catch {
    return fail("temp_dir_failed", shell);
  }
  try {
    const file = join(directory, "result.json");
    const nonce = randomUUID();
    try {
      await writeFile(file, "", { flag: "wx", mode: 0o600 });
    } catch {
      return fail("temp_dir_failed", shell);
    }
    const script = printPathScript(kind, options.selfCommand ?? [process.execPath], file, nonce);
    const env = Object.fromEntries(
      Object.entries(environment).filter((entry): entry is [string, string] => !!entry[1]),
    );
    let child: LoginShellProcess;
    try {
      child = (options.spawn ?? spawnLoginShell)([shell, "-i", "-l", "-c", script], env);
    } catch {
      return fail("spawn_failed", shell);
    }
    const outcome = await waitForShell(child, options.timeoutMs, options.signal);
    if (outcome.kind !== "exited") return fail(outcome.kind, shell);
    const path = await readProbeResult(file, nonce);
    if (path.length > 0) return { ok: true, path, shell, durationMs: now() - started };
    if (outcome.code !== 0) return fail("exit_nonzero", shell);
    return fail((await resultFileEmpty(file)) ? "no_result" : "invalid_result", shell);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/** What `__print-path` does in the login shell: records this process's own PATH for the parent. */
export async function writeLoginShellPathProbe(
  file: string,
  nonce: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  if (!file || !nonce) throw new Error("usage: __print-path <file> <nonce>");
  await writeFile(file, JSON.stringify({ nonce, path: environment.PATH ?? "" }));
}

/** Absolute directories only, each once, in order. */
export function parsePathEntries(value: string): string[] {
  const seen = new Set<string>();
  for (const entry of value.split(":"))
    if (posix.isAbsolute(entry) && !/[\0\r\n]/.test(entry)) seen.add(entry);
  return [...seen];
}

function accountLoginShell(): string | undefined {
  try {
    return userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

function shellKind(shell: string): LoginShellKind | undefined {
  const name = basename(shell);
  return SHELLS.find((kind) => kind === name);
}

/** Single-quotes `value` for the shell; fish treats backslash as an escape inside quotes. */
export function quote(kind: LoginShellKind, value: string): string {
  return kind === "fish"
    ? `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

function printPathScript(
  kind: LoginShellKind,
  selfCommand: readonly string[],
  file: string,
  nonce: string,
): string {
  return [...selfCommand, PRINT_PATH_COMMAND, file, nonce]
    .map((part) => quote(kind, part))
    .join(" ");
}

/** A process group of its own, so a timeout can kill the shell and everything its rc files ran. */
function spawnLoginShell(command: string[], env: Record<string, string>): LoginShellProcess {
  const child = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env,
    detached: true,
  });
  return {
    exited: child.exited,
    killGroup() {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is already gone.
      }
    },
  };
}

type ShellOutcome = { kind: "exited"; code: number | null } | { kind: "timeout" | "aborted" };

async function waitForShell(
  child: LoginShellProcess,
  timeoutMs = LOGIN_SHELL_PATH_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<ShellOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<ShellOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    onAbort = () => resolve({ kind: "aborted" });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const outcome = await Promise.race([
      child.exited.then((code): ShellOutcome => ({ kind: "exited", code })),
      interrupted,
    ]);
    if (outcome.kind !== "exited") child.killGroup();
    return outcome;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/** The PATH entries of a result file whose nonce matches; empty for anything else. */
async function readProbeResult(file: string, nonce: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readResultFile(file));
    if (typeof parsed !== "object" || parsed === null) return [];
    const record = parsed as { nonce?: unknown; path?: unknown };
    if (record.nonce !== nonce || typeof record.path !== "string") return [];
    return parsePathEntries(record.path);
  } catch {
    return [];
  }
}

async function readResultFile(file: string): Promise<string> {
  const info = await lstat(file);
  if (!info.isFile() || info.size > RESULT_MAX_BYTES) throw new Error("unusable result file");
  return readFile(file, "utf8");
}

async function resultFileEmpty(file: string): Promise<boolean> {
  try {
    return (await lstat(file)).size === 0;
  } catch {
    return true;
  }
}
