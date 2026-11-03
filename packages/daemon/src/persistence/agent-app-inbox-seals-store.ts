import { join } from "node:path";
import { isSafePathScope } from "./path-scope";
import { writePrivateJsonRecord } from "./private-json-record";

/**
 * The sealed App Inbox source identities of one Agent, beside its App Inbox items. A seal is a
 * local lock the Agent placed on an inbox source: the daemon refuses to change that source's
 * lifecycle until the Agent removes it, and `inbox check` reports it. Only an explicit unseal
 * removes an entry; it never expires on its own, because its `until` is a condition the daemon
 * cannot evaluate.
 */
export class AgentAppInboxSealsPersistence {
  readonly #path: string;

  constructor(stateDirectory: string, workspaceId: string, agentId: string) {
    if (!stateDirectory) throw new Error("App Inbox state directory is required");
    if (!isSafePathScope(workspaceId) || !isSafePathScope(agentId))
      throw new Error("invalid App Inbox Workspace or Agent path scope");
    this.#path = join(stateDirectory, "app-inbox", workspaceId, agentId, "seals.json");
  }

  async read(): Promise<unknown[] | null> {
    if (!(await Bun.file(this.#path).exists())) return null;
    let envelope: unknown;
    try {
      envelope = JSON.parse(await Bun.file(this.#path).text());
    } catch {
      throw new Error(`App Inbox seals are corrupt: ${this.#path}`);
    }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
      throw new Error(`App Inbox seals are corrupt: ${this.#path}`);
    const value = envelope as Record<string, unknown>;
    if (value.version !== 1 || !Array.isArray(value.seals))
      throw new Error(`App Inbox seals are corrupt: ${this.#path}`);
    return value.seals;
  }

  async write(seals: readonly unknown[]): Promise<void> {
    await writePrivateJsonRecord(this.#path, { version: 1, seals });
  }
}
