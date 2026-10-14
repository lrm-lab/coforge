#!/usr/bin/env bun
// Reports the weight of what a first paint downloads: the entry chunk's static import closure or
// the chunks the built HTML actually preloads, plus the entry stylesheet. Run it after
// `bun run build`; it reads `.output/public/assets` and never starts the app.
//
// Run from the repository root with `bun run --cwd apps/web bundle:report` (the script is this
// package's, so a bare `bun run bundle:report` from the root finds no such script), or directly:
// `bun run ./scripts/bundle-size-report.ts [--json] [--entry <name>] [--assets <dir>]`.
//
// Two measurements, because they answer different questions:
//
// 1. `--entry` (default): the static import closure of one chunk — the code a browser downloads
//    before it can run that chunk. Boot-free and stable, so it works as a regression yardstick.
//    TanStack Start's manifest builder follows the same static import graph to produce
//    the entry's `modulepreload` links.
// 2. `--html <file>`: every `<script src>` and `rel="modulepreload"` in a page the built server
//    rendered (`bun run .output/server/index.mjs`, then `curl -L http://127.0.0.1:<port>/en`). This
//    is the honest first-paint set: it adds the lazy route chunks the current page preloads, which
//    the closure cannot see. It needs the server's env, so it is documented rather than run here.
//
// Sizes are uncompressed and gzip, because the server compresses on the wire and a raw-only
// number overstates a chunk that is mostly repetition.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

/** A static import of a relative module: `import"./a.js"` or `import{x}from"./a.js"`. A dynamic
 * `import("./a.js")` is deliberately not one — this closure is what the browser fetches before the
 * entry runs, not what the entry can reach. A bare "./a.js" string such as a `__vite__mapDeps`
 * entry is not an import statement and does not match either. */
const STATIC_IMPORT =
  /(?:^|[;}])\s*import\s*(?:[^"'()]*?from\s*)?["'](\.\/[A-Za-z0-9_~.$-]+\.js)["']/g;

export type BundleFile = Readonly<{ name: string; bytes: number; gzipBytes: number }>;

export type BundleSummary = Readonly<{
  entry: string;
  files: readonly BundleFile[];
  rawBytes: number;
  gzipBytes: number;
  css: BundleFile | undefined;
  totalRawBytes: number;
  totalGzipBytes: number;
}>;

/** Every relative module the given source statically imports, in source order, deduplicated. */
export function staticImportsOf(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(STATIC_IMPORT)) names.add(match[1].slice(2));
  return [...names];
}

/** The entry plus everything it statically reaches, transitively. A name with no content is
 * skipped: the build's own chunk names are its own, and a missing one should not fail a report. */
export function staticClosureOf(contents: ReadonlyMap<string, string>, entry: string): string[] {
  const reached = new Set<string>();
  const pending = [entry];
  while (pending.length) {
    const name = pending.pop();
    if (name === undefined || reached.has(name)) continue;
    const source = contents.get(name);
    if (source === undefined) continue;
    reached.add(name);
    pending.push(...staticImportsOf(source));
  }
  // The entry leads, then the largest first, so the report reads like the waterfall it measures.
  return [...reached].sort((left, right) =>
    left === entry ? -1 : right === entry ? 1 : left.localeCompare(right),
  );
}

function measure(name: string, content: Buffer): BundleFile {
  return { name, bytes: content.byteLength, gzipBytes: gzipSync(content, { level: 6 }).byteLength };
}

/** Summarizes an already-built asset directory: one file per name in `contents` (the entry and its
 * closure), the optional entry stylesheet, and their combined weight. */
export function summarizeBundle(input: {
  contents: ReadonlyMap<string, Buffer>;
  entry: string;
  css?: string | undefined;
}): BundleSummary {
  const { contents, entry, css } = input;
  const sources = new Map<string, string>();
  for (const [name, content] of contents) sources.set(name, content.toString("utf8"));
  const files = staticClosureOf(sources, entry)
    .map((name) => measure(name, contents.get(name) as Buffer))
    .sort((left, right) => right.bytes - left.bytes);
  const cssFile =
    css !== undefined && contents.has(css) ? measure(css, contents.get(css) as Buffer) : undefined;
  const rawBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const gzipBytes = files.reduce((sum, file) => sum + file.gzipBytes, 0);
  return {
    entry,
    files,
    rawBytes,
    gzipBytes,
    css: cssFile,
    totalRawBytes: rawBytes + (cssFile?.bytes ?? 0),
    totalGzipBytes: gzipBytes + (cssFile?.gzipBytes ?? 0),
  };
}

const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

/** The single asset whose name matches `pattern`, or a message saying what a human has to choose
 * between — an ambiguous default would report the wrong page's weight without saying so. */
export function uniqueAsset(names: readonly string[], pattern: RegExp, what: string): string {
  const matches = names.filter((name) => pattern.test(name));
  if (matches.length === 0)
    throw new Error(`no ${what} in the assets directory (expected ${pattern})`);
  if (matches.length > 1)
    throw new Error(`more than one ${what}: ${matches.join(", ")}; pass one explicitly`);
  return matches[0];
}

/** Reads every `.js` and `.css` in an asset directory into memory. The whole directory is small
 * enough (single-digit MB) that streaming or a size cutoff would only add a failure mode. */
export function readAssets(directory: string): Map<string, Buffer> {
  const contents = new Map<string, Buffer>();
  for (const name of readdirSync(directory)) {
    if (!/\.(?:js|css)$/.test(name)) continue;
    contents.set(name, readFileSync(join(directory, name)));
  }
  return contents;
}

export function formatSummary(summary: BundleSummary, largest = 12): string {
  const lines = [
    `entry: ${summary.entry}`,
    `initial JS: ${summary.files.length} files, raw ${kib(summary.rawBytes)}, gzip ${kib(summary.gzipBytes)}`,
  ];
  if (summary.css)
    lines.push(
      `initial CSS: raw ${kib(summary.css.bytes)}, gzip ${kib(summary.css.gzipBytes)} (${summary.css.name})`,
    );
  lines.push(
    `first paint total: raw ${kib(summary.totalRawBytes)}, gzip ${kib(summary.totalGzipBytes)}`,
  );
  lines.push("", `largest ${largest}:`);
  for (const file of summary.files.slice(0, largest))
    lines.push(
      `  ${kib(file.bytes).padStart(9)} raw  ${kib(file.gzipBytes).padStart(9)} gzip  ${file.name}`,
    );
  return lines.join("\n");
}

/** The chunks one rendered page preloads: every `<script src>` and `rel="modulepreload"` href,
 * resolved against the asset directory. Used by `--html`; the caller supplies the page. */
export function referencedAssets(html: string): string[] {
  const names = new Set<string>();
  for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) names.add(match[1]);
  for (const match of html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g))
    names.add(match[1]);
  for (const match of html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g))
    names.add(match[1]);
  return [...names].map((href) => href.replace(/^.*\//, ""));
}

function main(argv: readonly string[]): void {
  const flag = (name: string) => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const assets = flag("--assets") ?? join(import.meta.dir, "..", ".output", "public", "assets");
  const contents = readAssets(assets);
  const names = [...contents.keys()];
  const html = flag("--html");
  const entry =
    flag("--entry") ??
    uniqueAsset(
      names.filter((name) => name.endsWith(".js")),
      /^index-.*\.js$/,
      "entry chunk",
    );
  const css = names.find((name) => /^styles-.*\.css$/.test(name));
  const summary = summarizeBundle({ contents, entry, css });
  if (argv.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(formatSummary(summary));
  if (html !== undefined) {
    const page = referencedAssets(readFileSync(html, "utf8"));
    let raw = 0;
    let gzip = 0;
    for (const name of page) {
      const content = contents.get(name);
      if (content === undefined) continue;
      raw += content.byteLength;
      gzip += gzipSync(content, { level: 6 }).byteLength;
    }
    console.log(`\npage ${html}: ${page.length} assets, raw ${kib(raw)}, gzip ${kib(gzip)}`);
  }
}

if (import.meta.main) main(process.argv.slice(2));
