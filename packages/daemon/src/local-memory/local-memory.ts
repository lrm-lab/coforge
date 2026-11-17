import {
  decodeLocalMemoryCommand,
  type LocalMemoryCommand,
  type LocalMemoryEntry,
  type LocalMemoryResult,
} from "@lrm/coforge-sdk/agent";
import { historyFiles, listMemoryFiles, readMemoryFile, replaceMemoryFile } from "./memory-files";
import {
  decodeMemoryRecord,
  encodeMemoryRecord,
  memoryRevision,
  memorySearchScore,
} from "./memory-record";
import { serializeMemoryWrite } from "./memory-write-lock";
import { MemoryFileIndex } from "./memory-file-index";

export class LocalMemory {
  readonly #index: MemoryFileIndex;
  constructor(private readonly root: string) {
    this.#index = new MemoryFileIndex(root);
  }

  async execute(input: LocalMemoryCommand): Promise<LocalMemoryResult> {
    const command = decodeLocalMemoryCommand(input);
    if (command.operation === "list")
      return this.list(command.offset ?? 0, command.archived ?? false);
    if (command.operation === "search")
      return this.search(command.query, command.offset ?? 0, command.archived ?? false);
    if (command.operation === "get")
      return { entries: [await this.get(command.key, command.revision)] };
    if (command.operation === "history") {
      const files = await historyFiles(this.root, command.key);
      const offset = command.offset ?? 0;
      const selected = files.slice(offset, offset + 5);
      const batch = await Promise.all(
        selected.map(async (name) => {
          const path = `notes/history/${command.key}/${name}`;
          const text = await readMemoryFile(this.root, path);
          return text ? decodeMemoryRecord(text, path) : undefined;
        }),
      );
      const entries: LocalMemoryEntry[] = [];
      let inspected = 0;
      for (const entry of batch) {
        if (entry) {
          const preview = {
            ...entry,
            updatedAt: new Date(entry.updatedAt).toISOString(),
            applicability: entry.applicability.slice(0, 150),
            content: entry.content.trimStart().slice(0, 600),
            source: entry.source.trimStart().slice(0, 200),
          };
          if (
            Buffer.byteLength(
              JSON.stringify({
                entries: [...entries, preview],
                nextOffset: offset + inspected + 1,
              }),
            ) > 12000
          )
            break;
          entries.push(preview);
        }
        inspected++;
      }
      return {
        entries,
        ...(offset + inspected < files.length ? { nextOffset: offset + inspected } : {}),
      };
    }
    return serializeMemoryWrite(this.root, () => this.save(command));
  }

  private async get(key: string, revision?: string): Promise<LocalMemoryEntry> {
    const currentPath = `notes/knowledge/${key}.md`;
    const current = await readMemoryFile(this.root, currentPath);
    const path =
      revision && (!current || memoryRevision(current) !== revision)
        ? `notes/history/${key}/${revision}.md`
        : currentPath;
    const text = path === currentPath ? current : await readMemoryFile(this.root, path);
    if (text === undefined) throw new Error("memory_not_found");
    const entry = decodeMemoryRecord(text, path);
    if (!entry || entry.key !== key || (revision !== undefined && entry.revision !== revision))
      throw new Error("memory_invalid_file");
    return entry;
  }

  private async save(
    command: Extract<LocalMemoryCommand, { operation: "save" | "archive" }>,
  ): Promise<LocalMemoryResult> {
    const path = `notes/knowledge/${command.key}.md`;
    const current = await readMemoryFile(this.root, path);
    if ((current === undefined ? "new" : memoryRevision(current)) !== command.revision)
      throw new Error("memory_conflict");
    const previous = current === undefined ? undefined : decodeMemoryRecord(current, path);
    if (current !== undefined && !previous) throw new Error("memory_invalid_file");
    if (command.operation === "archive" && !previous) throw new Error("memory_not_found");
    const entry =
      command.operation === "save"
        ? {
            key: command.key,
            title: command.title,
            content: command.content,
            source: command.source,
            kind: command.kind,
            applicability: command.applicability,
            status: "active" as const,
            updatedAt: new Date().toISOString(),
          }
        : { ...previous!, status: "archived" as const, updatedAt: new Date().toISOString() };
    const text = encodeMemoryRecord(entry);
    if (current !== undefined)
      await replaceMemoryFile(
        this.root,
        `notes/history/${command.key}/${memoryRevision(current)}.md`,
        current,
      );
    await replaceMemoryFile(this.root, path, text);
    return { entries: [decodeMemoryRecord(text, path)!] };
  }

  private async search(
    query: string,
    offset: number,
    archived: boolean,
  ): Promise<LocalMemoryResult> {
    const listed = await listMemoryFiles(this.root);
    const paths = listed.paths;
    let incomplete = listed.incomplete;
    const page = paths.slice(offset, offset + 128);
    const matches: { entry: LocalMemoryEntry; score: number }[] = [];
    for (let index = 0; index < page.length; index += 8) {
      const batch = await Promise.all(
        page.slice(index, index + 8).map(async (path) => {
          const text = await this.#index.read(path).catch((error: unknown) => {
            if (
              error instanceof Error &&
              ["memory_file_too_large", "memory_unsafe_path"].includes(error.message)
            ) {
              incomplete = true;
              return undefined;
            }
            throw error;
          });
          if (!text) return undefined;
          const saved = decodeMemoryRecord(text, path);
          if (
            path.startsWith("notes/knowledge/") &&
            (!saved || saved.status !== (archived ? "archived" : "active"))
          )
            return undefined;
          if (archived && !saved) return undefined;
          const { score, position } = memorySearchScore(
            saved ? `${saved.title}\n${saved.content}\n${saved.applicability}` : text,
            query,
          );
          if (!score) return undefined;
          const entry = saved ?? {
            key: path,
            title: path,
            content: text,
            source: path,
            kind: "fact" as const,
            applicability: "",
            status: "active" as const,
            updatedAt: "",
            revision: memoryRevision(text),
            path,
          };
          const start = Math.max(0, position - 200);
          return { entry: { ...entry, content: entry.content.slice(start, start + 1_600) }, score };
        }),
      );
      matches.push(...batch.filter((item) => item !== undefined));
    }
    const nextOffset = offset + page.length < paths.length ? offset + page.length : undefined;
    return {
      entries: matches
        .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
        .slice(0, 10)
        .map((item) => item.entry),
      ...(nextOffset === undefined ? {} : { nextOffset }),
      ...(incomplete || nextOffset !== undefined ? { incomplete: true } : {}),
    };
  }

  private async list(offset: number, archived: boolean): Promise<LocalMemoryResult> {
    const listed = await listMemoryFiles(this.root);
    const paths = listed.paths.filter((path) => path.startsWith("notes/knowledge/"));
    const page = paths.slice(offset, offset + 5);
    let incomplete = listed.incomplete;
    const candidates = await Promise.all(
      page.map(async (path) => {
        try {
          const text = await this.#index.read(path);
          const entry = text ? decodeMemoryRecord(text, path) : undefined;
          if (!entry || path !== `notes/knowledge/${entry.key}.md`) {
            incomplete = true;
            return undefined;
          }
          if (entry.status !== (archived ? "archived" : "active")) return undefined;
          return {
            ...entry,
            updatedAt: new Date(entry.updatedAt).toISOString(),
            content: entry.content.slice(0, 600),
            source: entry.source.slice(0, 200),
            applicability: entry.applicability.slice(0, 150),
          };
        } catch {
          incomplete = true;
          return undefined;
        }
      }),
    );
    const entries: LocalMemoryEntry[] = [];
    let processed = 0;
    for (const candidate of candidates) {
      if (candidate && Buffer.byteLength(JSON.stringify([...entries, candidate])) > 11_000) break;
      processed++;
      if (candidate) entries.push(candidate);
    }
    const nextOffset = offset + processed < paths.length ? offset + processed : undefined;
    return {
      entries,
      ...(nextOffset === undefined ? {} : { nextOffset }),
      ...(incomplete || nextOffset !== undefined ? { incomplete: true } : {}),
    };
  }

  async brief(maxBytes: number): Promise<string> {
    const { paths, incomplete } = await listMemoryFiles(this.root);
    let unreadable = false;
    const entries: LocalMemoryEntry[] = [];
    const selected = paths.filter((item) => item.startsWith("notes/knowledge/"));
    for (let index = 0; index < selected.length; index += 8) {
      const batch = await Promise.all(
        selected.slice(index, index + 8).map(async (path) => {
          const text = await readMemoryFile(this.root, path, 16_384).catch(() => undefined);
          const entry = text ? decodeMemoryRecord(text, path) : undefined;
          if (!entry) unreadable = true;
          return entry;
        }),
      );
      entries.push(
        ...batch.filter(
          (entry): entry is LocalMemoryEntry => entry !== undefined && entry.status === "active",
        ),
      );
    }
    entries.sort(
      (a, b) =>
        Number(b.kind === "decision") - Number(a.kind === "decision") ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
    const lines: string[] = [];
    const discovery =
      "These are partial excerpts. Find more with coforge memory list or coforge memory search --query <query>; read full evidence with coforge memory get --key <key>. Continue when an offset is offered.";
    let bytes = Buffer.byteLength(discovery) + 1;
    for (const entry of entries) {
      const line = `- ${entry.title}: ${entry.content.slice(0, 500)} [${entry.applicability}; source: ${entry.source.slice(0, 160)}; ${entry.updatedAt}; ${entry.path}]`;
      const length = Buffer.byteLength(line) + 1;
      if (bytes + length > maxBytes) continue;
      lines.push(line);
      bytes += length;
    }
    return (entries.length || incomplete || unreadable) && bytes <= maxBytes
      ? [discovery, ...lines].join("\n")
      : "";
  }
}
