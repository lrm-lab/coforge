import { join } from "node:path";
import { z } from "zod";
import { isSafePathScope } from "./path-scope";
import { writePrivateJsonRecord } from "./private-json-record";

const inboxEnvelopeSchema = z.object({
  version: z.literal(1),
  items: z.array(z.unknown()),
});

const oneShotsEnvelopeSchema = inboxEnvelopeSchema.extend({
  published: z.array(z.string()),
});

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
    return (await this.#read(this.#path, inboxEnvelopeSchema))?.items ?? null;
  }

  async readOneShots(): Promise<{ items: unknown[]; published: string[] } | null> {
    const state = await this.#read(this.#oneShotsPath, oneShotsEnvelopeSchema);
    return state ? { items: state.items, published: state.published } : null;
  }

  async #read<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
    if (!(await Bun.file(path).exists())) return null;
    try {
      const parsed = schema.safeParse(JSON.parse(await Bun.file(path).text()));
      if (parsed.success) return parsed.data;
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
