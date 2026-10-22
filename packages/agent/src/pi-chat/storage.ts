import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { piChatSessionSchema, type PiChatSession } from "@lrm/coforge-sdk/internal/pi-chat";
import { PI_SESSION_DIR } from "#src/paths";
import { storedChatMessages } from "./runtime";
import type { PiChatStore } from "./sessions";
import { piChatCheckpointSchema, type PiChatCheckpoint } from "./checkpoint";

/** Metadata only; Pi's JSONL retains the complete native transcript, including compaction history. */
export class FilePiChatStore implements PiChatStore {
  readonly #metadata: string;
  constructor(private readonly cwd: string) {
    this.#metadata = join(cwd, ".chat-index");
  }
  #path(id: string) {
    return join(this.#metadata, `${piChatSessionSchema.shape.id.parse(id)}.json`);
  }
  async list() {
    await mkdir(this.#metadata, { recursive: true, mode: 0o700 });
    const files = await readdir(this.#metadata);
    return Promise.all(
      files
        .filter((file) => /^[\da-f-]{36}\.json$/i.test(file))
        .map(async (file) => {
          const row = piChatSessionSchema.parse(await Bun.file(join(this.#metadata, file)).json());
          if (`${row.id}.json` !== file) throw new Error("session index mismatch");
          return row;
        }),
    );
  }
  async save(session: PiChatSession) {
    const row = piChatSessionSchema.parse(session);
    await mkdir(this.#metadata, { recursive: true, mode: 0o700 });
    const path = this.#path(row.id);
    await this.#write(path, row);
  }
  async checkpoint(id: string) {
    const path = `${this.#path(id)}.pending`;
    return (await Bun.file(path).exists())
      ? piChatCheckpointSchema.parse(await Bun.file(path).json())
      : undefined;
  }
  async saveCheckpoint(id: string, checkpoint: PiChatCheckpoint) {
    await mkdir(this.#metadata, { recursive: true, mode: 0o700 });
    await this.#write(`${this.#path(id)}.pending`, piChatCheckpointSchema.parse(checkpoint));
  }
  async clearCheckpoint(id: string) {
    await rm(`${this.#path(id)}.pending`, { force: true });
  }
  async #write(path: string, value: unknown) {
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await Bun.write(temporary, JSON.stringify(value), { mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async messages(id: string) {
    this.#path(id);
    const directory = join(this.cwd, PI_SESSION_DIR);
    const file = SessionManager.findById(this.cwd, id, directory);
    return file ? storedChatMessages(SessionManager.open(file, directory, this.cwd)) : [];
  }
  async remove(id: string) {
    const path = this.#path(id);
    const row = piChatSessionSchema.parse(await Bun.file(path).json());
    // Keep only request IDs after deletion: a delayed retry must not replay a tool.
    await this.#write(`${path}.retired`, row.requestIds);
    const file = SessionManager.findById(this.cwd, id, join(this.cwd, PI_SESSION_DIR));
    if (file) await rm(file, { force: true });
    await rm(path, { force: true });
    await this.clearCheckpoint(id);
  }
  async wasAccepted(requestId: string) {
    z.uuid().parse(requestId);
    await mkdir(this.#metadata, { recursive: true, mode: 0o700 });
    for (const file of await readdir(this.#metadata)) {
      if (!/^[\da-f-]{36}\.json\.retired$/i.test(file)) continue;
      const ids = z.array(z.uuid()).parse(await Bun.file(join(this.#metadata, file)).json());
      if (ids.includes(requestId)) return true;
    }
    return false;
  }
}
