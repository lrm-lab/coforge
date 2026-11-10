import { homedir } from "node:os";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";
import type { AgentRuntimeConfig } from "@coforge/agent";
import {
  isSharedKey,
  type CredentialInvalidLedger,
  type CredentialKey,
  type LedgerChange,
} from "./credential-invalid-ledger";
import { credentialPartsOf, type CredentialEnv, type CredentialPart } from "./provider-credentials";
import { scheduleUnrefInterval } from "./unref-timer";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** How often the credentials of the keys known invalid are looked at. */
export const CREDENTIAL_DISK_CHECK_INTERVAL_MS = 30_000;
/** A credential read is capped: the digest of the first bytes tells a changed login apart. */
const READ_CAP_BYTES = 64 * 1024;
const SECURITY_ITEM_NOT_FOUND = 44;
/** The Keychain flags that print a secret; this module reads attributes only. */
const FORBIDDEN_SECURITY_FLAGS = new Set(["-w", "-g"]);

type State =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unreadable" }>
  | Readonly<{ kind: "present"; digest: string }>;

/** What the file system shows of one file: a key that changes with it, and its first bytes. */
export type CredentialFs = Readonly<{
  stat(path: string): Promise<Readonly<{ key: string; read(): Promise<Uint8Array> }> | undefined>;
}>;

const BUN_FS: CredentialFs = {
  async stat(path) {
    const file = Bun.file(path);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return undefined;
      return {
        key: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`,
        read: async () => new Uint8Array(await file.slice(0, READ_CAP_BYTES).arrayBuffer()),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
};

type SecurityResult = Readonly<{ code: number | null; stdout: string }>;

/** Runs `security` and reads its output only up to the cap: a process that prints more is stopped. */
async function runSecurity(args: readonly string[]): Promise<SecurityResult> {
  if (args.some((arg) => FORBIDDEN_SECURITY_FLAGS.has(arg)))
    throw new Error("refusing to read a Keychain secret");
  const child = Bun.spawn(["/usr/bin/security", ...args], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
    timeout: 5_000,
  });
  const decoder = new TextDecoder();
  let stdout = "";
  let bytes = 0;
  let capped = false;
  for await (const chunk of child.stdout) {
    bytes += chunk.length;
    stdout += decoder.decode(chunk, { stream: true });
    if (bytes >= READ_CAP_BYTES) {
      capped = true;
      child.kill();
      break;
    }
  }
  const code = await child.exited;
  return { code: capped || typeof code !== "number" ? null : code, stdout };
}

const digestOf = (content: string | Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(content).digest("hex");

const partId = (part: CredentialPart): string =>
  part.kind === "file" ? `file:${part.path}` : `keychain:${part.service}`;

type Watched = {
  key: CredentialKey;
  parts: readonly CredentialPart[];
  /** What each part showed when the record was made, or last showed; null before the first look. */
  baselines: Map<string, State | null>;
};

export type CredentialDiskWatchDeps = Readonly<{
  ledger: CredentialInvalidLedger;
  /** The credentials under `key` changed on disk. */
  release(key: CredentialKey): void;
  baseEnv(): CredentialEnv;
  homeDir?: string;
  platform?: string;
  cwd?: string;
  fs?: CredentialFs;
  runSecurity?: (args: readonly string[]) => Promise<SecurityResult>;
  intervalMs?: number;
}>;

/**
 * Notices a login made outside the Daemon (the reference Computer's `CredentialDiskWatch`). While
 * a key is known invalid its credentials are looked at every 30 seconds: the first reading is the
 * baseline, and a credential that is present and differs from it, or from the last reading, ends
 * the key's records. Signing out (a credential gone) and an unreadable one release nothing. Only
 * attributes of a Keychain item are read, never its secret, and only when the Keychain file itself
 * changed; a file is read only when its stat changed. A credential is looked at once at a time,
 * whatever number of keys share it.
 */
export class CredentialDiskWatch {
  readonly #watched = new Map<CredentialKey, Watched>();
  readonly #fs: CredentialFs;
  readonly #looking = new Map<string, Promise<State>>();
  /** The last reading of each credential and the stat key it was read under. */
  readonly #last = new Map<string, { statKey?: string; state: State }>();
  #cancelTimer: (() => void) | undefined;
  #checking: Promise<void> | undefined;
  readonly #unsubscribe: () => void;

  constructor(private readonly deps: CredentialDiskWatchDeps) {
    this.#fs = deps.fs ?? BUN_FS;
    this.#unsubscribe = deps.ledger.subscribe((change) => this.#onChange(change));
  }

  get watching(): number {
    return this.#watched.size;
  }

  check(): Promise<void> {
    this.#checking ??= this.#checkAll().finally(() => {
      this.#checking = undefined;
    });
    return this.#checking;
  }

  stop(): void {
    this.#unsubscribe();
    this.#watched.clear();
    this.#syncTimer();
  }

  #onChange(change: LedgerChange): void {
    if (change.kind === "recorded") {
      if (!this.#watched.has(change.key)) this.#watch(change.key, change.config);
    } else if (!this.deps.ledger.hasInvalid(change.key) && this.#watched.delete(change.key))
      this.#syncTimer();
  }

  #watch(key: CredentialKey, config: AgentRuntimeConfig | undefined): void {
    // An Agent on a provider of its own does not use the Computer's login for its runtime.
    if (!isSharedKey(key) && config?.providerConfig) return;
    const provider = isSharedKey(key) ? key.slice("shared:".length) : config?.provider;
    const parts = provider
      ? credentialPartsOf(provider, {
          env: isSharedKey(key)
            ? this.deps.baseEnv()
            : { ...this.deps.baseEnv(), ...(config?.envVars ?? {}) },
          homeDir: this.#homeDir(),
          platform: this.#platform(),
          cwd: this.deps.cwd ?? process.cwd(),
        })
      : undefined;
    if (!parts) return;
    const watched: Watched = {
      key,
      parts,
      baselines: new Map(parts.map((part) => [partId(part), null])),
    };
    this.#watched.set(key, watched);
    for (const part of parts)
      void this.#read(part).then((state) => {
        if (this.#watched.get(key) === watched && watched.baselines.get(partId(part)) === null)
          watched.baselines.set(partId(part), state);
      });
    this.#syncTimer();
  }

  #homeDir = (): string => this.deps.homeDir ?? homedir();
  #platform = (): string => this.deps.platform ?? process.platform;

  /** One look at a credential at a time, whoever asks: keys that share it share the look. */
  #read(part: CredentialPart): Promise<State> {
    const id = partId(part);
    const looking = this.#looking.get(id);
    if (looking) return looking;
    const look = this.#look(part).finally(() => this.#looking.delete(id));
    this.#looking.set(id, look);
    return look;
  }

  async #look(part: CredentialPart): Promise<State> {
    const id = partId(part);
    try {
      // What the stat shows is what decides whether the credential is looked at again.
      const gate =
        part.kind === "file"
          ? await this.#fs.stat(part.path)
          : this.#platform() === "darwin"
            ? await this.#fs.stat(
                join(this.#homeDir(), "Library", "Keychains", "login.keychain-db"),
              )
            : undefined;
      const last = this.#last.get(id);
      if (last && last.statKey === gate?.key && (gate || part.kind === "file")) return last.state;
      const state =
        part.kind === "file"
          ? gate
            ? { kind: "present" as const, digest: digestOf(await gate.read()) }
            : { kind: "absent" as const }
          : await this.#readKeychain(part.service);
      this.#last.set(id, { ...(gate ? { statKey: gate.key } : {}), state });
      return state;
    } catch {
      return { kind: "unreadable" };
    }
  }

  async #readKeychain(service: string): Promise<State> {
    const result = await (this.deps.runSecurity ?? runSecurity)([
      "find-generic-password",
      "-s",
      service,
    ]);
    if (result.code === SECURITY_ITEM_NOT_FOUND) return { kind: "absent" };
    const modified = /"mdat"<timedate>=(\S+)/u.exec(result.stdout)?.[1];
    return result.code === 0 && modified
      ? { kind: "present", digest: digestOf(modified) }
      : { kind: "unreadable" };
  }

  async #checkAll(): Promise<void> {
    await Promise.all([...this.#watched.values()].map((watched) => this.#checkKey(watched)));
  }

  async #checkKey(watched: Watched): Promise<void> {
    const states = await Promise.all(watched.parts.map((part) => this.#read(part)));
    if (this.#watched.get(watched.key) !== watched) return;
    let changed = false;
    watched.parts.forEach((part, index) => {
      const id = partId(part);
      const now = states[index]!;
      const before = watched.baselines.get(id) ?? null;
      if (before === null || before.kind === "unreadable") watched.baselines.set(id, now);
      else if (now.kind === "present") {
        if (before.kind !== "present" || before.digest !== now.digest) changed = true;
        watched.baselines.set(id, now);
      } else watched.baselines.set(id, now);
    });
    if (changed) this.#release(watched);
  }

  #release(watched: Watched): void {
    this.#watched.delete(watched.key);
    this.#syncTimer();
    logger.info("Provider credentials changed on disk", {
      event: "agent.runtime.credential_disk_change",
      credential_key_kind: isSharedKey(watched.key) ? "shared" : "agent",
      source_kinds: [...new Set(watched.parts.map((part) => part.kind))].join(","),
    });
    this.deps.release(watched.key);
  }

  #syncTimer(): void {
    if (this.#watched.size > 0) {
      this.#cancelTimer ??= scheduleUnrefInterval(
        () => void this.check(),
        this.deps.intervalMs ?? CREDENTIAL_DISK_CHECK_INTERVAL_MS,
      );
    } else {
      this.#cancelTimer?.();
      this.#cancelTimer = undefined;
      this.#last.clear();
    }
  }
}
