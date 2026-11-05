import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * External supervision of the Computer's service (task #538). A Computer started by a
 * supervisor of the person's own (a systemd unit running `coforge-computer foreground`)
 * declares it with `COFORGE_COMPUTER_EXTERNAL_SUPERVISOR=1`; it is believed only when systemd
 * itself says this process is that unit's main process. The verified unit is recorded in
 * `supervisor.json` under the Computer's state directory, and every later start, install and
 * upgrade asks that unit instead of starting a second service beside it. Modeled on Raft's
 * `externalSupervisor.ts`.
 */
export const EXTERNAL_SUPERVISOR_ENV_VAR = "COFORGE_COMPUTER_EXTERNAL_SUPERVISOR";
const SYSTEMD_INVOCATION_ENV_VAR = "INVOCATION_ID";
const SUPERVISOR_RECORD_FILE = "supervisor.json";
const SYSTEMCTL_TIMEOUT_MS = 15_000;

/** `KillMode` values under which the unit's main process may be replaced without the unit's
 * other processes (an upgrade job among them) being killed with it. */
export const UPGRADE_SAFE_KILL_MODES = ["process", "mixed"] as const;

export type SupervisorScope = "user" | "system";
export type SupervisorRecord = {
  kind: "systemd";
  scope: SupervisorScope;
  unit: string;
  invocationId: string;
  pid: number;
  recordedAt: string;
};

export type SystemctlResult = { code: number | null; stdout: string; stderr: string };
export type SystemctlRunner = (scope: SupervisorScope, args: string[]) => Promise<SystemctlResult>;

export const runSystemctl: SystemctlRunner = async (scope, args) => {
  try {
    const child = Bun.spawn(["systemctl", ...(scope === "user" ? ["--user"] : []), ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: SYSTEMCTL_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  } catch (error) {
    return {
      code: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
};

export function externalSupervisorOptIn(env: Record<string, string | undefined> = process.env) {
  const value = env[EXTERNAL_SUPERVISOR_ENV_VAR]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/** The `.service` segment a cgroup listing places this process in; the user manager's own
 * `user@N.service` is the scope marker, never the unit. */
export function parseSystemdUnitFromCgroup(
  text: string,
): { unit: string; scope: SupervisorScope } | null {
  for (const line of text.split("\n")) {
    const parts = line.split(":");
    if (parts.length < 3) continue;
    const controllers = parts[1] ?? "";
    const path = parts.slice(2).join(":").trim();
    if (!path.startsWith("/")) continue;
    if (parts[0] !== "0" && !controllers.split(",").includes("name=systemd")) continue;
    const segments = path.split("/").filter(Boolean);
    const unit = [...segments].reverse().find((segment) => segment.endsWith(".service"));
    if (!unit || /^user@\d+\.service$/u.test(unit)) continue;
    const scope = segments.some((segment) => /^user@\d+\.service$/u.test(segment))
      ? "user"
      : "system";
    return { unit, scope };
  }
  return null;
}

async function showUnitProperty(
  runner: SystemctlRunner,
  scope: SupervisorScope,
  unit: string,
  property: string,
): Promise<string | null> {
  const result = await runner(scope, ["show", "-P", property, unit]);
  return result.code === 0 ? result.stdout.trim() : null;
}

/** The unit this process is the main process of, or null: not Linux, not started by systemd
 * (`INVOCATION_ID`), not in a service cgroup, or not the unit's `MainPID`. */
export async function detectSystemdSupervisor(
  deps: {
    platform?: NodeJS.Platform;
    env?: Record<string, string | undefined>;
    pid?: number;
    readCgroup?: () => Promise<string>;
    systemctl?: SystemctlRunner;
    now?: () => Date;
  } = {},
): Promise<SupervisorRecord | null> {
  if ((deps.platform ?? process.platform) !== "linux") return null;
  const invocationId = (deps.env ?? process.env)[SYSTEMD_INVOCATION_ENV_VAR]?.trim();
  if (!invocationId) return null;
  let cgroup: string;
  try {
    cgroup = await (deps.readCgroup ?? (() => readFile("/proc/self/cgroup", "utf8")))();
  } catch {
    return null;
  }
  const parsed = parseSystemdUnitFromCgroup(cgroup);
  if (!parsed) return null;
  const pid = deps.pid ?? process.pid;
  const mainPid = await showUnitProperty(
    deps.systemctl ?? runSystemctl,
    parsed.scope,
    parsed.unit,
    "MainPID",
  );
  if (mainPid === null || Number(mainPid) !== pid) return null;
  return {
    kind: "systemd",
    ...parsed,
    invocationId,
    pid,
    recordedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
}

const recordPath = (stateDirectory: string) => join(stateDirectory, SUPERVISOR_RECORD_FILE);

export async function writeSupervisorRecord(stateDirectory: string, record: SupervisorRecord) {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await writeFile(recordPath(stateDirectory), JSON.stringify(record), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function clearSupervisorRecord(stateDirectory: string) {
  await rm(recordPath(stateDirectory), { force: true });
}

export async function readSupervisorRecord(
  stateDirectory: string,
): Promise<SupervisorRecord | null> {
  try {
    const raw = JSON.parse(await readFile(recordPath(stateDirectory), "utf8"));
    if (raw?.kind !== "systemd" || (raw.scope !== "user" && raw.scope !== "system")) return null;
    if (typeof raw.unit !== "string" || !raw.unit.endsWith(".service")) return null;
    if (!/^[A-Za-z0-9:_.@\\-]+$/u.test(raw.unit)) return null;
    if (typeof raw.pid !== "number" || typeof raw.invocationId !== "string") return null;
    return {
      kind: "systemd",
      scope: raw.scope,
      unit: raw.unit,
      invocationId: raw.invocationId,
      pid: raw.pid,
      recordedAt: String(raw.recordedAt ?? ""),
    };
  } catch {
    return null;
  }
}

export type SupervisorView = {
  record: SupervisorRecord;
  /** systemd knows the recorded unit. */
  unitLoaded: boolean;
  enabledState: string | null;
  activeState: string | null;
  mainPid: number | null;
  killMode: string | null;
  /** `systemctl` answered at all; false means it could not be used, not that the unit is gone. */
  reachable: boolean;
};

/** What systemd says about the recorded unit, or null when no supervisor was ever recorded. */
export async function inspectSupervisor(
  stateDirectory: string,
  deps: { systemctl?: SystemctlRunner } = {},
): Promise<SupervisorView | null> {
  const record = await readSupervisorRecord(stateDirectory);
  if (!record) return null;
  const runner = deps.systemctl ?? runSystemctl;
  const load = await runner(record.scope, ["show", "-P", "LoadState", record.unit]);
  const gone = {
    record,
    unitLoaded: false,
    enabledState: null,
    activeState: null,
    mainPid: null,
    killMode: null,
  };
  if (load.code === null) return { ...gone, reachable: false };
  if (load.code !== 0 || load.stdout.trim() !== "loaded") return { ...gone, reachable: true };
  const [enabled, active, mainPid, killMode] = await Promise.all([
    runner(record.scope, ["is-enabled", record.unit]).then((r) => r.stdout.trim() || null),
    showUnitProperty(runner, record.scope, record.unit, "ActiveState"),
    showUnitProperty(runner, record.scope, record.unit, "MainPID"),
    showUnitProperty(runner, record.scope, record.unit, "KillMode"),
  ]);
  const pid = Number(mainPid);
  return {
    record,
    unitLoaded: true,
    enabledState: enabled,
    activeState: active,
    mainPid: Number.isInteger(pid) && pid > 0 ? pid : null,
    killMode,
    reachable: true,
  };
}

export function describeSupervisorUnreachable(record: SupervisorRecord, detail: string): string {
  const hint =
    record.scope === "user"
      ? " A `systemctl --user` call needs the user's session bus: run it from a session of that user with XDG_RUNTIME_DIR set (for example after `loginctl enable-linger`)."
      : "";
  return `The Computer service is managed by systemd unit ${record.unit} (${record.scope} scope) but systemctl could not be used: ${detail}.${hint} Not starting a second service beside the unit.`;
}
