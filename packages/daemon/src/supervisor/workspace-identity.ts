import { chmod, chown, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
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
  listEntries?: (directory: string) => Promise<string[]>;
  changeOwner?: (path: string, identity: WorkspaceIdentity) => Promise<void>;
  withLock?: <T>(key: string, run: () => Promise<T>) => Promise<T>;
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
  const lock = input.withLock ?? withProfileLock;
  return lock(profilePath, async () => {
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
    const own = input.ownDirectory ?? (await ownDirectory(input.listEntries, input.changeOwner));
    for (const directory of input.directories) await own(directory, identity);
    return identity;
  });
}

const profileLocks = new Map<string, Promise<unknown>>();

/** Two Workspaces can start at the same time and would otherwise read the same
 * profile, pick the same uid and hand it to both. The map serialises the ones in
 * this process; the lock file covers a second Coordinator on the same volume. */
export async function withProfileLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = profileLocks.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  profileLocks.set(
    key,
    next.catch(() => undefined),
  );
  try {
    return await next;
  } finally {
    if (profileLocks.get(key) === next) profileLocks.delete(key);
  }
}

async function writeProfileFile(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, contents, { mode: 0o644 });
  await rename(temporary, path);
}

async function ownDirectory(
  listEntries: ((directory: string) => Promise<string[]>) | undefined,
  changeOwner: ((path: string, identity: WorkspaceIdentity) => Promise<void>) | undefined,
): Promise<(path: string, identity: WorkspaceIdentity) => Promise<void>> {
  const list = listEntries ?? listTree;
  const own = changeOwner ?? changeOwnerOf;
  return async (path: string, identity: WorkspaceIdentity): Promise<void> => {
    for (const target of [path, join(path, "work"), join(path, "home"), join(path, "cache")]) {
      try {
        await mkdir(target, { recursive: true, mode: 0o700 });
        await chmod(target, 0o700);
        await own(target, identity);
      } catch {
        continue;
      }
    }
    for (const entry of await list(path)) {
      try {
        await own(entry, identity);
      } catch {
        continue;
      }
    }
  };
}

/** Files left by an earlier run are still root's: the socket, the instance record,
 * the logs. A directory owner alone would let the dropped child fail to write and
 * quietly fall back to the launcher identity. */
async function listTree(directory: string): Promise<string[]> {
  const found: string[] = [];
  const queue = [directory];
  while (queue.length > 0 && found.length < 5000) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      found.push(path);
      if (entry.isDirectory()) queue.push(path);
    }
  }
  return found;
}

async function changeOwnerOf(path: string, identity: WorkspaceIdentity): Promise<void> {
  await chown(path, identity.uid, identity.gid);
}

/** The child runs the same binary as the Coordinator, but from the traversable copy:
 * `/root/...` is unreachable for an agent uid, and the version directories under it are
 * `0700 root`, so the spawn dies with EACCES unless the path is opened up for traversal. */
export async function executableForIdentity(input: {
  executablePath: string;
  identity: WorkspaceIdentity;
  volumeRoot: string;
  inspect?: (path: string) => Promise<{ mode: number; directory: boolean }>;
  grantTraverse?: (path: string, mode: number) => Promise<void>;
}): Promise<string | undefined> {
  if (input.identity.uid <= 0) return undefined;
  const inspect = input.inspect ?? inspectPath;
  const grant = input.grantTraverse ?? grantTraverse;
  const candidate = aliasPath(input.executablePath, input.volumeRoot);
  const traversable = (mode: number): boolean => (mode & 0o001) !== 0;
  /** Traversal needs `o+x`, not `o+r`: the version directory stays unlistable for the agent. */
  const open = async (
    path: string,
    entry: { mode: number; directory: boolean },
  ): Promise<boolean> => {
    if (traversable(entry.mode)) return true;
    try {
      await grant(path, entry.directory ? entry.mode | 0o111 : entry.mode | 0o001);
      const after = await inspect(path);
      return traversable(after.mode);
    } catch {
      return false;
    }
  };
  try {
    const file = await inspect(candidate);
    if (file.directory) return undefined;
    if (!(await open(candidate, file))) return undefined;
    const levels = candidate.split("/").filter(Boolean);
    for (let depth = 1; depth < levels.length; depth += 1) {
      const parent = `/${levels.slice(0, depth).join("/")}`;
      const entry = await inspect(parent);
      if (!entry.directory || !(await open(parent, entry))) return undefined;
    }
  } catch {
    return undefined;
  }
  return candidate;
}

async function inspectPath(path: string): Promise<{ mode: number; directory: boolean }> {
  const info = await stat(path);
  return { mode: info.mode, directory: info.isDirectory() };
}

async function grantTraverse(path: string, mode: number): Promise<void> {
  await chmod(path, mode);
}
