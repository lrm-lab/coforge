import { join } from "node:path";
import { isSafePathScope } from "./path-scope";
import { writePrivateJsonRecord } from "./private-json-record";

export class AgentAppInboxPersistence {
  readonly #path: string;
  readonly #oneShotsPath: string;

  constructor(stateDirectory: string, workspaceId: string, agentId: string) {
    if (!stateDirectory) throw new Error("App Inbox state directory is required");
    if (!isSafePathScope(workspaceId) || !isSafePathScope(agentId))
      throw new Error("invalid App Inbox Workspace or Agent path scope");
    const directory = join(stateDirectory, "app-inbox", workspaceId, agentId);
    this.#path = join(directory, "items.json");
    this.#oneShotsPath = join(directory, "one-shots.json");
  }

  async read(): Promise<unknown[] | null> {
    return (await this.#read(this.#path))?.items ?? null;
  }

  async readOneShots(): Promise<{ items: unknown[]; published: string[] } | null> {
    const state = await this.#read(this.#oneShotsPath);
    if (!state) return null;
    const published = state.published;
    if (!Array.isArray(published) || published.some((id) => typeof id !== "string"))
      throw new Error(`App Inbox persisted data is corrupt: ${this.#oneShotsPath}`);
    return { items: state.items, published };
  }

  async #read(path: string): Promise<{ items: unknown[]; published?: unknown } | null> {
    if (!(await Bun.file(path).exists())) return null;
    try {
      const value = JSON.parse(await Bun.file(path).text()) as {
        version?: unknown;
        items?: unknown;
        published?: unknown;
      } | null;
      if (value?.version === 1 && Array.isArray(value.items))
        return { items: value.items, published: value.published };
    } catch {}
    throw new Error(`App Inbox persisted data is corrupt: ${path}`);
  }

  async write(items: readonly unknown[]): Promise<void> {
    await writePrivateJsonRecord(this.#path, { version: 1, items });
  }

  async writeOneShots(items: readonly unknown[], published: readonly string[]): Promise<void> {
    await writePrivateJsonRecord(
      this.#oneShotsPath,
      { version: 1, items, published },
      { durable: true },
    );
  }
}
