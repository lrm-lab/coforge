const STORAGE_KEY_PREFIX = "coforge:pinned-artifact-dismissed:v1:";

export type PinnedArtifactDismissal = {
  artifactId: string;
  version: number;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readPinnedDismissal(
  conversationId: string,
  storage: StorageLike | null = defaultStorage(),
): PinnedArtifactDismissal | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(`${STORAGE_KEY_PREFIX}${conversationId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { artifactId?: unknown }).artifactId === "string" &&
      typeof (parsed as { version?: unknown }).version === "number" &&
      Number.isInteger((parsed as { version: number }).version)
    ) {
      return {
        artifactId: (parsed as { artifactId: string }).artifactId,
        version: (parsed as { version: number }).version,
      };
    }
  } catch {}
  return null;
}

export function writePinnedDismissal(
  conversationId: string,
  dismissal: PinnedArtifactDismissal | null,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  const key = `${STORAGE_KEY_PREFIX}${conversationId}`;
  try {
    if (dismissal === null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(dismissal));
  } catch {}
}

export function isPinnedArtifactDismissed(
  pinned: { artifactId: string; version: number } | null | undefined,
  dismissal: PinnedArtifactDismissal | null,
): boolean {
  if (!pinned || !dismissal) return false;
  return dismissal.artifactId === pinned.artifactId && dismissal.version >= pinned.version;
}
