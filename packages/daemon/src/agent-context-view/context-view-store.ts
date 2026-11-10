import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { escapePathIdentity, isSafePathScope } from "#src/persistence/path-scope";
import { contextViewRuntime, type ContextViewRuntime } from "./context-view-providers";

export const AGENT_CONTEXT_VIEW_RETENTION_DAYS = 30;
export const AGENT_CONTEXT_VIEW_OFF_GRACE_MS = 24 * 60 * 60 * 1000;
export const AGENT_CONTEXT_INDEX_MAX_BYTES = 8 * 1024 * 1024;
export const AGENT_CONTEXT_VIEW_REQUEST_LOG_MAX_BYTES = 128 * 1024 * 1024;
export const AGENT_CONTEXT_VIEW_REQUEST_LOG_DIR_NAME = "pi-requests";
export const CONTEXT_VIEW_READ_FLAGS =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
export const CONTEXT_VIEW_APPEND_FLAGS =
  constants.O_WRONLY |
  constants.O_APPEND |
  constants.O_CREAT |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);

export type ContextViewIndexEntry = {
  messageId: string;
  sentAt: string;
  runtime: ContextViewRuntime;
  sessionId: string;
  transcript: string;
  offset: number;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function assertEntry(entry: ContextViewIndexEntry): void {
  if (!ID.test(entry.messageId) || !ID.test(entry.sessionId))
    throw new Error("Invalid context view identity");
  if (contextViewRuntime(entry.runtime) === undefined)
    throw new Error("Invalid context view runtime");
  if (
    !entry.transcript ||
    entry.transcript.startsWith("/") ||
    entry.transcript.includes("\0") ||
    entry.transcript.split("/").includes("..")
  )
    throw new Error("Invalid context view transcript path");
  if (!Number.isSafeInteger(entry.offset) || entry.offset < 0)
    throw new Error("Invalid context view offset");
  if (Number.isNaN(Date.parse(entry.sentAt))) throw new Error("Invalid context view timestamp");
}

function ownDirectory(path: string, root = path): void {
  const rootInfo = lstatSync(root, { throwIfNoEntry: false });
  if (!rootInfo) throw new Error("Context view state directory is missing");
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
    throw new Error("Context view state directory is unsafe");
  let current = root;
  const relative = path === root ? [] : path.slice(root.length).split("/").filter(Boolean);
  for (const segment of relative) {
    current = join(current, segment);
    const existing = lstatSync(current, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink()) throw new Error("Context view directory is a symlink");
    if (!existing) mkdirSync(current, { mode: 0o700 });
    if (!lstatSync(current).isDirectory()) throw new Error("Context view directory is not private");
  }
}

function ownRegularFile(path: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.nlink > 1) throw new Error("Context view file is not private");
}

export class ContextViewStore {
  readonly #stateDirectory: string;
  readonly #directory: string;
  readonly #indexPath: string;
  readonly #offSincePath: string;
  readonly #requestLogDirectory: string;
  readonly #now: () => number;

  constructor(
    stateDirectory: string,
    serverId: string,
    agentId: string,
    now: () => number = Date.now,
  ) {
    if (!stateDirectory || !isSafePathScope(serverId) || !isSafePathScope(agentId))
      throw new Error("Invalid context view store scope");
    this.#stateDirectory = stateDirectory;
    const stateInfo = lstatSync(stateDirectory, { throwIfNoEntry: false });
    if (stateInfo?.isSymbolicLink()) throw new Error("Context view state directory is a symlink");
    const serverDirectory = join(stateDirectory, "agent-context", escapePathIdentity(serverId));
    this.#directory = join(serverDirectory, escapePathIdentity(agentId));
    this.#indexPath = join(this.#directory, "index.jsonl");
    this.#offSincePath = join(this.#directory, "off-since");
    this.#requestLogDirectory = join(this.#directory, AGENT_CONTEXT_VIEW_REQUEST_LOG_DIR_NAME);
    this.#now = now;
    ownDirectory(join(stateDirectory, "agent-context"), stateDirectory);
    ownDirectory(serverDirectory, stateDirectory);
    ownDirectory(this.#directory, stateDirectory);
  }

  static exists(stateDirectory: string, serverId: string, agentId: string): boolean {
    if (!stateDirectory || !isSafePathScope(serverId) || !isSafePathScope(agentId)) return false;
    const directory = join(
      stateDirectory,
      "agent-context",
      escapePathIdentity(serverId),
      escapePathIdentity(agentId),
    );
    try {
      const info = lstatSync(directory);
      return info.isDirectory() && !info.isSymbolicLink();
    } catch {
      return false;
    }
  }

  static agentIds(stateDirectory: string, serverId: string): string[] {
    if (!stateDirectory || !isSafePathScope(serverId)) return [];
    const directory = join(stateDirectory, "agent-context", escapePathIdentity(serverId));
    try {
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) return [];
      return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  get indexPath(): string {
    return this.#indexPath;
  }

  get requestLogDirectory(): string {
    ownDirectory(this.#requestLogDirectory, this.#stateDirectory);
    return this.#requestLogDirectory;
  }

  record(entry: ContextViewIndexEntry): void {
    assertEntry(entry);
    const line = `${JSON.stringify(entry)}\n`;
    if (existsSync(this.#indexPath)) {
      ownRegularFile(this.#indexPath);
      if (lstatSync(this.#indexPath).size + Buffer.byteLength(line) > AGENT_CONTEXT_INDEX_MAX_BYTES)
        this.compact();
    }
    let fd: number | undefined;
    try {
      fd = openSync(this.#indexPath, CONTEXT_VIEW_APPEND_FLAGS, 0o600);
      const info = fstatSync(fd);
      if (
        !info.isFile() ||
        info.nlink > 1 ||
        info.size + Buffer.byteLength(line) > AGENT_CONTEXT_INDEX_MAX_BYTES
      )
        throw new Error("Context view index is full or unsafe");
      writeFileSync(fd, line, "utf8");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  find(messageId: string): ContextViewIndexEntry | undefined {
    if (!ID.test(messageId) || !existsSync(this.#indexPath)) return undefined;
    ownRegularFile(this.#indexPath);
    const fd = openSync(this.#indexPath, CONTEXT_VIEW_READ_FLAGS);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink > 1 || info.size > AGENT_CONTEXT_INDEX_MAX_BYTES)
        return undefined;
    } finally {
      closeSync(fd);
    }
    return this.#readFileSafely(this.#indexPath)
      .split("\n")
      .flatMap((line) => {
        if (!line) return [];
        try {
          const value = JSON.parse(line) as ContextViewIndexEntry;
          assertEntry(value);
          return value.messageId === messageId ? [value] : [];
        } catch {
          return [];
        }
      })[0];
  }

  oldestSentAt(): string | undefined {
    if (!existsSync(this.#indexPath)) return undefined;
    try {
      const entries = this.#readFileSafely(this.#indexPath)
        .split("\n")
        .flatMap((line) => {
          if (!line) return [];
          try {
            const value = JSON.parse(line) as ContextViewIndexEntry;
            assertEntry(value);
            return [value.sentAt];
          } catch {
            return [];
          }
        });
      return entries.sort((left, right) => Date.parse(left) - Date.parse(right))[0];
    } catch {
      return undefined;
    }
  }

  isOff(): boolean {
    if (!existsSync(this.#offSincePath)) return false;
    try {
      return !Number.isNaN(Date.parse(this.#readFileSafely(this.#offSincePath)));
    } catch {
      return true;
    }
  }

  compact(retentionDays = AGENT_CONTEXT_VIEW_RETENTION_DAYS): number {
    return this.compactWithStats(retentionDays).kept;
  }

  compactWithStats(retentionDays = AGENT_CONTEXT_VIEW_RETENTION_DAYS): {
    kept: number;
    dropped: number;
  } {
    if (!existsSync(this.#indexPath)) return { kept: 0, dropped: 0 };
    ownRegularFile(this.#indexPath);
    const cutoff = this.#now() - retentionDays * 24 * 60 * 60 * 1000;
    const parsed = this.#readFileSafely(this.#indexPath)
      .split("\n")
      .flatMap((line) => {
        if (!line) return [];
        try {
          const value = JSON.parse(line) as ContextViewIndexEntry;
          assertEntry(value);
          return [value];
        } catch {
          return [];
        }
      });
    const entries = parsed
      .filter((entry) => Date.parse(entry.sentAt) >= cutoff)
      .sort((left, right) => Date.parse(left.sentAt) - Date.parse(right.sentAt));
    let encodedBytes = entries.reduce(
      (total, entry) => total + Buffer.byteLength(JSON.stringify(entry)) + 1,
      0,
    );
    let dropCount = 0;
    while (encodedBytes > AGENT_CONTEXT_INDEX_MAX_BYTES && dropCount < entries.length) {
      encodedBytes -= Buffer.byteLength(JSON.stringify(entries[dropCount]!)) + 1;
      dropCount += 1;
    }
    const kept = entries.slice(dropCount);
    const encoded = () =>
      kept.map((entry) => JSON.stringify(entry)).join("\n") + (kept.length ? "\n" : "");
    const dropped = parsed.length - kept.length;
    if (kept.length === 0) {
      rmSync(this.#indexPath, { force: true });
      return { kept: 0, dropped };
    }
    const temp = `${this.#indexPath}.tmp-${process.pid}`;
    const tempFd = openSync(temp, CONTEXT_VIEW_APPEND_FLAGS | (constants.O_EXCL ?? 0), 0o600);
    try {
      writeFileSync(tempFd, encoded(), "utf8");
    } finally {
      closeSync(tempFd);
    }
    renameSync(temp, this.#indexPath);
    return { kept: kept.length, dropped };
  }

  markOff(now = this.#now()): void {
    if (existsSync(this.#offSincePath)) {
      const current = Date.parse(this.#readFileSafely(this.#offSincePath));
      if (!Number.isNaN(current)) return;
      unlinkSync(this.#offSincePath);
    }
    const fd = openSync(
      this.#offSincePath,
      CONTEXT_VIEW_APPEND_FLAGS | (constants.O_EXCL ?? 0),
      0o600,
    );
    try {
      writeFileSync(fd, new Date(now).toISOString(), "utf8");
    } finally {
      closeSync(fd);
    }
  }

  clearOff(): void {
    if (existsSync(this.#offSincePath)) unlinkSync(this.#offSincePath);
  }

  sweepOff(now = this.#now()): boolean {
    if (!existsSync(this.#offSincePath)) return false;
    const offSince = Date.parse(this.#readFileSafely(this.#offSincePath));
    if (Number.isNaN(offSince) || now - offSince < AGENT_CONTEXT_VIEW_OFF_GRACE_MS) return false;
    for (const name of readdirSync(this.#directory)) {
      if (name !== "off-since") {
        const path = join(this.#directory, name);
        const info = lstatSync(path, { throwIfNoEntry: false });
        if (!info) continue;
        if (info.isSymbolicLink()) {
          unlinkSync(path);
          continue;
        }
        if (info.isDirectory()) rmSync(path, { recursive: true, force: true });
        else unlinkSync(path);
      }
    }
    if (existsSync(this.#offSincePath)) unlinkSync(this.#offSincePath);
    rmSync(this.#directory, { recursive: true, force: true });
    return true;
  }

  static sweepRequestLog(path: string, cutoff: number): boolean {
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) return false;
      if (info.size > AGENT_CONTEXT_VIEW_REQUEST_LOG_MAX_BYTES || info.mtimeMs >= cutoff)
        return false;
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }

  static sweepRequestLogs(directory: string, cutoff: number): boolean {
    try {
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
      let removed = false;
      for (const name of readdirSync(directory)) {
        if (!/^[A-Za-z0-9._-]{1,200}\.jsonl$/.test(name)) continue;
        const path = join(directory, name);
        const file = lstatSync(path, { throwIfNoEntry: false });
        if (
          file?.isFile() &&
          !file.isSymbolicLink() &&
          file.nlink === 1 &&
          file.size <= AGENT_CONTEXT_VIEW_REQUEST_LOG_MAX_BYTES &&
          file.mtimeMs < cutoff
        ) {
          unlinkSync(path);
          removed = true;
        }
      }
      return removed;
    } catch {
      return false;
    }
  }

  sweepRequestLogs(cutoff: number): boolean {
    try {
      ownDirectory(this.#requestLogDirectory, this.#stateDirectory);
      return ContextViewStore.sweepRequestLogs(this.#requestLogDirectory, cutoff);
    } catch {
      return false;
    }
  }

  static removeRequestLog(path: string): boolean {
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) return false;
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }

  #readFileSafely(path: string): string {
    ownRegularFile(path);
    const fd = openSync(path, CONTEXT_VIEW_READ_FLAGS);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink > 1) throw new Error("Context view file is not private");
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  }
}
