#!/usr/bin/env bun
// Attributes a built chunk's bytes to the modules they came from, so "should we change package X"
// is answered with data instead of a guess. Run it after a sourcemapped build:
//
//   bun --bun vite build --sourcemap                       # from apps/web; plain `bun run build` emits no maps
//   bun run --cwd apps/web bundle:attribute -- --top 25   # attributes the largest client chunk
//
// or directly: `bun run ./scripts/bundle-attribute.ts [--assets <dir>] [--chunk <name>] [--top <n>]
// [--json]`. It reads `.output/public/assets` (or --assets) and never starts the app.
//
// Why the maps and not the sources: the question is what occupies the *output*, so the attribution
// walks each chunk's `mappings` in generated order and gives every segment the span up to the next
// one. That measures what survived minification, tree-shaking and code splitting; summing
// `sourcesContent` instead would blame a package for code the bundler removed — the mistake that
// once made deleting the SDK barrel's re-exports look promising and save 0.7 KB.
//
// Two things the format makes easy to get wrong, both guarded by tests below:
//  - The `sources` index and its file/line/column are deltas across the whole map; only the
//    generated column resets on each `;`. So the segments are decoded once per map, never per line,
//    or every line after the first is credited to the wrong module.
//  - A chunk's size is bytes, while a span is measured in UTF-16 code units. The share is computed
//    from characters and scaled by the chunk's byte size, which is why a chunk is mostly ASCII in
//    practice but a chunk with CJK text would otherwise be overstated.
//
// The figure is proportional, not exact: a span's bytes depend on the minified text under it. It
// ranks and attributes; it does not audit.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One decoded mapping segment: where it starts in the generated file, and the source it came from. */
type Segment = Readonly<{ generatedLine: number; generatedColumn: number; source: string }>;

/** A module's share of one chunk: traced characters, that share, and the same share of the bytes. */
export type ModuleShare = Readonly<{
  module: string;
  characters: number;
  share: number;
  bytes: number;
}>;

export type ChunkAttribution = Readonly<{
  chunk: string;
  bytes: number;
  tracedCharacters: number;
  modules: readonly ModuleShare[];
}>;

export type BundleMap = Readonly<{ sources: readonly string[]; mappings: string }>;

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Decodes one base64 VLQ value at `index`. Five bits per character with a continuation bit (32);
 * the first bit of the final group is the sign, so `result >> 1` carries the magnitude, and one
 * character can hold magnitudes up to 15. */
export function decodeVlq(text: string, index: number): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let cursor = index;
  for (;;) {
    const digit = BASE64.indexOf(text[cursor] ?? "");
    if (digit < 0) throw new Error(`invalid VLQ character at ${cursor}`);
    cursor += 1;
    result += (digit & 31) << shift;
    if ((digit & 32) === 0) break;
    shift += 5;
  }
  const magnitude = result >> 1;
  return { value: (result & 1) === 1 ? -magnitude : magnitude, next: cursor };
}

/** Every segment of a map, in generated order, tagged with its generated line. A segment is
 * `[generatedColumn]`, `[generatedColumn, source, line, column]`, or those four plus a name index.
 * Decode the whole map at once: the source index accumulates across `;`, so decoding line by line
 * would restart it and mis-attribute every line but the first. Segments without a source (generated
 * code the compiler owns) are kept, with an empty source, so the spans between them stay anchored. */
export function segmentsOf(mappings: string, sources: readonly string[]): Segment[] {
  const segments: Segment[] = [];
  let sourceIndex = 0;
  mappings.split(";").forEach((line, generatedLine) => {
    let generatedColumn = 0;
    for (const field of line.split(",")) {
      if (field === "") continue;
      const parts: number[] = [];
      let cursor = 0;
      while (cursor < field.length) {
        const decoded = decodeVlq(field, cursor);
        parts.push(decoded.value);
        cursor = decoded.next;
      }
      generatedColumn += parts[0] ?? 0;
      if (parts.length > 3) {
        sourceIndex += parts[1] ?? 0;
        segments.push({
          generatedLine,
          generatedColumn,
          source: sources[sourceIndex] ?? "<unknown>",
        });
      } else {
        segments.push({ generatedLine, generatedColumn, source: "" });
      }
    }
  });
  return segments;
}

/** What a source path is reported as. A package under `node_modules` is named by its package (with
 * its scope), so `zod`'s internal files count as one module; the app's own files are named by their
 * path under `src`, which survives a dependency's file layout changing. Bun keeps its dependencies
 * in a store, so a package appears as `node_modules/.bun/<name>@<version>/node_modules/<name>/…` and
 * the *last* `node_modules/` segment is the package itself — the first one is only the store. Vite
 * emits sources relative to the output directory, so the leading `../` segments are dropped first. */
export function moduleOf(source: string): string {
  const path = source.replace(/^(\.\.\/)+/, "");
  const packages = [...path.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)];
  const packageName = packages.at(-1)?.[1];
  if (packageName) return packageName;
  const sourcePath = /((?:apps|packages)\/[^/]+\/src\/.+)$/.exec(path);
  return sourcePath?.[1] ?? path;
}

/** Attributes one chunk: each segment owns the characters up to the next segment on its line (or
 * to the end of the line for the last one), and those characters are credited to the segment's
 * module. `generated` is the chunk's own text, which supplies each line's length. */
export function attributeChunk(
  generated: string,
  map: BundleMap,
): Readonly<{ characters: number; byModule: ReadonlyMap<string, number> }> {
  const lineLengths = generated.split("\n").map((line) => line.length);
  const segments = segmentsOf(map.mappings, map.sources);
  const byModule = new Map<string, number>();
  let characters = 0;
  segments.forEach((segment, index) => {
    const next = segments[index + 1];
    const end =
      next && next.generatedLine === segment.generatedLine
        ? next.generatedColumn
        : (lineLengths[segment.generatedLine] ?? 0);
    const span = end - segment.generatedColumn;
    if (span <= 0 || segment.source === "") return;
    const module = moduleOf(segment.source);
    byModule.set(module, (byModule.get(module) ?? 0) + span);
    characters += span;
  });
  return { characters, byModule };
}

/** Ranks a chunk's modules, scaling each module's share of the traced characters by the chunk's
 * size in bytes: the spans measure structure, the file size measures bytes. */
export function summarizeChunk(
  chunk: string,
  bytes: number,
  attribution: Readonly<{ characters: number; byModule: ReadonlyMap<string, number> }>,
): ChunkAttribution {
  const modules = [...attribution.byModule]
    .map(([module, characters]) => ({
      module,
      characters,
      share: attribution.characters === 0 ? 0 : characters / attribution.characters,
      bytes:
        attribution.characters === 0
          ? 0
          : Math.round((characters / attribution.characters) * bytes),
    }))
    .sort((left, right) => right.characters - left.characters);
  return { chunk, bytes, tracedCharacters: attribution.characters, modules };
}

/** A table an operator can read, with the percentage and the scaled bytes side by side so a
 * module's rank and its weight are never confused. */
export function formatAttribution(attribution: ChunkAttribution, top: number): string {
  const lines = [
    `${attribution.chunk} — ${attribution.bytes} B, ${attribution.tracedCharacters} traced characters`,
    `${"share".padStart(7)} ${"bytes".padStart(10)}  module`,
  ];
  for (const entry of attribution.modules.slice(0, top)) {
    lines.push(
      `${(entry.share * 100).toFixed(1).padStart(6)}% ${String(entry.bytes).padStart(10)}  ${entry.module}`,
    );
  }
  if (attribution.modules.length > top)
    lines.push(`         ${" ".repeat(10)}  … ${attribution.modules.length - top} more`);
  return lines.join("\n");
}

/** The chunk to attribute: the named one, or the largest client chunk by size, which is where a
 * bundle question usually starts. A name that matches nothing is an error: falling back to the
 * largest chunk would silently attribute a chunk the caller did not ask about. The size comes from
 * `sizeOf`, not the file name, because the longest names belong to the chunks with the most routes
 * in them, not to the chunks with the most bytes. */
export function pickChunk(
  files: readonly string[],
  name: string | undefined,
  sizeOf: (file: string) => number,
): string {
  if (name) {
    const matches = files.filter((file) => file.includes(name));
    const chosen = [...matches].sort((left, right) => sizeOf(right) - sizeOf(left))[0];
    if (!chosen) throw new Error(`no chunk matching "${name}"`);
    return chosen;
  }
  const chosen = [...files].sort((left, right) => sizeOf(right) - sizeOf(left))[0];
  if (!chosen)
    throw new Error("no client chunk found; run `bun --bun vite build --sourcemap` first");
  return chosen;
}

function readChunk(assets: string, name: string | undefined) {
  const files = readdirSync(assets)
    .filter((file) => file.endsWith(".js"))
    .map((file) => join(assets, file));
  const chunk = pickChunk(files, name, (file) => readFileSync(file).byteLength);
  const generated = readFileSync(chunk, "utf8");
  let map: BundleMap;
  try {
    map = JSON.parse(readFileSync(`${chunk}.map`, "utf8")) as BundleMap;
  } catch {
    throw new Error(
      `${chunk} has no source map: build with \`bun --bun vite build --sourcemap\` (plain \`bun run build\` emits none)`,
    );
  }
  return { chunk, generated, map };
}

function main(argv: readonly string[]) {
  let assets = ".output/public/assets";
  let name: string | undefined;
  let top = 20;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--assets") assets = argv[(index += 1)] ?? assets;
    else if (flag === "--chunk") name = argv[(index += 1)];
    else if (flag === "--top") top = Number(argv[(index += 1)] ?? top);
    else if (flag === "--json") json = true;
  }
  const { chunk, generated, map } = readChunk(assets, name);
  // The size is the file's bytes, not the text's length: a chunk with CJK text would otherwise be
  // understated, since a span counts UTF-16 code units and a byte count is what ships.
  const attribution = summarizeChunk(
    chunk,
    readFileSync(chunk).byteLength,
    attributeChunk(generated, map),
  );
  if (json) console.log(JSON.stringify(attribution, null, 2));
  else console.log(formatAttribution(attribution, top));
}

if (import.meta.main) main(process.argv.slice(2));
