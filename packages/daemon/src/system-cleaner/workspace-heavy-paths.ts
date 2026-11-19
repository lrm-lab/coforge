import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { APP_INBOX_PREVIEW_MAX_CHARS } from "#src/agent-app-inbox/registry";
import { AGENT_MIGRATION_MAX_BUNDLE_BYTES } from "#src/agent-migration/bundle-writer";
import {
  AGENT_MIGRATION_COMMIT_DIRECTORY,
  AGENT_MIGRATION_IGNORE_FILE,
  ALWAYS_MOVED,
  isSecretName,
  parseIgnoredPaths,
  regenerableCategory,
} from "#src/agent-migration/selection-rules";
import { RUNTIME_STORAGE } from "#src/agent-migration/workspace-selection";
import {
  formatBytes,
  workspaceWakeReason,
  type MemoryWakeReason,
  type PeriodWorkspaceRow,
  type PresentedMark,
} from "./system-cleaner-hints";

const STAT_CONCURRENCY = 16;
const MAX_IGNORE_FILE_BYTES = 256 * 1024;
const MAX_ENTRY_LABEL_CHARS = 48;

export const DISK_HINT_SUMMARY_MAX_CHARS = 320;
export const DEFAULT_HEAVY_WORKSPACE_THRESHOLD_BYTES = Math.floor(
  AGENT_MIGRATION_MAX_BUNDLE_BYTES * 0.5,
);
export const DEFAULT_HEAVY_ENTRY_MIN_BYTES = 50 * 1024 * 1024;
export const DEFAULT_SCAN_MAX_ENTRIES = 2_000;
export const DEFAULT_SCAN_MAX_DEPTH = 6;
export const DEFAULT_SCAN_TIME_BUDGET_MS = 2_000;
export const DEFAULT_TOP_HEAVY_PATHS = 3;

export const CLEANUP_TIP_TITLE =
  "When it's quiet, remove workspace files you know are unused; check with your owner or creator on anything uncertain";
export const CLEANUP_TIP_SUMMARY = `Only raise files added since your last question, and update ${AGENT_MIGRATION_IGNORE_FILE} as the workspace changes.`;

export type HeavyWorkspaceEntry = Readonly<{
  path: string;
  bytes: number;
  kind: "directory" | "file";
}>;

export type WorkspaceHeavyPathsMeasurement =
  | Readonly<{
      kind: "measured";
      totalCarriedBytes: number;
      topCarried: readonly HeavyWorkspaceEntry[];
      ignoredCount: number;
      incomplete: boolean;
    }>
  | Readonly<{ kind: "not_established"; reason: string }>;

export type WorkspaceHeavyPathsScanOptions = Readonly<{
  maxEntries?: number;
  maxDepth?: number;
  timeBudgetMs?: number;
  topN?: number;
  minEntryBytes?: number;
  nowMs?: () => number;
}>;

type IgnoreReadResult =
  | Readonly<{ kind: "ok"; ignored: ReadonlySet<string> }>
  | Readonly<{ kind: "unreadable" }>;

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

function classifyFsError(error: unknown): string {
  const code = errorCode(error);
  if (code === "ENOENT") return "missing";
  if (code === "EACCES" || code === "EPERM") return "permission_denied";
  return "read_failed";
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : fallback;
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

function nonNegativeNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

async function readIgnoredPaths(root: string): Promise<IgnoreReadResult> {
  const ignorePath = join(root, AGENT_MIGRATION_IGNORE_FILE);
  const flags =
    constants.O_RDONLY |
    constants.O_NONBLOCK |
    (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
  let handle;
  try {
    handle = await open(ignorePath, flags);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ELOOP") return { kind: "ok", ignored: new Set() };
    return { kind: "unreadable" };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { kind: "ok", ignored: new Set() };
    if (info.size > MAX_IGNORE_FILE_BYTES) return { kind: "unreadable" };
    const buffer = new Uint8Array(MAX_IGNORE_FILE_BYTES + 1);
    let totalRead = 0;
    while (totalRead < buffer.length) {
      const next = await handle.read(buffer, totalRead, buffer.length - totalRead, totalRead);
      if (next.bytesRead === 0) break;
      totalRead += next.bytesRead;
    }
    if (totalRead > MAX_IGNORE_FILE_BYTES) return { kind: "unreadable" };
    const text = Buffer.from(buffer.subarray(0, totalRead)).toString("utf8");
    return { kind: "ok", ignored: parseIgnoredPaths(text, root) };
  } catch {
    return { kind: "unreadable" };
  } finally {
    await handle.close();
  }
}

export async function scanWorkspaceHeavyPaths(
  workspaceDirectory: string,
  options?: WorkspaceHeavyPathsScanOptions,
): Promise<WorkspaceHeavyPathsMeasurement> {
  const resolvedInput = resolve(workspaceDirectory);
  let root: string;
  try {
    const inputInfo = await lstat(resolvedInput);
    if (inputInfo.isSymbolicLink() || !inputInfo.isDirectory())
      return { kind: "not_established", reason: "not_directory" };
    root = await realpath(resolvedInput);
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory()) return { kind: "not_established", reason: "not_directory" };
  } catch (error) {
    return { kind: "not_established", reason: classifyFsError(error) };
  }

  const ignoreRead = await readIgnoredPaths(root);
  if (ignoreRead.kind === "unreadable")
    return { kind: "not_established", reason: "ignore_file_unreadable" };
  const ignoredPaths = ignoreRead.ignored;

  const maxEntries = positiveInt(options?.maxEntries, DEFAULT_SCAN_MAX_ENTRIES);
  const maxDepth = positiveInt(options?.maxDepth, DEFAULT_SCAN_MAX_DEPTH);
  const timeBudgetMs = nonNegativeNumber(options?.timeBudgetMs, DEFAULT_SCAN_TIME_BUDGET_MS);
  const topN = nonNegativeInt(options?.topN, DEFAULT_TOP_HEAVY_PATHS);
  const minEntryBytes = nonNegativeNumber(options?.minEntryBytes, DEFAULT_HEAVY_ENTRY_MIN_BYTES);
  const nowMs = options?.nowMs ?? Date.now;
  const deadlineMs = nowMs() + timeBudgetMs;

  let visitedEntries = 0;
  let ignoredCount = 0;
  let totalCarriedBytes = 0;
  let incomplete = false;

  const timedOut = (): boolean => {
    if (nowMs() < deadlineMs) return false;
    incomplete = true;
    return true;
  };

  const statBatch = async (
    batch: readonly string[],
    onFile: (relPath: string, sizeBytes: number) => void,
  ): Promise<void> => {
    if (batch.length === 0 || timedOut()) return;
    const results = await Promise.all(
      batch.map((relPath) =>
        lstat(join(root, relPath)).then(
          (stats) => ({ kind: "ok" as const, size: stats.isFile() ? stats.size : null }),
          (error: unknown) => ({ kind: "err" as const, code: errorCode(error) }),
        ),
      ),
    );
    for (let index = 0; index < batch.length; index += 1) {
      const result = results[index];
      const relPath = batch[index];
      if (!result || relPath === undefined) continue;
      if (result.kind === "err") {
        if (result.code !== "ENOENT") incomplete = true;
        continue;
      }
      if (result.size !== null) onFile(relPath, result.size);
    }
  };

  const candidates: HeavyWorkspaceEntry[] = [];
  const rootDirs: string[] = [];
  let rootBatch: string[] = [];

  const recordRootFile = (relPath: string, sizeBytes: number): void => {
    totalCarriedBytes += sizeBytes;
    if (!ALWAYS_MOVED.has(relPath))
      candidates.push({ path: relPath, bytes: sizeBytes, kind: "file" });
  };

  let rootDirHandle;
  try {
    rootDirHandle = await opendir(root);
  } catch (error) {
    return { kind: "not_established", reason: classifyFsError(error) };
  }
  try {
    for await (const dirent of rootDirHandle) {
      if (visitedEntries >= maxEntries || timedOut()) {
        incomplete = true;
        break;
      }
      visitedEntries += 1;
      const name = dirent.name;
      if (name === AGENT_MIGRATION_COMMIT_DIRECTORY || RUNTIME_STORAGE.has(name)) continue;
      if (!ALWAYS_MOVED.has(name) && isSecretName(name)) continue;
      if (ignoredPaths.has(name)) {
        ignoredCount += 1;
        continue;
      }
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isFile()) {
        rootBatch.push(name);
        if (rootBatch.length >= STAT_CONCURRENCY) {
          await statBatch(rootBatch, recordRootFile);
          rootBatch = [];
        }
      } else if (dirent.isDirectory()) {
        if (regenerableCategory(name) === undefined) rootDirs.push(name);
      }
    }
  } catch (error) {
    return { kind: "not_established", reason: classifyFsError(error) };
  }
  if (rootBatch.length > 0) await statBatch(rootBatch, recordRootFile);

  const dirTotals = new Map<string, number>(rootDirs.map((dir) => [dir, 0]));
  const queue: { topDir: string; relDir: string; depth: number }[] = rootDirs.map((dir) => ({
    topDir: dir,
    relDir: dir,
    depth: 1,
  }));

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    if (visitedEntries >= maxEntries || timedOut()) {
      incomplete = true;
      break;
    }
    const next = queue[cursor];
    if (!next) break;
    const absDir = join(root, next.relDir);
    try {
      const info = await lstat(absDir);
      if (info.isSymbolicLink() || !info.isDirectory()) continue;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") incomplete = true;
      continue;
    }
    let dirHandle;
    try {
      dirHandle = await opendir(absDir);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") incomplete = true;
      continue;
    }
    let fileBatch: string[] = [];
    const recordDirFile = (_relPath: string, sizeBytes: number): void => {
      totalCarriedBytes += sizeBytes;
      dirTotals.set(next.topDir, (dirTotals.get(next.topDir) ?? 0) + sizeBytes);
    };
    try {
      for await (const dirent of dirHandle) {
        if (visitedEntries >= maxEntries || timedOut()) {
          incomplete = true;
          break;
        }
        visitedEntries += 1;
        const relPath = `${next.relDir}/${dirent.name}`;
        if (!ALWAYS_MOVED.has(relPath) && isSecretName(dirent.name)) continue;
        if (ignoredPaths.has(relPath)) {
          ignoredCount += 1;
          continue;
        }
        if (dirent.isSymbolicLink()) continue;
        if (dirent.isFile()) {
          fileBatch.push(relPath);
          if (fileBatch.length >= STAT_CONCURRENCY) {
            await statBatch(fileBatch, recordDirFile);
            fileBatch = [];
          }
        } else if (dirent.isDirectory()) {
          if (regenerableCategory(dirent.name) !== undefined) continue;
          if (next.depth >= maxDepth) {
            incomplete = true;
            continue;
          }
          queue.push({ topDir: next.topDir, relDir: relPath, depth: next.depth + 1 });
        }
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") incomplete = true;
    }
    if (fileBatch.length > 0) await statBatch(fileBatch, recordDirFile);
  }

  for (const [dirName, bytes] of dirTotals)
    candidates.push({ path: dirName, bytes, kind: "directory" });

  const topCarried = candidates
    .filter((entry) => entry.bytes >= minEntryBytes)
    .sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path))
    .slice(0, topN);

  return {
    kind: "measured",
    totalCarriedBytes,
    topCarried,
    ignoredCount,
    incomplete,
  };
}

function sanitizeSingleLine(value: string): string {
  let out = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    out += code <= 31 || code === 127 ? " " : character;
  }
  return out.replace(/\s+/g, " ").trim();
}

function truncateSingleLine(value: string, maxChars: number): string {
  const clean = sanitizeSingleLine(value);
  if (clean.length <= maxChars) return clean;
  if (maxChars <= 3) return clean.slice(0, maxChars);
  return `${clean.slice(0, maxChars - 3).trimEnd()}...`;
}

function formatEntryLabel(entry: HeavyWorkspaceEntry, maxNameChars: number): string | undefined {
  const safeName = sanitizeSingleLine(entry.path);
  if (!safeName) return undefined;
  const suffix = entry.kind === "directory" ? "/" : "";
  const clipped =
    safeName.length > maxNameChars
      ? `${safeName.slice(0, Math.max(1, maxNameChars - 3))}...`
      : safeName;
  return `${clipped}${suffix} (${formatBytes(entry.bytes)})`;
}

function fitTopPathsSentence(entries: readonly HeavyWorkspaceEntry[], maxChars: number): string {
  const formatted = entries
    .map((entry) => formatEntryLabel(entry, MAX_ENTRY_LABEL_CHARS))
    .filter((label): label is string => label !== undefined);
  for (let count = formatted.length; count >= 1; count -= 1) {
    const candidate = `Largest carried paths: ${formatted.slice(0, count).join(", ")}.`;
    if (candidate.length <= maxChars) return candidate;
  }
  const first = entries.find((entry) => sanitizeSingleLine(entry.path).length > 0);
  if (!first) return "";
  const overhead = `Largest carried paths: / (${formatBytes(first.bytes)}).`.length;
  const remainingNameChars = maxChars - overhead;
  if (remainingNameChars < 8) return "";
  const shortened = formatEntryLabel(first, remainingNameChars);
  if (!shortened) return "";
  const candidate = `Largest carried paths: ${shortened}.`;
  return candidate.length <= maxChars ? candidate : "";
}

export type DiskCleanupTipInput = Readonly<{
  availableBytes?: number;
  workspace?: Extract<WorkspaceHeavyPathsMeasurement, { kind: "measured" }>;
  workspaceThresholdBytes: number;
}>;

export function buildDiskCleanupTip(
  input: DiskCleanupTipInput,
): Readonly<{ title: string; summary: string }> {
  const { availableBytes, workspace, workspaceThresholdBytes } = input;
  const workspaceOverThreshold =
    workspace !== undefined && workspace.totalCarriedBytes > workspaceThresholdBytes;
  const topCarried = workspace?.topCarried ?? [];

  const title =
    availableBytes === undefined && workspaceOverThreshold
      ? truncateSingleLine(
          `Workspace carries ${workspace.incomplete ? "at least " : ""}${formatBytes(workspace.totalCarriedBytes)} (migration cap ${formatBytes(AGENT_MIGRATION_MAX_BUNDLE_BYTES)}); review ${AGENT_MIGRATION_IGNORE_FILE}`,
          APP_INBOX_PREVIEW_MAX_CHARS,
        )
      : CLEANUP_TIP_TITLE;

  const prefix =
    availableBytes !== undefined
      ? `Only ${formatBytes(availableBytes)} of disk space is left.`
      : workspaceOverThreshold && topCarried.length === 0
        ? `Carried files exceed ${formatBytes(workspaceThresholdBytes)}.`
        : "";

  const suffix =
    topCarried.length > 0
      ? `Remove unused files or add non-essential paths to ${AGENT_MIGRATION_IGNORE_FILE}.`
      : CLEANUP_TIP_SUMMARY;

  let pathsText = "";
  if (topCarried.length > 0) {
    const fixedChars = (prefix ? prefix.length + 1 : 0) + suffix.length + 1;
    const pathsBudget = DISK_HINT_SUMMARY_MAX_CHARS - fixedChars;
    if (pathsBudget > 0) pathsText = fitTopPathsSentence(topCarried, pathsBudget);
  }

  const parts = [prefix, pathsText, suffix].filter((part) => part.length > 0);
  const summary = truncateSingleLine(parts.join(" "), DISK_HINT_SUMMARY_MAX_CHARS);
  return { title, summary };
}

export function evaluateWorkspacePeriod(
  measurement: WorkspaceHeavyPathsMeasurement,
  thresholdBytes: number,
  lastTip: PresentedMark | undefined,
  nowMs: number,
): Readonly<{ row: PeriodWorkspaceRow; due?: MemoryWakeReason; clearDue: boolean }> {
  if (measurement.kind === "not_established") {
    return {
      row: { threshold_bytes: thresholdBytes, not_established: measurement.reason },
      clearDue: true,
    };
  }
  const base: PeriodWorkspaceRow = {
    ...(measurement.incomplete ? { incomplete: true } : {}),
    carried_bytes: measurement.totalCarriedBytes,
    threshold_bytes: thresholdBytes,
    top_paths: measurement.topCarried.map((entry) => entry.path),
  };
  if (measurement.totalCarriedBytes <= thresholdBytes) return { row: base, clearDue: true };
  const due = workspaceWakeReason(lastTip, nowMs, measurement.totalCarriedBytes);
  return { row: { ...base, due }, due, clearDue: false };
}

export function evaluateDiskTipAtIdle(
  input: Readonly<{
    availableBytes?: number;
    workspaceDue: boolean;
    weeklyTipAllowed: boolean;
    hasMintedFileHint: boolean;
    scanned: WorkspaceHeavyPathsMeasurement;
    thresholdBytes: number;
    lastWorkspaceTip: PresentedMark | undefined;
    nowMs: number;
  }>,
):
  | Readonly<{
      title: string;
      summary: string;
      recordWorkspaceBytes?: number;
    }>
  | undefined {
  const workspace = input.scanned.kind === "measured" ? input.scanned : undefined;
  const overThreshold =
    workspace !== undefined && workspace.totalCarriedBytes > input.thresholdBytes;
  const workspaceStillDue =
    input.workspaceDue &&
    overThreshold &&
    workspaceWakeReason(input.lastWorkspaceTip, input.nowMs, workspace.totalCarriedBytes) !==
      undefined;
  if (
    input.availableBytes === undefined &&
    !(input.hasMintedFileHint && input.weeklyTipAllowed) &&
    !workspaceStillDue
  )
    return undefined;
  const { title, summary } = buildDiskCleanupTip({
    availableBytes: input.availableBytes,
    workspace,
    workspaceThresholdBytes: input.thresholdBytes,
  });
  return {
    title,
    summary,
    ...(overThreshold ? { recordWorkspaceBytes: workspace.totalCarriedBytes } : {}),
  };
}
