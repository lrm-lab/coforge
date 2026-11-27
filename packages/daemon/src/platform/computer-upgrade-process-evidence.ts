import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RFC_UUID_PATTERN } from "@lrm/coforge-sdk/internal";
import { z } from "zod";
import {
  computerUpgradeProgressRoot,
  readUpgradeProgressFile,
  writeUpgradeProgressFile,
} from "./computer-upgrade-progress";
import { installerJournalPath } from "./installer-journal";
import { isExitedProcState, parseProcStat } from "./linux-process-table";
import { upgradeReceiptPath } from "./upgrade-receipt-file";

const identitySchema = z.object({ pid: z.int().positive(), startTicks: z.int().nonnegative() });
const evidenceSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: z.string().regex(RFC_UUID_PATTERN),
  recordedAt: z.int().nonnegative(),
  bootId: z.string().regex(RFC_UUID_PATTERN),
  wrapper: identitySchema,
  installer: identitySchema,
});
type Identity = z.infer<typeof identitySchema>;
type ReadProc = (path: string) => Promise<string>;

const fileName = "processes.json";
const readLinuxProc: ReadProc = (path) => readFile(path, "utf8");

async function linuxBootId(readProc: ReadProc): Promise<string | undefined> {
  const bootId = (await readProc("/proc/sys/kernel/random/boot_id").catch(() => "")).trim();
  return RFC_UUID_PATTERN.test(bootId) ? bootId : undefined;
}

async function processStat(readProc: ReadProc, pid: number) {
  const value = await readProc(`/proc/${pid}/stat`);
  return parseProcStat(value);
}

export async function recordComputerUpgradeProcesses(
  installRoot: string,
  requestId: string,
  wrapperPid: number,
  installerPid: number,
  options: { readProc?: ReadProc; now?: () => number } = {},
): Promise<void> {
  if (!RFC_UUID_PATTERN.test(requestId) || (!options.readProc && process.platform !== "linux"))
    return;
  const readProc = options.readProc ?? readLinuxProc;
  const [bootId, wrapper, installer] = await Promise.all([
    linuxBootId(readProc),
    processStat(readProc, wrapperPid).catch(() => undefined),
    processStat(readProc, installerPid).catch(() => undefined),
  ]);
  if (!bootId || !wrapper || !installer || installer.ppid !== wrapperPid) return;
  await writeUpgradeProgressFile(computerUpgradeProgressRoot(installRoot), fileName, {
    schemaVersion: 1,
    requestId: requestId.toLowerCase(),
    recordedAt: (options.now ?? Date.now)(),
    bootId,
    wrapper: { pid: wrapperPid, startTicks: wrapper.startTicks },
    installer: { pid: installerPid, startTicks: installer.startTicks },
  } satisfies z.infer<typeof evidenceSchema>);
}

async function isAbsent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function identityExited(readProc: ReadProc, identity: Identity): Promise<boolean> {
  try {
    const actual = await processStat(readProc, identity.pid);
    return (
      !!actual && (actual.startTicks !== identity.startTicks || isExitedProcState(actual.state))
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export async function computerUpgradeProcessesExited(
  installRoot: string,
  operation: { requestId: string; requestedAt: number },
  options: { readProc?: ReadProc } = {},
): Promise<boolean> {
  if (
    !RFC_UUID_PATTERN.test(operation.requestId) ||
    (!options.readProc && process.platform !== "linux")
  )
    return false;

  const readProc = options.readProc ?? readLinuxProc;
  const { requestId, requestedAt } = operation;
  const stored = await readUpgradeProgressFile(
    join(computerUpgradeProgressRoot(installRoot), fileName),
  );
  const evidence = evidenceSchema.safeParse(stored);
  if (
    !evidence.success ||
    evidence.data.requestId !== requestId.toLowerCase() ||
    evidence.data.recordedAt < requestedAt
  )
    return false;

  const bootId = await linuxBootId(readProc);
  if (!bootId) return false;
  if (bootId === evidence.data.bootId) {
    const exited = await Promise.all([
      identityExited(readProc, evidence.data.wrapper),
      identityExited(readProc, evidence.data.installer),
    ]);
    if (exited.includes(false)) return false;
  }
  return (
    (await isAbsent(installerJournalPath(installRoot))) &&
    (await isAbsent(upgradeReceiptPath(installRoot, requestId)))
  );
}
