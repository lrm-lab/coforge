import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentSessionIdentity } from "@coforge/agent";
import type { ConversationSessionStore } from "#src/agent-runtime/memory-conversation-sessions";

/** Atomic identities, separate from the native trajectory files and Agent workspace. */
export class FileConversationSessionStore implements ConversationSessionStore {
  #pending: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}

  async get(
    controlSessionId: string,
    conversationId: string,
  ): Promise<AgentSessionIdentity | undefined> {
    await this.#pending;
    return (await this.#read())[controlSessionId]?.[conversationId];
  }

  set(
    controlSessionId: string,
    conversationId: string,
    identity: AgentSessionIdentity,
  ): Promise<void> {
    const write = this.#pending.then(async () => {
      const records = await this.#read();
      records[controlSessionId] = { ...records[controlSessionId], [conversationId]: identity };
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(records), { mode: 0o600, flag: "wx" });
        await rename(temporary, this.path);
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    });
    this.#pending = write.catch(() => {});
    return write;
  }

  async #read(): Promise<Record<string, Record<string, AgentSessionIdentity>>> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid conversation session store");
    for (const records of Object.values(value)) {
      if (!records || typeof records !== "object" || Array.isArray(records))
        throw new Error("Invalid conversation session records");
      for (const identity of Object.values(records)) {
        if (
          !identity ||
          typeof identity !== "object" ||
          !("sessionId" in identity) ||
          typeof identity.sessionId !== "string" ||
          !("state" in identity) ||
          typeof identity.state !== "string" ||
          !["empty", "resumable", "unknown"].includes(identity.state)
        )
          throw new Error("Invalid conversation session identity");
      }
    }
    return value as Record<string, Record<string, AgentSessionIdentity>>;
  }
}
