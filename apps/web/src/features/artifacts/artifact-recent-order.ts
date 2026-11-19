const STORAGE_PREFIX = "coforge:recent-artifacts:";
const MAX_STORED_IDS = 20;

function defaultStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function readRecentArtifactIds(
  conversationId: string,
  storage: Storage | null = defaultStorage(),
): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(`${STORAGE_PREFIX}${conversationId}`);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
  } catch {
    return [];
  }
}

export function recordRecentArtifactOpen(
  conversationId: string,
  artifactId: string,
  storage: Storage | null = defaultStorage(),
): string[] {
  const next = [
    artifactId,
    ...readRecentArtifactIds(conversationId, storage).filter((id) => id !== artifactId),
  ].slice(0, MAX_STORED_IDS);
  if (storage) {
    try {
      storage.setItem(`${STORAGE_PREFIX}${conversationId}`, JSON.stringify(next));
    } catch {
      return next;
    }
  }
  return next;
}

export function orderRecentArtifacts<T extends { id: string; updatedAt: string | Date }>(
  items: readonly T[],
  recentIds: readonly string[],
  limit = 8,
): T[] {
  if (items.length === 0 || limit <= 0) return [];
  const byId = new Map(items.map((item) => [item.id, item]));
  const picked: T[] = [];
  const seen = new Set<string>();
  for (const id of recentIds) {
    const match = byId.get(id);
    if (match && !seen.has(id)) {
      seen.add(id);
      picked.push(match);
      if (picked.length >= limit) return picked;
    }
  }
  const rest = items
    .filter((item) => !seen.has(item.id))
    .sort(
      (left, right) => Date.parse(String(right.updatedAt)) - Date.parse(String(left.updatedAt)),
    );
  for (const item of rest) {
    picked.push(item);
    if (picked.length >= limit) break;
  }
  return picked;
}
