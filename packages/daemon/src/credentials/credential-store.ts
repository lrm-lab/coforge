import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** What the `.confirmed` marker stores for a key: its hash, never the key itself. */
const markerFor = (apiKey: string) => new Bun.CryptoHasher("sha256").update(apiKey).digest("hex");

/** Daemon-owned storage for the credential used by one cloud connection. */
export interface DaemonCredentialStore {
  save(workspaceId: string, computerId: string, apiKey: string): Promise<void>;
  load(workspaceId: string, computerId: string): Promise<string | null>;
  delete(workspaceId: string, computerId: string): Promise<void>;
}

/** The "already confirmed with the server" marker a key migration keeps beside the credential —
 * a separate concern from the credential itself: only the migration port asks for it. */
export interface DaemonCredentialConfirmations {
  /** Whether `apiKey` is the key the daemon already confirmed with the server; a different key
   * stored later reads false again. */
  isConfirmed(workspaceId: string, computerId: string, apiKey: string): Promise<boolean>;
  /** Records `apiKey` as confirmed; kept beside the key file, removed with it. */
  markConfirmed(workspaceId: string, computerId: string, apiKey: string): Promise<void>;
}

/** Stores the Daemon API key in its private local state directory. */
export class FileDaemonCredentialStore
  implements DaemonCredentialStore, DaemonCredentialConfirmations
{
  readonly #directory: string;

  constructor(directory = Bun.env.COFORGE_DAEMON_HOME ?? join(homedir(), ".coforge", "daemon")) {
    this.#directory = join(directory, "credentials");
  }

  async save(workspaceId: string, computerId: string, apiKey: string): Promise<void> {
    const path = this.#path(workspaceId, computerId);
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700);
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${apiKey}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  }

  async load(workspaceId: string, computerId: string): Promise<string | null> {
    try {
      const apiKey = (await readFile(this.#path(workspaceId, computerId), "utf8")).trim();
      return apiKey || null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(workspaceId: string, computerId: string): Promise<void> {
    await rm(this.#path(workspaceId, computerId), { force: true });
    await rm(this.#confirmedPath(workspaceId, computerId), { force: true });
  }

  async isConfirmed(workspaceId: string, computerId: string, apiKey: string): Promise<boolean> {
    try {
      const confirmed = (
        await readFile(this.#confirmedPath(workspaceId, computerId), "utf8")
      ).trim();
      return confirmed === markerFor(apiKey);
    } catch {
      // A marker that cannot be read at all means "not confirmed": one extra confirm is
      // harmless, a failed startup is not.
      return false;
    }
  }

  async markConfirmed(workspaceId: string, computerId: string, apiKey: string): Promise<void> {
    const path = this.#confirmedPath(workspaceId, computerId);
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${markerFor(apiKey)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  }

  #path(workspaceId: string, computerId: string): string {
    return join(
      this.#directory,
      `${encodeURIComponent(workspaceId)}-${encodeURIComponent(computerId)}.api-key`,
    );
  }

  /** The confirmation marker beside the key file — a separate file so the key file keeps its
   * raw-key format, which an older daemon still reads. It stores the key's hash, not a second
   * plaintext copy of the credential. */
  #confirmedPath(workspaceId: string, computerId: string): string {
    return `${this.#path(workspaceId, computerId)}.confirmed`;
  }
}

/** Process-local adapter until platform keychain adapters are implemented. */
export class InMemoryDaemonCredentialStore
  implements DaemonCredentialStore, DaemonCredentialConfirmations
{
  readonly #tokens = new Map<string, string>();
  readonly #confirmed = new Map<string, string>();

  async save(workspaceId: string, computerId: string, apiKey: string): Promise<void> {
    this.#tokens.set(`${workspaceId}:${computerId}`, apiKey);
  }
  async load(workspaceId: string, computerId: string): Promise<string | null> {
    return this.#tokens.get(`${workspaceId}:${computerId}`) ?? null;
  }
  async delete(workspaceId: string, computerId: string): Promise<void> {
    this.#tokens.delete(`${workspaceId}:${computerId}`);
    this.#confirmed.delete(`${workspaceId}:${computerId}`);
  }
  async isConfirmed(workspaceId: string, computerId: string, apiKey: string): Promise<boolean> {
    return this.#confirmed.get(`${workspaceId}:${computerId}`) === apiKey;
  }
  async markConfirmed(workspaceId: string, computerId: string, apiKey: string): Promise<void> {
    this.#confirmed.set(`${workspaceId}:${computerId}`, apiKey);
  }
}
