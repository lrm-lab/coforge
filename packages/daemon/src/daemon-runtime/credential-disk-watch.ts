import { homedir } from "node:os";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";
import type { AgentRuntimeConfig } from "@coforge/agent";
import { withoutHostClaudeProviderEnv } from "@lrm/coforge-anvil/claude-code";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import {
  credentialKeyOf,
  isSharedKey,
  type CredentialInvalidLedger,
  type CredentialKey,
  type LedgerChange,
} from "./credential-invalid-ledger";
import {
  credentialAccountDigest,
  credentialPartsOf,
  restartsOnCredentialChange,
  type CredentialEnv,
  type CredentialPart,
} from "./provider-credentials";
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
  | Readonly<{ kind: "present"; digest: string; accountDigest?: string }>;

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

const partId = (provider: string, part: CredentialPart): string =>
  part.kind === "file" ? `file:${provider}:${part.path}` : `keychain:${part.service}`;

type Watched = {
  key: CredentialKey;
  provider: string;
  parts: readonly CredentialPart[];
  /** What each part showed when the record was made, or last showed; null before the first look. */
  baselines: Map<string, State | null>;
};

export type CredentialDiskWatchDeps = Readonly<{
  ledger: CredentialInvalidLedger;
  /** The credentials under `key` changed on disk. */
  release(key: CredentialKey): void;
  onLiveCredentialsChanged?(key: CredentialKey): void;
  onLiveCredentialsSignedOut?(key: CredentialKey): void;
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
  readonly #live = new Map<CredentialKey, Watched>();
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

  get liveWatching(): number {
    return this.#live.size;
  }

  syncLive(agents: Iterable<Readonly<{ agentId: string; config: AgentRuntimeConfig }>>): void {
    const wanted = new Map<CredentialKey, AgentRuntimeConfig>();
    for (const { agentId, config } of agents) {
      if (!restartsOnCredentialChange(config.provider)) continue;
      const key = credentialKeyOf(agentId, config);
      if (!wanted.has(key)) wanted.set(key, config);
    }
    let removed = false;
    for (const key of this.#live.keys()) {
      if (!wanted.has(key)) {
        this.#live.delete(key);
        removed = true;
      }
    }
    for (const [key, config] of wanted) {
      if (this.#live.has(key)) continue;
      const entry = this.#buildWatched(key, config);
      if (!entry) continue;
      this.#live.set(key, entry);
      this.#seedBaselines(this.#live, entry);
    }
    if (removed) this.#pruneLast();
    this.#syncTimer();
  }

  refreshLiveBaseline(key: CredentialKey): void {
    const existing = this.#live.get(key);
    if (!existing) return;
    const fresh: Watched = {
      key: existing.key,
      provider: existing.provider,
      parts: existing.parts,
      baselines: new Map(existing.parts.map((part) => [partId(existing.provider, part), null])),
    };
    for (const part of existing.parts) {
      const id = partId(existing.provider, part);
      this.#last.delete(id);
      this.#looking.delete(id);
    }
    this.#live.set(key, fresh);
    this.#seedBaselines(this.#live, fresh);
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
    this.#live.clear();
    this.#last.clear();
    this.#syncTimer();
  }

  #onChange(change: LedgerChange): void {
    if (change.kind === "recorded") {
      if (!this.#watched.has(change.key)) this.#watch(change.key, change.config);
    } else if (!this.deps.ledger.hasInvalid(change.key) && this.#watched.delete(change.key))
      this.#syncTimer();
  }

  #watch(key: CredentialKey, config: AgentRuntimeConfig | undefined): void {
    const watched = this.#buildWatched(key, config);
    if (!watched) return;
    this.#watched.set(key, watched);
    this.#seedBaselines(this.#watched, watched);
    this.#syncTimer();
  }

  #buildWatched(key: CredentialKey, config: AgentRuntimeConfig | undefined): Watched | undefined {
    if (!isSharedKey(key) && config?.providerConfig) return undefined;
    const provider = isSharedKey(key) ? key.slice("shared:".length) : config?.provider;
    if (!provider) return undefined;
    const baseEnv =
      provider === RUNTIME_PROVIDER.CLAUDE_CODE
        ? withoutHostClaudeProviderEnv(this.deps.baseEnv())
        : this.deps.baseEnv();
    const parts = credentialPartsOf(provider, {
      env: isSharedKey(key) ? baseEnv : { ...baseEnv, ...config?.envVars },
      homeDir: this.#homeDir(),
      platform: this.#platform(),
      cwd: this.deps.cwd ?? process.cwd(),
    });
    if (!parts) return undefined;
    return {
      key,
      provider,
      parts,
      baselines: new Map(parts.map((part) => [partId(provider, part), null])),
    };
  }

  #seedBaselines(store: Map<CredentialKey, Watched>, watched: Watched): void {
    for (const part of watched.parts)
      void this.#read(watched.provider, part).then((state) => {
        const id = partId(watched.provider, part);
        if (store.get(watched.key) === watched && watched.baselines.get(id) === null)
          watched.baselines.set(id, state);
      });
  }

  #homeDir = (): string => this.deps.homeDir ?? homedir();
  #platform = (): string => this.deps.platform ?? process.platform;

  /** One look at a credential at a time, whoever asks: keys that share it share the look. */
  #read(provider: string, part: CredentialPart): Promise<State> {
    const id = partId(provider, part);
    const looking = this.#looking.get(id);
    if (looking) return looking;
    const look = this.#look(provider, part).finally(() => {
      if (this.#looking.get(id) === look) this.#looking.delete(id);
    });
    this.#looking.set(id, look);
    return look;
  }

  async #look(provider: string, part: CredentialPart): Promise<State> {
    const id = partId(provider, part);
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
      let state: State;
      if (part.kind === "file") {
        if (gate) {
          const bytes = await gate.read();
          const accountDigest = credentialAccountDigest(provider, bytes);
          state = {
            kind: "present",
            digest: digestOf(bytes),
            ...(accountDigest !== undefined ? { accountDigest } : {}),
          };
        } else {
          state = { kind: "absent" };
        }
      } else {
        state = await this.#readKeychain(part.service);
      }
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
    const released = new Set<CredentialKey>();
    await Promise.all(
      [...this.#watched.values()].map(async (watched) => {
        if (await this.#checkKey(watched)) released.add(watched.key);
      }),
    );
    await Promise.all(
      [...this.#live.values()].map((watched) => this.#checkLiveKey(watched, released)),
    );
  }

  async #checkKey(watched: Watched): Promise<boolean> {
    const states = await Promise.all(
      watched.parts.map((part) => this.#read(watched.provider, part)),
    );
    if (this.#watched.get(watched.key) !== watched) return false;
    let changed = false;
    watched.parts.forEach((part, index) => {
      const id = partId(watched.provider, part);
      const now = states[index]!;
      const before = watched.baselines.get(id) ?? null;
      if (before === null || before.kind === "unreadable") watched.baselines.set(id, now);
      else if (now.kind === "present") {
        if (before.kind !== "present" || before.digest !== now.digest) changed = true;
        watched.baselines.set(id, now);
      } else watched.baselines.set(id, now);
    });
    if (!changed) return false;
    this.#release(watched);
    return true;
  }

  async #checkLiveKey(watched: Watched, released: ReadonlySet<CredentialKey>): Promise<void> {
    const states = await Promise.all(
      watched.parts.map((part) => this.#read(watched.provider, part)),
    );
    if (this.#live.get(watched.key) !== watched) return;
    let changed = false;
    let signedOut = false;
    watched.parts.forEach((part, index) => {
      const id = partId(watched.provider, part);
      const now = states[index]!;
      const before = watched.baselines.get(id) ?? null;
      if (now.kind === "unreadable") return;
      watched.baselines.set(id, now);
      if (before === null || before.kind === "unreadable") return;
      if (before.kind === "present" && now.kind === "absent") signedOut = true;
      else if (before.kind === "absent" && now.kind === "present") changed = true;
      else if (
        before.kind === "present" &&
        now.kind === "present" &&
        before.accountDigest !== now.accountDigest
      )
        changed = true;
    });
    if (released.has(watched.key)) return;
    if (changed) {
      logger.info("Live provider credentials changed on disk", {
        event: "agent.runtime.credential_live_disk_change",
        credential_key_kind: isSharedKey(watched.key) ? "shared" : "agent",
        source_kinds: [...new Set(watched.parts.map((part) => part.kind))].join(","),
      });
      this.deps.onLiveCredentialsChanged?.(watched.key);
    } else if (signedOut) {
      logger.info("Live provider credentials removed from disk", {
        event: "agent.runtime.credential_live_disk_sign_out",
        credential_key_kind: isSharedKey(watched.key) ? "shared" : "agent",
        source_kinds: [...new Set(watched.parts.map((part) => part.kind))].join(","),
      });
      this.deps.onLiveCredentialsSignedOut?.(watched.key);
    }
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

  #pruneLast(): void {
    const active = new Set<string>();
    for (const watched of this.#watched.values())
      for (const part of watched.parts) active.add(partId(watched.provider, part));
    for (const watched of this.#live.values())
      for (const part of watched.parts) active.add(partId(watched.provider, part));
    for (const id of this.#last.keys()) if (!active.has(id)) this.#last.delete(id);
  }

  #syncTimer(): void {
    if (this.#watched.size > 0 || this.#live.size > 0) {
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
