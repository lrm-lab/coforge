import { rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

export const DEFAULT_PI_SESSION_ROTATION_MIN_BYTES = 30 * 1024 * 1024;
export const DEFAULT_PI_SESSION_ROTATE_BYTES = DEFAULT_PI_SESSION_ROTATION_MIN_BYTES;
const PI_SESSION_ROTATE_ENV = "COFORGE_PI_SESSION_ROTATE_BYTES";
const PI_SESSION_ROTATION_ENABLED_ENV = "COFORGE_PI_SESSION_ROTATION_ENABLED";

const KNOWN_SESSION_ENTRY_TYPES = new Set([
  "session",
  "message",
  "model_change",
  "thinking_level_change",
  "compaction",
  "branch_summary",
  "custom",
  "custom_message",
  "label",
  "session_info",
]);

export function isPiSessionRotationEnabled(
  environment?: Readonly<Record<string, string | undefined>>,
  processEnv: Readonly<Record<string, string | undefined>> = Bun.env,
): boolean {
  const raw = (
    environment?.[PI_SESSION_ROTATION_ENABLED_ENV] ?? processEnv[PI_SESSION_ROTATION_ENABLED_ENV]
  )
    ?.trim()
    .toLowerCase();
  return raw === "1" || raw === "true";
}

export type PiSessionRotationResult = Readonly<{
  rotated: boolean;
  beforeBytes: number;
  afterBytes: number;
}>;

export function resolvePiSessionRotateBytes(
  environment?: Readonly<Record<string, string | undefined>>,
  processEnv: Readonly<Record<string, string | undefined>> = Bun.env,
): number {
  const raw =
    environment?.[PI_SESSION_ROTATE_ENV]?.trim() || processEnv[PI_SESSION_ROTATE_ENV]?.trim();
  if (!raw) return DEFAULT_PI_SESSION_ROTATE_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PI_SESSION_ROTATE_BYTES;
}

function isSystemMessageEntry(entry: SessionEntry): boolean {
  return (
    entry.type === "message" &&
    typeof entry.message === "object" &&
    entry.message !== null &&
    "role" in entry.message &&
    entry.message.role === "system"
  );
}

function activeEntriesForRotation(path: readonly SessionEntry[]): SessionEntry[] | null {
  for (const entry of path) {
    if (!KNOWN_SESSION_ENTRY_TYPES.has(entry.type)) return null;
  }

  let compactionIdx = -1;
  for (let i = 0; i < path.length; i++) {
    if (path[i]!.type === "compaction") compactionIdx = i;
  }
  if (compactionIdx < 0) return null;

  const compaction = path[compactionIdx] as Extract<SessionEntry, { type: "compaction" }>;
  if (!compaction.firstKeptEntryId) return null;
  let firstKeptIdx = -1;
  for (let i = 0; i < compactionIdx; i++) {
    if (path[i]!.id === compaction.firstKeptEntryId) {
      firstKeptIdx = i;
      break;
    }
  }
  if (firstKeptIdx < 0) return null;
  const cutStart = firstKeptIdx;

  // Preserve the latest model_change, thinking_level_change, and session_info before cutStart so
  // SessionManager reconstructs identical session settings after reload.
  let latestModelChange: SessionEntry | undefined;
  let latestThinkingChange: SessionEntry | undefined;
  let latestSessionInfo: SessionEntry | undefined;
  for (let i = 0; i < cutStart; i++) {
    const entry = path[i]!;
    if (entry.type === "model_change") latestModelChange = entry;
    else if (entry.type === "thinking_level_change") latestThinkingChange = entry;
    else if (entry.type === "session_info") latestSessionInfo = entry;
  }

  const retained: SessionEntry[] = [];
  for (const setting of [latestModelChange, latestThinkingChange, latestSessionInfo]) {
    if (setting) retained.push({ ...setting });
  }
  for (let i = cutStart; i < path.length; i++) {
    const entry = path[i]!;
    if (compactionIdx >= 0 && i < compactionIdx && isSystemMessageEntry(entry)) continue;
    retained.push({ ...entry });
  }

  // Re-link parentId along the retained active path so buildSessionPath(entries, leafId) walks
  // cleanly from leaf to root without orphaned references to pruned pre-compaction entries.
  const keptIds = new Set(retained.map((entry) => entry.id));
  for (let i = 0; i < retained.length; i++) {
    const current = retained[i]!;
    current.parentId = i === 0 ? null : retained[i - 1]!.id;
    if (
      current.type === "compaction" &&
      current.firstKeptEntryId &&
      !keptIds.has(current.firstKeptEntryId)
    ) {
      current.firstKeptEntryId = "";
    }
  }
  return retained;
}

/**
 * Atomically compacts/rotates an oversized Pi/CoForge JSONL session transcript in place at a safe
 * session boundary (resume, post-compaction idle, or idle dispose), preserving `header.id`,
 * `header.cwd`, active post-compaction entries, and model/thinking settings while avoiding
 * multi-file session-ID ambiguity in `sessionDir`.
 */
export async function rotatePiSessionTranscriptIfOversized(
  sessionManager: SessionManager,
  options: { maxBytes?: number; enabled?: boolean } = {},
): Promise<PiSessionRotationResult> {
  if (options.enabled === false) {
    return { rotated: false, beforeBytes: 0, afterBytes: 0 };
  }
  const maxBytes = options.maxBytes ?? DEFAULT_PI_SESSION_ROTATION_MIN_BYTES;
  const sessionFile = sessionManager.getSessionFile();
  const header = sessionManager.getHeader();
  if (!sessionFile || !header) {
    return { rotated: false, beforeBytes: 0, afterBytes: 0 };
  }
  const info = await stat(sessionFile).catch(() => null);
  if (!info || !info.isFile()) {
    return { rotated: false, beforeBytes: 0, afterBytes: 0 };
  }
  const beforeBytes = info.size;
  if (beforeBytes <= maxBytes) {
    return { rotated: false, beforeBytes, afterBytes: beforeBytes };
  }

  const branch = sessionManager.getBranch();
  if (branch.length === 0) {
    return { rotated: false, beforeBytes, afterBytes: beforeBytes };
  }

  const retained = activeEntriesForRotation(branch);
  if (!retained) {
    return { rotated: false, beforeBytes, afterBytes: beforeBytes };
  }
  const serialized = `${[header, ...retained].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const afterBytes = Buffer.byteLength(serialized, "utf8");
  if (afterBytes >= beforeBytes) {
    return { rotated: false, beforeBytes, afterBytes: beforeBytes };
  }

  const tempPath = join(sessionManager.getSessionDir(), `.rotate-${crypto.randomUUID()}.tmp`);
  const rotatedPath = `${sessionFile}.rotated`;
  try {
    await writeFile(tempPath, serialized, "utf8");
    await rename(sessionFile, rotatedPath);
    try {
      await rename(tempPath, sessionFile);
    } catch (error) {
      await rename(rotatedPath, sessionFile).catch(() => {});
      throw error;
    }
    sessionManager.setSessionFile(sessionFile);
    return { rotated: true, beforeBytes, afterBytes };
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function rotatePiSessionFileIfOversized(
  filePath: string,
  options: { workspaceDir: string; sessionDir: string; maxBytes?: number },
): Promise<PiSessionRotationResult> {
  const { SessionManager: SdkSessionManager } = await import("@earendil-works/pi-coding-agent");
  const manager = SdkSessionManager.open(filePath, options.sessionDir, options.workspaceDir);
  return rotatePiSessionTranscriptIfOversized(manager, { maxBytes: options.maxBytes });
}
