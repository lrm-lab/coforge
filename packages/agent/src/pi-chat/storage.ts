import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { piChatSessionSchema, type PiChatSession } from "@lrm/coforge-sdk/internal/pi-chat";
import { PI_SESSION_DIR, prepareAgentSessionDirectory } from "#src/paths";
import { storedChatMessages } from "./runtime";
import type { PiChatStore, WorkbenchCodex } from "./sessions";
import { piChatCheckpointSchema, type PiChatCheckpoint } from "./checkpoint";

/** Metadata only; Pi's JSONL retains the complete native transcript, including compaction history. */
export class FilePiChatStore implements PiChatStore {
  readonly #metadata: string;
  readonly #codexMetadata: string;
  private constructor(
    readonly cwd: string,
    private readonly codex?: WorkbenchCodex,
  ) {
    this.#metadata = join(cwd, ".chat-index");
    this.#codexMetadata = join(cwd, ".codex-chat-index");
  }
  /** Prepare the session boundary once and keep its canonical workspace for every operation.
   * Pi compares the header's cwd exactly; a symlink alias must not hide a saved transcript. */
  static async open(cwd: string, codex?: WorkbenchCodex) {
    const workspace = await prepareAgentSessionDirectory(cwd, join(cwd, PI_SESSION_DIR));
    return new FilePiChatStore(workspace, codex);
  }
  #path(id: string, runtime?: "pi" | "codex") {
    return join(
      runtime === "codex" ? this.#codexMetadata : this.#metadata,
      `${piChatSessionSchema.shape.id.parse(id)}.json`,
    );
  }
  async list() {
    const pi = this.#list(this.#metadata);
    return this.codex ? [...(await pi), ...(await this.#list(this.#codexMetadata))] : pi;
  }
  async #list(directory: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const files = await readdir(directory);
    return Promise.all(
      files
        .filter((file) => /^[\da-f-]{36}\.json$/i.test(file))
        .map(async (file) => {
          const row = piChatSessionSchema.parse(await Bun.file(join(directory, file)).json());
          if (`${row.id}.json` !== file) throw new Error("session index mismatch");
          if ((row.runtime === "codex") !== (directory === this.#codexMetadata))
            throw new Error("session runtime index mismatch");
          return row;
        }),
    );
  }
  async save(session: PiChatSession) {
    const row = piChatSessionSchema.parse(session);
    await mkdir(row.runtime === "codex" ? this.#codexMetadata : this.#metadata, {
      recursive: true,
      mode: 0o700,
    });
    const path = this.#path(row.id, row.runtime);
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
  async codexHistory(id: string, cursor?: string) {
    this.#path(id);
    if (!this.codex) throw new Error("Codex runtime is unavailable");
    return this.codex.history(id, cursor);
  }
  async remove(id: string) {
    const codex = this.#path(id, "codex");
    const path = this.codex && (await Bun.file(codex).exists()) ? codex : this.#path(id);
    const row = piChatSessionSchema.parse(await Bun.file(path).json());
    // Keep only request IDs after deletion: a delayed retry must not replay a tool.
    await this.#write(`${path}.retired`, row.requestIds);
    if (row.runtime === "codex") {
      if (!this.codex) throw new Error("Codex runtime is unavailable");
      await this.codex.archive(id);
    } else {
      const file = SessionManager.findById(this.cwd, id, join(this.cwd, PI_SESSION_DIR));
      if (file) await rm(file, { force: true });
    }
    await rm(path, { force: true });
    await this.clearCheckpoint(id);
  }
  async wasAccepted(requestId: string) {
    z.uuid().parse(requestId);
    const directories = this.codex ? [this.#metadata, this.#codexMetadata] : [this.#metadata];
    for (const directory of directories) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      for (const file of await readdir(directory)) {
        if (!/^[\da-f-]{36}\.json\.retired$/i.test(file)) continue;
        const ids = z.array(z.uuid()).parse(await Bun.file(join(directory, file)).json());
        if (ids.includes(requestId)) return true;
      }
    }
    return false;
  }
}
