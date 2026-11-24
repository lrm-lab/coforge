import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export type WorkspaceIdentity = { uid: number; gid: number };

export const WORKSPACE_IDENTITY_FILE = "workspace-identities.json";

export const MIN_AGENT_UID = 20_000;

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

export async function resolveSpawnIdentity(input: {
  stateRoot: string;
  workspaceId: string;
  volumeRoot?: string;
  getuid?: () => number | undefined;
  statOwner?: (path: string) => Promise<number | undefined>;
}): Promise<SpawnIdentity | undefined> {
  if (!canDropPrivileges(input.getuid ?? (() => process.getuid?.()))) return undefined;
  const identity = await resolveWorkspaceIdentity(input.stateRoot, input.workspaceId);
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
