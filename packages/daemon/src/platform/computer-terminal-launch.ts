import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { posix } from "node:path";

type TerminalAccount = {
  username: string;
  homedir: string;
  shell: string;
};

const ACCOUNT_LOOKUP_TIMEOUT_MS = 2_000;
const TERMINAL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export async function readComputerTerminalAccount(): Promise<TerminalAccount | undefined> {
  const effectiveUid = process.geteuid?.();
  if (effectiveUid === undefined) return undefined;
  const uid = String(effectiveUid);
  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? ["/usr/bin/dscacheutil", "-q", "user", "-a", "uid", uid]
      : platform === "linux"
        ? ["/usr/bin/getent", "passwd", uid]
        : undefined;
  if (!cmd) return undefined;
  const output = await readSystemValue(cmd);
  if (output === undefined) return undefined;
  return platform === "darwin"
    ? parseDirectoryAccount(output, uid)
    : parsePasswdAccount(output, uid);
}

export async function readComputerTerminalTempDirectory(): Promise<string | undefined> {
  if (process.platform === "linux") return "/tmp";
  if (process.platform !== "darwin") return undefined;
  const uid = process.geteuid?.();
  if (uid === undefined) return undefined;
  const output = await readSystemValue(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"]);
  const directory = output?.trimEnd();
  if (!directory || !isAbsolutePath(directory) || directory.includes("\n")) return undefined;
  try {
    const stat = statSync(directory);
    if (stat.isDirectory() && stat.uid === uid && (stat.mode & 0o077) === 0) return directory;
  } catch {
    return undefined;
  }
  return undefined;
}

async function readSystemValue(cmd: string[]): Promise<string | undefined> {
  try {
    const child = Bun.spawn({
      cmd,
      env: { PATH: TERMINAL_PATH, LANG: "C" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      signal: AbortSignal.timeout(ACCOUNT_LOOKUP_TIMEOUT_MS),
    });
    const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    if (code === 0) return output;
  } catch {
    return undefined;
  }
  return undefined;
}

function parseDirectoryAccount(output: string, uid: string): TerminalAccount | undefined {
  const fields = new Map<string, string>();
  for (const line of output.trimEnd().split("\n")) {
    const separator = line.indexOf(": ");
    if (separator < 1) return undefined;
    const key = line.slice(0, separator);
    if (fields.has(key)) return undefined;
    fields.set(key, line.slice(separator + 2));
  }
  if (fields.get("uid") !== uid) return undefined;
  const username = fields.get("name");
  const homedir = fields.get("dir");
  if (!username || !homedir) return undefined;
  return { username, homedir, shell: fields.get("shell") ?? "" };
}

function parsePasswdAccount(output: string, uid: string): TerminalAccount | undefined {
  const record = output.trimEnd();
  if (record.includes("\n")) return undefined;
  const fields = record.split(":");
  if (fields.length !== 7 || fields[2] !== uid) return undefined;
  return { username: fields[0]!, homedir: fields[5]!, shell: fields[6]! };
}

function isAbsolutePath(path: string): boolean {
  return posix.isAbsolute(path) && !path.includes("\0");
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDisabledShell(path: string): boolean {
  const name = posix.basename(path);
  return name === "nologin" || name === "false" || path === "/dev/null";
}

function isExplicitlyDisabled(shell: string): boolean {
  if (isDisabledShell(shell)) return true;
  try {
    return isDisabledShell(realpathSync(shell));
  } catch {
    return false;
  }
}

export function resolveComputerTerminalLaunch(options: {
  platform: NodeJS.Platform;
  readAccount: () => TerminalAccount | undefined;
  macTempDirectory?: string;
  isExecutable?: (path: string) => boolean;
}): { cwd: string; shell: string; env: Record<string, string> } {
  const { platform, readAccount, macTempDirectory, isExecutable = isExecutableFile } = options;
  if (platform !== "darwin" && platform !== "linux") throw new Error("unsupported");
  const account = readAccount();
  if (!account?.username || !isAbsolutePath(account.homedir)) throw new Error("spawn_failed");
  if (isExplicitlyDisabled(account.shell)) throw new Error("permission_denied");

  const tmpdir = platform === "darwin" ? macTempDirectory : "/tmp";
  if (!tmpdir || !isAbsolutePath(tmpdir)) throw new Error("spawn_failed");
  const fallback = platform === "darwin" ? ["/bin/zsh"] : ["/bin/bash", "/bin/sh"];
  const shell = [account.shell, ...fallback].find(
    (path) => isAbsolutePath(path) && isExecutable(path) && !isExplicitlyDisabled(path),
  );
  if (!shell) throw new Error("spawn_failed");

  return {
    cwd: account.homedir,
    shell,
    env: {
      HOME: account.homedir,
      USER: account.username,
      LOGNAME: account.username,
      SHELL: shell,
      TMPDIR: tmpdir,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      PATH: TERMINAL_PATH,
      LANG: platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8",
    },
  };
}
