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
import {
  orderMemoryHistory,
  memoryListPreview,
  readMemoryRecordSummary,
} from "./memory-record-pages";

const LIST_PAGE_SIZE = 5;
const SEARCH_MATCH_PAGE_SIZE = 10;
const SEARCH_FILE_LIMIT = 1_024;
const SEARCH_OFFSET_PREFIX = 100_001;
const SEARCH_OFFSET_STRIDE = SEARCH_FILE_LIMIT + 1;

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
      const files = await orderMemoryHistory(
        this.root,
        command.key,
        await historyFiles(this.root, command.key),
      );
      const offset = command.offset ?? 0;
      const selected = files.slice(offset, offset + 5);
      const batch = await Promise.all(
        selected.map(async (name) => {
          const path = `notes/history/${command.key}/${name}`;
          const text = await readMemoryFile(this.root, path).catch(() => undefined);
          const entry = text ? decodeMemoryRecord(text, path) : undefined;
          return entry && name === `${entry.revision}.md` ? entry : undefined;
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
    const rankedOffset = offset >= SEARCH_OFFSET_PREFIX ? offset - SEARCH_OFFSET_PREFIX : 0;
    const fileOffset =
      offset >= SEARCH_OFFSET_PREFIX ? Math.floor(rankedOffset / SEARCH_OFFSET_STRIDE) : offset;
    const matchOffset = rankedOffset % SEARCH_OFFSET_STRIDE;
    const page = paths.slice(fileOffset, fileOffset + SEARCH_FILE_LIMIT);
    const matches: { entry: LocalMemoryEntry; score: number }[] = [];
    let inspected = 0;
    let bytes = 0;
    for (; inspected < page.length && bytes < 8 * 1024 * 1024; inspected += 8) {
      const batch = await Promise.all(
        page.slice(inspected, inspected + 8).map(async (path) => {
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
          bytes += Buffer.byteLength(text);
          const saved = decodeMemoryRecord(text, path);
          if (
            path.startsWith("notes/knowledge/") &&
            (!saved || saved.status !== (archived ? "archived" : "active"))
          )
            return undefined;
          if (archived && !saved) return undefined;
          const { score: bodyScore, position } = memorySearchScore(saved?.content ?? text, query);
          const score = saved
            ? bodyScore +
              2 * memorySearchScore(saved.title, query).score +
              memorySearchScore(saved.applicability, query).score
            : bodyScore;
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
    const nextFile = fileOffset + Math.min(inspected, page.length);
    const nextMatch = matchOffset + SEARCH_MATCH_PAGE_SIZE;
    const nextOffset =
      nextMatch < matches.length
        ? SEARCH_OFFSET_PREFIX + fileOffset * SEARCH_OFFSET_STRIDE + nextMatch
        : nextFile < paths.length
          ? nextFile
          : undefined;
    return {
      entries: matches
        .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
        .slice(matchOffset, nextMatch)
        .map((item) => item.entry),
      ...(nextOffset === undefined ? {} : { nextOffset }),
      ...(incomplete || nextFile < paths.length ? { incomplete: true } : {}),
    };
  }

  private async list(offset: number, archived: boolean): Promise<LocalMemoryResult> {
    const listed = await listMemoryFiles(this.root);
    const paths = listed.paths.filter((path) => path.startsWith("notes/knowledge/"));
    let incomplete = listed.incomplete;
    const status = archived ? "archived" : "active";
    let matched = 0;
    const page: string[] = [];
    for (let index = 0; offset < paths.length && index < paths.length; index += 8) {
      const batch = paths.slice(index, index + 8);
      const candidates = await Promise.all(
        batch.map((path) => readMemoryRecordSummary(this.root, path)),
      );
      for (const [position, candidate] of candidates.entries()) {
        const path = batch[position]!;
        if (!candidate || path !== `notes/knowledge/${candidate.key}.md`) {
          incomplete = true;
          continue;
        }
        if (candidate.status !== status) continue;
        if (matched++ < offset) continue;
        page.push(path);
        if (page.length > LIST_PAGE_SIZE) break;
      }
      if (page.length > LIST_PAGE_SIZE) break;
    }
    const records = await Promise.all(
      page.slice(0, LIST_PAGE_SIZE).map(async (path) => {
        const text = await this.#index.read(path).catch(() => undefined);
        const entry = text ? decodeMemoryRecord(text, path) : undefined;
        return entry?.status === status && path === `notes/knowledge/${entry.key}.md`
          ? memoryListPreview(entry, Math.floor(11_000 / LIST_PAGE_SIZE) - 2)
          : undefined;
      }),
    );
    const entries = records.filter((record) => record !== undefined);
    const hasNext = page.length > LIST_PAGE_SIZE;
    return {
      entries,
      ...(hasNext ? { nextOffset: offset + LIST_PAGE_SIZE } : {}),
      ...(incomplete || hasNext || records.length !== entries.length ? { incomplete: true } : {}),
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
