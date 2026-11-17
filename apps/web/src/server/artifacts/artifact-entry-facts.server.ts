import { inflateSync } from "node:zlib";
import { parseCsv } from "#src/features/artifacts/artifact-csv";
import type { ArtifactEntryFacts } from "#src/features/artifacts/artifact-entry-facts";
import { artifactKindOfPath } from "#src/features/artifacts/artifact-path-kind";
import {
  IMAGE_HEADER_MAX_BYTES,
  imageDimensions,
} from "#src/server/attachments/attachment-image-dimensions.server";
import { artifactContentType } from "./artifact-content-types.server";
import { ARTIFACT_ENTRY_READ_LIMIT } from "./artifact-files.server";

const COLUMN_NAMES_KEPT = 20;
const COLUMN_NAME_CHARACTERS = 80;

export async function artifactEntryFacts(
  path: string,
  sizeBytes: number,
  read: () => Promise<Uint8Array | null>,
): Promise<ArtifactEntryFacts | null> {
  const kind = artifactKindOfPath(path);
  if (kind === "markdown" || kind === "html") return null;
  const facts = { sizeBytes };
  const readable = kind === "pdf" || kind === "text" || kind === "csv" || kind === "image";
  if (!readable || sizeBytes > ARTIFACT_ENTRY_READ_LIMIT) return facts;
  const bytes = await read();
  if (!bytes) return facts;
  if (kind === "pdf") {
    const pages = pdfPageCount(bytes);
    return pages === null ? facts : { ...facts, pages };
  }
  if (kind === "image") {
    const found = imageDimensions(
      bytes.subarray(0, IMAGE_HEADER_MAX_BYTES),
      artifactContentType(path, "binary"),
    );
    return found ? { ...facts, width: found.imageWidth, height: found.imageHeight } : facts;
  }
  const text = new TextDecoder().decode(bytes);
  if (kind === "csv") return { ...facts, ...csvFacts(text) };
  return { ...facts, lines: lineCount(text) };
}

function csvFacts(text: string) {
  const [header, ...records] = parseCsv(text);
  const names = (header?.cells ?? [])
    .map((name) => name.trim().slice(0, COLUMN_NAME_CHARACTERS))
    .filter(Boolean)
    .slice(0, COLUMN_NAMES_KEPT);
  return {
    rows: records.length,
    columns: header?.cells.length ?? 0,
    ...(names.length ? { columnNames: names } : {}),
  };
}

const LF = 0x0a;
const CR = 0x0d;

function lineCount(text: string): number {
  let lines = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text.charCodeAt(index);
    if (char === LF || (char === CR && text.charCodeAt(index + 1) !== LF)) lines++;
  }
  const last = text.charCodeAt(text.length - 1);
  return text.length > 0 && last !== LF && last !== CR ? lines + 1 : lines;
}

const INFLATED_BUDGET_BYTES = 16 * 1024 * 1024;
const PDF_PAGES_MAX = 1_000_000;

type PageNode = { count: number; child: boolean };
type Budget = { inflated: number };
type Frame = {
  array: boolean;
  key: string | null;
  type?: string;
  count?: number;
  child?: boolean;
  length?: number;
  flate?: boolean;
};

function pdfPageCount(bytes: Uint8Array): number | null {
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  const nodes: PageNode[] = [];
  scanPdf(raw, nodes, { inflated: 0 });
  const roots = nodes.filter((node) => !node.child);
  const counted = roots.length ? roots : nodes;
  return counted.length ? counted.reduce((most, node) => Math.max(most, node.count), 0) : null;
}

function scanPdf(text: string, nodes: PageNode[], budget: Budget) {
  const stack: Frame[] = [];
  let closed: Frame | null = null;
  let index = 0;
  const valueTaken = () => {
    const current = stack.at(-1);
    if (current && !current.array) current.key = null;
  };
  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (WHITESPACE.has(char)) {
      index++;
    } else if (char === "%") {
      while (index < text.length && text[index] !== "\n" && text[index] !== "\r") index++;
    } else if (char === "(") {
      index = afterLiteralString(text, index);
      valueTaken();
    } else if (char === "<" && next === "<") {
      stack.push({ array: false, key: null });
      index += 2;
    } else if (char === ">" && next === ">") {
      const popped = stack.pop();
      if (popped && !popped.array) {
        if (popped.type === "Pages" && popped.count !== undefined)
          nodes.push({ count: popped.count, child: popped.child === true });
        closed = popped;
      }
      valueTaken();
      index += 2;
    } else if (char === "<") {
      const end = text.indexOf(">", index + 1);
      index = end < 0 ? text.length : end + 1;
      valueTaken();
    } else if (char === "[") {
      stack.push({ array: true, key: null });
      index++;
    } else if (char === "]") {
      if (stack.at(-1)?.array) stack.pop();
      valueTaken();
      index++;
    } else if (char === "/") {
      const end = tokenEnd(text, index + 1);
      readName(stack.at(-1), text.slice(index + 1, end));
      index = end;
    } else {
      const end = Math.max(tokenEnd(text, index), index + 1);
      const word = text.slice(index, end);
      index = end;
      if (word === "stream" && closed) {
        index = afterStream(text, index, closed, nodes, budget);
        closed = null;
      } else {
        closed = null;
        readWord(stack.at(-1), word, text, index);
      }
    }
  }
}

function readName(frame: Frame | undefined, name: string) {
  if (!frame || frame.array) return;
  if (frame.key === null) {
    frame.key = name;
    if (name === "Parent") frame.child = true;
    return;
  }
  if (frame.key === "Type") frame.type = name;
  if (frame.key === "Filter" && name === "FlateDecode") frame.flate = true;
  frame.key = null;
}

function readWord(frame: Frame | undefined, word: string, text: string, after: number) {
  if (!frame || frame.array || frame.key === null) return;
  if (/^\d+$/.test(word) && !indirectReference(text, after)) {
    if (frame.key === "Count" && Number(word) <= PDF_PAGES_MAX) frame.count = Number(word);
    if (frame.key === "Length") frame.length = Number(word);
  }
  frame.key = null;
}

function afterStream(
  text: string,
  index: number,
  dictionary: Frame,
  nodes: PageNode[],
  budget: Budget,
): number {
  let start = index;
  if (text[start] === "\r") start++;
  if (text[start] === "\n") start++;
  const marked = text.indexOf("endstream", start);
  const declared = dictionary.length;
  const end =
    declared !== undefined && start + declared <= text.length
      ? start + declared
      : marked < 0
        ? text.length
        : marked;
  if (dictionary.type === "ObjStm" && dictionary.flate && budget.inflated < INFLATED_BUDGET_BYTES) {
    try {
      const inflated = inflateSync(Buffer.from(text.slice(start, end), "latin1"), {
        maxOutputLength: INFLATED_BUDGET_BYTES - budget.inflated,
      });
      budget.inflated += inflated.length;
      scanPdf(inflated.toString("latin1"), nodes, budget);
    } catch {
      budget.inflated = INFLATED_BUDGET_BYTES;
    }
  }
  const after = text.indexOf("endstream", end);
  return after < 0 ? text.length : after + "endstream".length;
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f", "\0"]);
const DELIMITERS = new Set(["(", ")", "<", ">", "[", "]", "{", "}", "/", "%"]);

function tokenEnd(text: string, index: number): number {
  let end = index;
  while (end < text.length && !WHITESPACE.has(text[end]!) && !DELIMITERS.has(text[end]!)) end++;
  return end;
}

function afterLiteralString(text: string, index: number): number {
  let depth = 0;
  for (let at = index; at < text.length; at++) {
    const char = text[at];
    if (char === "\\") at++;
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return at + 1;
  }
  return text.length;
}

function indirectReference(text: string, index: number): boolean {
  return /^\s+\d+\s+R(?![A-Za-z0-9])/.test(text.slice(index, index + 24));
}
