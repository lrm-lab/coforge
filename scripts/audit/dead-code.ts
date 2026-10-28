// Finds the simplification candidates the repository's own checks cannot see: source files nothing
// imports, exports nothing references, and identical function bodies kept in more than one place.
// It only reads the tree, never edits it, and every finding is a lead to confirm rather than a
// verdict: an export may be public API, a module may be an entry point, a duplicate may be
// deliberate (two providers with the same shape today).
//
// usage: bun scripts/audit/dead-code.ts [--json]
import { readFileSync } from "node:fs";

export type DeadExport = { name: string; path: string; line: number };
export type OrphanModule = { path: string; lines: number };
export type DuplicateBody = { name: string; copies: { path: string; line: number }[] };
export type AuditReport = {
  files: number;
  modules: OrphanModule[];
  exports: DeadExport[];
  duplicates: DuplicateBody[];
};

/** Paths a candidate may come from: product and package source, never tests, routes or build
 * output. A file here can still be an entry point; `isEntryPoint` decides that. */
const CANDIDATE = /^(apps\/[^/]+\/src|packages\/[^/]+\/src)\//;
const EXCLUDED =
  /(\/generated\/|\/paraglide\/|\/routes\/|\/test\/|\/fixtures\/|_pb\.tsx?$|routeTree\.gen\.tsx?$|\.d\.ts$|\.test\.tsx?$)/;
/** Files the runtime or the build starts, which nothing imports by name. */
const ENTRY =
  /(^|\/)(index|main|runner-main|cli|server|router|start)\.tsx?$|(^|\/)vite\.config\.ts$/;

export function isCandidatePath(path: string): boolean {
  return CANDIDATE.test(path) && !EXCLUDED.test(path) && !ENTRY.test(path);
}

/** The names a file exports with a value or type declaration, with their line. */
export function declaredExports(text: string): { name: string; line: number }[] {
  const declaration =
    /^export\s+(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;
  return [...text.matchAll(declaration)].map((match) => ({
    name: match[1]!,
    line: text.slice(0, match.index).split("\n").length,
  }));
}

/** The last segment of every module a file imports, which is what names that file. */
export function importedStems(text: string): string[] {
  const specifier = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;
  return [...text.matchAll(specifier)].map((match) => match[1]!.split("/").at(-1)!);
}

/** Every string literal in a file, which is how a path loaded by name (a plugin, a spawned
 * entry) appears instead of an import. */
export function stringLiterals(text: string): string[] {
  return [...text.matchAll(/["'`]([^"'`\n]{1,300})["'`]/g)].map((match) => match[1]!);
}

/** Every function declaration whose body is long enough to be worth comparing. */
export function functionBodies(text: string): { name: string; line: number; body: string }[] {
  const declaration = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  const bodies: { name: string; line: number; body: string }[] = [];
  for (const match of text.matchAll(declaration)) {
    const open = text.indexOf("{", match.index! + match[0].length);
    if (open === -1) continue;
    let depth = 0;
    let end = -1;
    for (let index = open; index < text.length; index += 1) {
      if (text[index] === "{") depth += 1;
      else if (text[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end === -1) continue;
    bodies.push({
      name: match[1]!,
      line: text.slice(0, match.index).split("\n").length,
      body: text
        .slice(open + 1, end)
        .replace(/\s+/g, " ")
        .trim(),
    });
  }
  return bodies;
}

/** Whether a file is loaded by its path in a string (a plugin the build names, a spawned entry),
 * which no import names. `apps/<app>/` or `packages/<pkg>/` is dropped before comparing, so a
 * literal may name the path from the package root. */
export function loadedByPath(path: string, literals: ReadonlySet<string>): boolean {
  const withoutExtension = path.replace(/\.tsx?$/, "");
  const tail = withoutExtension.split("/").slice(2).join("/");
  for (const literal of literals) {
    const value = literal.replace(/\.tsx?$/, "");
    if (value === withoutExtension || (tail && value.endsWith(tail))) return true;
  }
  return false;
}

const DUPLICATE_BODY_MIN_CHARS = 120;

export function analyze(files: ReadonlyMap<string, string>): AuditReport {
  const references = new Map<string, number>();
  for (const text of files.values())
    for (const token of text.matchAll(/[A-Za-z_$][\w$]*/g))
      references.set(token[0], (references.get(token[0]) ?? 0) + 1);

  const imported = new Set<string>();
  const literals = new Set<string>();
  for (const text of files.values()) {
    for (const stem of importedStems(text)) imported.add(stem);
    for (const literal of stringLiterals(text)) literals.add(literal);
  }

  const modules: OrphanModule[] = [];
  const exports: DeadExport[] = [];
  const bodies = new Map<string, { name: string; copies: { path: string; line: number }[] }>();
  for (const [path, text] of files) {
    if (!isCandidatePath(path)) continue;
    const stem = path
      .split("/")
      .at(-1)!
      .replace(/\.tsx?$/, "");
    if (!imported.has(stem) && !loadedByPath(path, literals))
      modules.push({ path, lines: text.split("\n").length });
    for (const { name, line } of declaredExports(text))
      // One occurrence is the declaration itself: nothing else names it.
      if (references.get(name) === 1) exports.push({ name, path, line });
    for (const { name, line, body } of functionBodies(text)) {
      if (body.length < DUPLICATE_BODY_MIN_CHARS) continue;
      const group = bodies.get(body) ?? { name, copies: [] };
      group.copies.push({ path, line });
      bodies.set(body, group);
    }
  }
  const duplicates = [...bodies.values()]
    .filter((group) => new Set(group.copies.map((copy) => copy.path)).size > 1)
    .sort((left, right) => right.copies.length - left.copies.length);

  return {
    files: files.size,
    modules: modules.sort((left, right) => right.lines - left.lines),
    exports: exports.sort((left, right) => left.path.localeCompare(right.path)),
    duplicates,
  };
}

export function renderMarkdown(report: AuditReport): string {
  const lines = [
    "# Dead-code audit",
    "",
    `${report.files} tracked TypeScript files read. A finding is a lead to confirm, not a verdict.`,
    "",
    `## Modules nothing imports (${report.modules.length})`,
    "",
    ...(report.modules.length
      ? report.modules.map((module) => `- \`${module.path}\` (${module.lines} lines)`)
      : ["None."]),
    "",
    `## Exports nothing references (${report.exports.length})`,
    "",
    ...(report.exports.length
      ? report.exports.map((entry) => `- \`${entry.name}\` - \`${entry.path}:${entry.line}\``)
      : ["None."]),
    "",
    `## Identical function bodies in more than one file (${report.duplicates.length})`,
    "",
    ...(report.duplicates.length
      ? report.duplicates.map(
          (duplicate) =>
            `- \`${duplicate.name}\` (${duplicate.copies.length} copies): ${duplicate.copies
              .map((copy) => `\`${copy.path}:${copy.line}\``)
              .join(", ")}`,
        )
      : ["None."]),
    "",
  ];
  return lines.join("\n");
}

/** Every tracked TypeScript file of the work tree, read once. */
export function readTrackedSources(root: string): Map<string, string> {
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", "*.ts", "*.tsx"], {
    cwd: root,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (listed.exitCode !== 0)
    throw new Error("git ls-files failed: run this from the repository root");
  const files = new Map<string, string>();
  for (const path of listed.stdout.toString().split("\0")) {
    if (!path) continue;
    files.set(path, readFileSync(`${root}/${path}`, "utf8"));
  }
  return files;
}

if (import.meta.main) {
  const report = analyze(readTrackedSources(process.cwd()));
  process.stdout.write(
    process.argv.includes("--json")
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderMarkdown(report),
  );
}
