import { chmod, chown, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type WorkspaceIdentity = { uid: number; gid: number };

export const WORKSPACE_IDENTITY_FILE = "workspace-identities.json";

export const MIN_AGENT_UID = 20_000;

/** Where the container mounts the state volume, and the path the boot script and
 * `dockerServiceCreateArgs` use instead when an agent uid has to reach it. */
export const CONTAINER_STATE_MOUNT = "/root/.coforge";

const MAX_AGENT_UID = 65_000;

export function isUsableIdentity(value: unknown): value is WorkspaceIdentity {
  if (typeof value !== "object" || value === null) return false;
  const { uid, gid } = value as Partial<WorkspaceIdentity>;
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) return false;
  return (
    uid !== undefined &&
    gid !== undefined &&
    uid >= MIN_AGENT_UID &&
    uid <= MAX_AGENT_UID &&
    gid >= MIN_AGENT_UID &&
    gid <= MAX_AGENT_UID
  );
}

export async function resolveWorkspaceIdentity(
  stateRoot: string,
  workspaceId: string,
): Promise<WorkspaceIdentity | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(stateRoot, WORKSPACE_IDENTITY_FILE), "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const entry = (parsed as Record<string, unknown>)[workspaceId];
    return isUsableIdentity(entry) ? { uid: entry.uid, gid: entry.gid } : undefined;
  } catch {
    return undefined;
  }
}

export function workspaceDirectory(volumeRoot: string, workspaceId: string): string {
  return join(volumeRoot, "ws", workspaceId);
}

export function canDropPrivileges(
  getuid: () => number | undefined = () => process.getuid?.(),
): boolean {
  return getuid() === 0;
}

export type SpawnIdentity = { identity: WorkspaceIdentity; directory: string };

export function aliasPath(path: string, volumeRoot: string | undefined): string {
  if (!volumeRoot || volumeRoot === CONTAINER_STATE_MOUNT) return path;
  if (path === CONTAINER_STATE_MOUNT) return volumeRoot;
  return path.startsWith(`${CONTAINER_STATE_MOUNT}/`)
    ? `${volumeRoot}${path.slice(CONTAINER_STATE_MOUNT.length)}`
    : path;
}

export function profileRoot(stateRoot: string, volumeRoot: string | undefined): string {
  return volumeRoot ? join(volumeRoot, "ws") : stateRoot;
}

export async function resolveSpawnIdentity(input: {
  stateRoot: string;
  workspaceId: string;
  volumeRoot?: string;
  getuid?: () => number | undefined;
  statOwner?: (path: string) => Promise<number | undefined>;
}): Promise<SpawnIdentity | undefined> {
  if (!canDropPrivileges(input.getuid ?? (() => process.getuid?.()))) return undefined;
  const identity = await resolveWorkspaceIdentity(
    profileRoot(input.stateRoot, input.volumeRoot),
    input.workspaceId,
  );
  if (!identity || !input.volumeRoot) return undefined;
  const directory = workspaceDirectory(input.volumeRoot, input.workspaceId);
  const owner = await (input.statOwner ?? ownerOf)(directory);
  return owner === identity.uid ? { identity, directory } : undefined;
}

async function ownerOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).uid;
  } catch {
    return undefined;
  }
}

export type IdentityProvisioning = {
  stateRoot: string;
  workspaceId: string;
  volumeRoot: string;
  directories: string[];
  getuid?: () => number | undefined;
  allocateUid?: (taken: number[]) => number;
  writeProfile?: (path: string, contents: string) => Promise<void>;
  ownDirectory?: (path: string, identity: WorkspaceIdentity) => Promise<void>;
};

function nextAgentUid(taken: number[]): number {
  const used = new Set(taken);
  const start = used.size > 0 ? Math.max(...used) + 1 : MIN_AGENT_UID + 1;
  for (let candidate = start; candidate < MAX_AGENT_UID; candidate += 1)
    if (!used.has(candidate)) return candidate;
  throw new Error("workspace uid range exhausted");
}

async function readProfileFile(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * A Computer learns about Workspaces after it starts, and the state directories are
 * created on demand, so the boot script alone cannot cover every case: this decides
 * and records the identity at the moment the Workspace is about to be spawned.
 */
export async function ensureWorkspaceIdentity(
  input: IdentityProvisioning,
): Promise<WorkspaceIdentity | undefined> {
  if (!canDropPrivileges(input.getuid ?? (() => process.getuid?.()))) return undefined;
  const profilePath = join(profileRoot(input.stateRoot, input.volumeRoot), WORKSPACE_IDENTITY_FILE);
  const identity = await withProfileLock(profilePath, () => allocateIdentity(input, profilePath));
  const own = input.ownDirectory ?? ownDirectory;
  for (const directory of input.directories) await own(directory, identity);
  return identity;
}

async function allocateIdentity(
  input: IdentityProvisioning,
  profilePath: string,
): Promise<WorkspaceIdentity> {
  const profile = await readProfileFile(profilePath);
  const known = profile[input.workspaceId];
  const identity = isUsableIdentity(known)
    ? { uid: known.uid, gid: known.gid }
    : (() => {
        const taken = Object.values(profile)
          .filter(isUsableIdentity)
          .map((entry) => entry.uid);
        const uid = (input.allocateUid ?? nextAgentUid)(taken);
        return { uid, gid: uid };
      })();
  if (!isUsableIdentity(known)) {
    profile[input.workspaceId] = identity;
    const ordered = Object.fromEntries(
      Object.keys(profile)
        .sort()
        .map((key) => [key, profile[key]]),
    );
    await (input.writeProfile ?? writeProfileFile)(
      profilePath,
      `${JSON.stringify(ordered, null, 2)}\n`,
    );
  }
  return identity;
}

/** Allocation reads and rewrites one profile, so two Workspaces starting together
 * would otherwise pick the same uid and share access to each other's files. */
async function withProfileLock<T>(profilePath: string, run: () => Promise<T>): Promise<T> {
  const lockPath = `${profilePath}.lock`;
  let held = false;
  for (let attempt = 0; attempt < 400 && !held; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      held = true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  try {
    return await run();
  } finally {
    if (held) await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeProfileFile(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, contents, { mode: 0o644 });
  await rename(temporary, path);
}

async function ownDirectory(path: string, identity: WorkspaceIdentity): Promise<void> {
  for (const target of [path, join(path, "work"), join(path, "home"), join(path, "cache")]) {
    try {
      await mkdir(target, { recursive: true, mode: 0o700 });
      await chmod(target, 0o700);
    } catch {
      continue;
    }
    await chownTree(target, identity);
  }
}

/** Files left by an earlier root-owned run (an old socket, the instance record, logs)
 * keep this child from writing unless the whole tree moves with the directory. */
async function chownTree(path: string, identity: WorkspaceIdentity): Promise<void> {
  try {
    const child = Bun.spawn(["chown", "-R", `${identity.uid}:${identity.gid}`, path], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await child.exited) === 0) return;
  } catch {}
  try {
    await chown(path, identity.uid, identity.gid);
  } catch {}
}
