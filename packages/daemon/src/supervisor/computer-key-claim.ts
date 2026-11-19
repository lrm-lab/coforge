import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getLogger } from "@logtape/logtape";
import { thrownMessage } from "@lrm/coforge-sdk/internal";
import { acquireProcessLock, isLockContention, type ProcessLock } from "#src/platform/process-lock";

export const COMPUTER_KEY_CLAIM_SCHEMA_VERSION = 1;

const CLAIM_META_MAX_BYTES = 8 * 1024;
const DEFAULT_SAME_DIRECTORY_RETRY_MS = 2_000;
const DEFAULT_RETRY_INTERVAL_MS = 100;

const logger = getLogger(["coforge", "daemon", "supervisor"]);

export type ComputerKeyClaimMetadata = Readonly<{
  schemaVersion: number;
  pid: number;
  version: string;
  stateDirectory: string;
  workspaceId: string;
  computerId: string;
  claimedAtMs: number;
}>;

export type ComputerKeyClaim = Readonly<{
  fingerprint: string;
  release(): void;
}>;

export type AcquireComputerKeyClaimOptions = Readonly<{
  apiKey: string;
  stateDirectory: string;
  workspaceId: string;
  computerId: string;
  version: string;
  claimDirectory?: string;
  pid?: number;
  sameDirectoryRetryMs?: number;
  retryIntervalMs?: number;
  signal?: AbortSignal;
}>;

export function computerKeyFingerprint(apiKey: string): string {
  return new Bun.CryptoHasher("sha256").update(apiKey.trim()).digest("hex").slice(0, 32);
}

export function defaultComputerKeyClaimDirectory(homeDir: string = homedir()): string {
  return join(homeDir, ".coforge", "key-claims");
}

function formatDuplicateMessage(
  fingerprint: string,
  holder: ComputerKeyClaimMetadata | null,
): string {
  const shortFp = fingerprint.slice(0, 12);
  if (holder) {
    return (
      `Another CoForge Daemon (pid ${holder.pid}, version ${holder.version}) in ` +
      `${holder.stateDirectory} is already running with this Computer's API key ` +
      `(fingerprint ${shortFp}). Stop the other installation first before starting this daemon ` +
      `so the two installations do not disconnect each other.`
    );
  }
  return (
    `Another CoForge Daemon is already running on this machine with this Computer's API key ` +
    `(fingerprint ${shortFp}). Stop the other installation first before starting this daemon.`
  );
}

export class DuplicateComputerKeyError extends Error {
  readonly code = "duplicate_computer_key";
  readonly fingerprint: string;
  readonly holder: ComputerKeyClaimMetadata | null;

  constructor(fingerprint: string, holder: ComputerKeyClaimMetadata | null, cause?: unknown) {
    super(formatDuplicateMessage(fingerprint, holder), cause ? { cause } : undefined);
    this.name = "DuplicateComputerKeyError";
    this.fingerprint = fingerprint;
    this.holder = holder;
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function isOwnedByCurrentUser(stat: { uid?: number }): boolean {
  if (typeof process.getuid !== "function" || typeof stat.uid !== "number") return true;
  return stat.uid === process.getuid();
}

function ensureRealClaimDirectory(claimDirectory: string): boolean {
  try {
    const existing = lstatSync(claimDirectory);
    if (!existing.isDirectory() || !isOwnedByCurrentUser(existing)) {
      logger.warn("Computer key claim directory is unsafe; continuing without key claim", {
        event: "daemon:key_claim_dir_unavailable",
      });
      return false;
    }
    return true;
  } catch (error) {
    if (!isErrnoCode(error, "ENOENT")) return false;
  }
  try {
    mkdirSync(claimDirectory, { recursive: true, mode: 0o700 });
    const created = lstatSync(claimDirectory);
    return created.isDirectory() && isOwnedByCurrentUser(created);
  } catch (error) {
    logger.warn("Unable to prepare Computer key claim directory; continuing without key claim", {
      event: "daemon:key_claim_dir_unavailable",
      error_message: thrownMessage(error),
    });
    return false;
  }
}

function isAbsentOrRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch (error) {
    return isErrnoCode(error, "ENOENT");
  }
}

function readClaimMetadata(metaPath: string): ComputerKeyClaimMetadata | null {
  try {
    const stat = lstatSync(metaPath);
    if (!stat.isFile() || stat.size > CLAIM_META_MAX_BYTES) return null;
    const raw = JSON.parse(readFileSync(metaPath, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (record.schemaVersion !== COMPUTER_KEY_CLAIM_SCHEMA_VERSION) return null;
    if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0)
      return null;
    if (typeof record.version !== "string" || typeof record.stateDirectory !== "string")
      return null;
    if (typeof record.workspaceId !== "string" || typeof record.computerId !== "string")
      return null;
    if (typeof record.claimedAtMs !== "number" || !Number.isFinite(record.claimedAtMs)) return null;
    return {
      schemaVersion: COMPUTER_KEY_CLAIM_SCHEMA_VERSION,
      pid: record.pid,
      version: record.version,
      stateDirectory: record.stateDirectory,
      workspaceId: record.workspaceId,
      computerId: record.computerId,
      claimedAtMs: record.claimedAtMs,
    };
  } catch {
    return null;
  }
}

function writeClaimMetadataAtomic(metaPath: string, metadata: ComputerKeyClaimMetadata): void {
  if (!isAbsentOrRegularFile(metaPath)) return;
  const tempPath = `${metaPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tempPath, metaPath);
  } catch {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      return;
    }
  }
}

function removeRegularFile(path: string): void {
  try {
    const existing = lstatSync(path);
    if (existing.isFile()) rmSync(path, { force: true });
  } catch {
    return;
  }
}

export async function acquireComputerKeyClaim(
  options: AcquireComputerKeyClaimOptions,
): Promise<ComputerKeyClaim | null> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) return null;
  const claimDirectory = options.claimDirectory ?? defaultComputerKeyClaimDirectory();
  if (!ensureRealClaimDirectory(claimDirectory)) return null;

  const fingerprint = computerKeyFingerprint(apiKey);
  const lockPath = join(claimDirectory, `${fingerprint}.lock.sqlite`);
  const metaPath = join(claimDirectory, `${fingerprint}.claim.json`);
  if (!isAbsentOrRegularFile(lockPath)) {
    logger.warn("Computer key claim lock path is not a regular file; skipping key claim", {
      event: "daemon:key_claim_lock_unsafe",
      key_fingerprint: fingerprint,
    });
    return null;
  }
  const normalizedStateDirectory = resolve(options.stateDirectory);
  const retryDeadline =
    Date.now() + (options.sameDirectoryRetryMs ?? DEFAULT_SAME_DIRECTORY_RETRY_MS);
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;

  for (;;) {
    let lock: ProcessLock;
    try {
      lock = acquireProcessLock(lockPath);
    } catch (error) {
      if (!isLockContention(error)) {
        logger.warn("Computer key claim lock unavailable; continuing without key claim", {
          event: "daemon:key_claim_lock_error",
          error_message: thrownMessage(error),
        });
        return null;
      }
      const holder = readClaimMetadata(metaPath);
      const sameDirectory =
        holder !== null && resolve(holder.stateDirectory) === normalizedStateDirectory;
      if ((sameDirectory || holder === null) && Date.now() < retryDeadline) {
        if (options.signal?.aborted) throw options.signal.reason;
        await Bun.sleep(retryIntervalMs);
        if (options.signal?.aborted) throw options.signal.reason;
        continue;
      }
      throw new DuplicateComputerKeyError(fingerprint, holder, error);
    }

    const metadata: ComputerKeyClaimMetadata = {
      schemaVersion: COMPUTER_KEY_CLAIM_SCHEMA_VERSION,
      pid: options.pid ?? process.pid,
      version: options.version,
      stateDirectory: options.stateDirectory,
      workspaceId: options.workspaceId,
      computerId: options.computerId,
      claimedAtMs: Date.now(),
    };
    writeClaimMetadataAtomic(metaPath, metadata);
    let released = false;
    return {
      fingerprint,
      release() {
        if (released) return;
        released = true;
        removeRegularFile(metaPath);
        lock.release();
      },
    };
  }
}
