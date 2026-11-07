import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";

const LOGIN1 = [
  "org.freedesktop.login1",
  "/org/freedesktop/login1",
  "org.freedesktop.login1.Manager",
] as const;

type CommandResult = { code: number | null; stdout: string };
export type LogindSessionRisk = { sessionScope: string; user: string; linger: boolean | null };
export type LogindSessionRiskDependencies = {
  platform?: string;
  uid?: number | null;
  user?: string;
  readCgroup?: () => Promise<string>;
  run?: (command: string, args: string[]) => Promise<CommandResult>;
};

function sessionScopeFromCgroup(text: string): { scope: string; ownerUid: number | null } | null {
  for (const line of text.split("\n")) {
    const parts = line.split(":");
    if (parts.length < 3) continue;
    const controllers = parts[1] ?? "";
    if (parts[0] !== "0" && !controllers.split(",").includes("name=systemd")) continue;
    const cgroupPath = parts.slice(2).join(":").trim();
    const match = /\/(session-[^/]+\.scope)(?:\/|$)/.exec(cgroupPath);
    if (!match) continue;
    const owner = /\/user-(\d+)\.slice\//.exec(cgroupPath);
    return { scope: match[1], ownerUid: owner ? Number(owner[1]) : null };
  }
  return null;
}

function parseBusctlBoolean(text: string): boolean | null {
  const match = /^b (true|false)$/.exec(text.trim());
  return match ? match[1] === "true" : null;
}

function parseBusctlStrings(text: string): string[] | null {
  const trimmed = text.trim();
  if (!/^as \d+/.test(trimmed)) return null;
  return [...trimmed.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]);
}

async function logindKillsSessionOf(
  run: (command: string, args: string[]) => Promise<CommandResult>,
  user: string,
): Promise<boolean | null> {
  const get = async (property: string) => {
    const result = await run("busctl", ["get-property", ...LOGIN1, property]);
    return result.code === 0 ? result.stdout : null;
  };
  const killText = await get("KillUserProcesses");
  const kill = killText === null ? null : parseBusctlBoolean(killText);
  if (kill !== true) return kill;
  const [excludeText, onlyText] = await Promise.all([
    get("KillExcludeUsers"),
    get("KillOnlyUsers"),
  ]);
  if ((parseBusctlStrings(excludeText ?? "") ?? []).includes(user)) return false;
  const only = parseBusctlStrings(onlyText ?? "") ?? [];
  return only.length === 0 || only.includes(user);
}

async function lingerOf(
  run: (command: string, args: string[]) => Promise<CommandResult>,
  user: string,
): Promise<boolean | null> {
  const result = await run("loginctl", ["show-user", user, "-p", "Linger", "--value"]);
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return value === "yes" ? true : value === "no" ? false : null;
}

export async function detectLogindSessionRisk(
  dependencies: LogindSessionRiskDependencies = {},
): Promise<LogindSessionRisk | null> {
  if ((dependencies.platform ?? process.platform) !== "linux") return null;
  let cgroup: string;
  try {
    cgroup = await (dependencies.readCgroup ?? (() => readFile("/proc/self/cgroup", "utf8")))();
  } catch {
    return null;
  }
  const session = sessionScopeFromCgroup(cgroup);
  if (!session) return null;
  const uid = dependencies.uid !== undefined ? dependencies.uid : (process.getuid?.() ?? null);
  if (session.ownerUid !== null && uid !== null && session.ownerUid !== uid) return null;
  const run = dependencies.run ?? runCommand;
  const user = dependencies.user ?? userInfo().username;
  try {
    if ((await logindKillsSessionOf(run, user)) !== true) return null;
    return { sessionScope: session.scope, user, linger: await lingerOf(run, user) };
  } catch {
    return null;
  }
}

function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

export function formatLogindSessionRisk(risk: LogindSessionRisk): string[] {
  const linger = risk.linger === true ? [] : [`  loginctl enable-linger ${shellWord(risk.user)}`];
  return [
    `Warning: this Computer runs inside login session ${risk.sessionScope}; systemd-logind KillUserProcesses=yes will stop it when you log out.`,
    "To keep it running, enable user lingering and start it from a user service:",
    ...linger,
    "  systemd-run --user --unit=coforge-computer --property=KillMode=mixed --property=OOMPolicy=continue coforge-computer start",
  ];
}

async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  const child = (() => {
    try {
      return Bun.spawn({
        cmd: [command, ...args],
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
    } catch {
      return undefined;
    }
  })();
  if (!child) return { code: null, stdout: "" };
  const timer = setTimeout(() => child.kill(), 2_000);
  try {
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { code, stdout };
  } catch {
    return { code: null, stdout: "" };
  } finally {
    clearTimeout(timer);
  }
}
