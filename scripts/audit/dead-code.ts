// Finds the simplification candidates the repository's own checks cannot see: source files nothing
// imports, exports nothing outside their own file references, and identical function bodies kept in
// more than one place. It only reads the tree, never edits it, and every finding is a lead to
// confirm rather than a verdict: an export may be public API, a module may be an entry point, a
// duplicate may be deliberate (two providers that agree today).
//
// It runs from any directory inside the work tree and always scans the whole repository. Regex
// literals with unbalanced braces are the one thing the body scanner cannot read; no such literal
// is used as a function body's only brace today.
//
// usage: bun scripts/audit/dead-code.ts [--json]
import { readFileSync } from "node:fs";

export type DeadExport = { name: string; path: string; line: number };
export type OrphanModule = { path: string; lines: number };
export type DuplicateBody = { name: string; copies: { path: string; line: number }[] };
export type AuditReport = {
  files: number;
  candidates: number;
  modules: OrphanModule[];
  exports: DeadExport[];
  duplicates: DuplicateBody[];
};

/** Paths a candidate may come from: product and package source, never tests, routes or build
 * output. A file here can still be an entry point; `isCandidatePath` decides that. */
const CANDIDATE = /^(apps\/[^/]+\/src|packages\/[^/]+\/src)\//;
const EXCLUDED =
  /(\/generated\/|\/paraglide\/|\/routes\/|\/test\/|\/fixtures\/|_pb\.tsx?$|routeTree\.gen\.tsx?$|\.d\.ts$|\.test\.tsx?$)/;
/** Files the runtime or the build starts, which nothing imports by name. */
const ENTRY =
  /(^|\/)(index|main|runner-main|cli|server|router|start)\.tsx?$|(^|\/)vite\.config\.ts$/;

export function isCandidatePath(path: string): boolean {
  return CANDIDATE.test(path) && !EXCLUDED.test(path) && !ENTRY.test(path);
}

/**
 * `text` with the contents of strings, template literals and comments replaced by spaces, keeping
 * every newline so line numbers still line up. A brace inside any of them can then not be mistaken
 * for code.
 */
export function stripNoise(text: string): string {
  const out = [...text];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"' || char === "'" || char === "`") {
      index += 1;
      while (index < text.length && text[index] !== char) {
        if (text[index] === "\\") {
          if (text[index + 1] !== "\n") out[index] = " ";
          index += 1;
        }
        if (text[index] !== "\n") out[index] = " ";
        index += 1;
      }
      if (index < text.length) {
        out[index] = " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") {
        out[index] = " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        if (text[index] !== "\n") out[index] = " ";
        index += 1;
      }
      if (index < text.length) {
        out[index] = " ";
        out[index + 1] = " ";
        index += 2;
      }
      continue;
    }
    index += 1;
  }
  return out.join("");
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** The names a file exports with a value or type declaration, with their line. */
export function declaredExports(text: string): { name: string; line: number }[] {
  const declaration =
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const\s+enum|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;
  return [...text.matchAll(declaration)].map((match) => ({
    name: match[1]!,
    line: lineOf(text, match.index!),
  }));
}

/** The last segment of every module a file imports, without its extension, which is what names
 * that file. Covers `from "…"`, `import("…")` and a bare side-effect `import "…"`. */
export function importedStems(text: string): string[] {
  const specifier = /(?:\bfrom\s+|\bimport\s*\(?\s*)["']([^"']+)["']/g;
  return [...text.matchAll(specifier)].map((match) =>
    match[1]!
      .split("/")
      .at(-1)!
      .replace(/\.tsx?$/, ""),
  );
}

/** Every string literal in a file, which is how a path loaded by name (a plugin, a spawned
 * entry) appears instead of an import. */
export function stringLiterals(text: string): string[] {
  return [...text.matchAll(/["'`]([^"'`\n]{1,300})["'`]/g)].map((match) => match[1]!);
}

/** The index of the `}` matching the `{` at `open`, in text whose strings and comments are
 * already blanked (`stripNoise`), or -1 when it never closes. */
function matchingBrace(stripped: string, open: number): number {
  let depth = 0;
  for (let index = open; index < stripped.length; index += 1) {
    if (stripped[index] === "{") depth += 1;
    else if (stripped[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Every function declaration whose body is long enough to be worth comparing. */
export function functionBodies(text: string): { name: string; line: number; body: string }[] {
  const stripped = stripNoise(text);
  const declaration = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  const bodies: { name: string; line: number; body: string }[] = [];
  for (const match of stripped.matchAll(declaration)) {
    const open = stripped.indexOf("{", match.index! + match[0].length);
    if (open === -1) continue;
    const end = matchingBrace(stripped, open);
    if (end === -1) continue;
    bodies.push({
      name: match[1]!,
      line: lineOf(text, match.index!),
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

function occurrences(text: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.match(new RegExp(`\\b${escaped}\\b`, "g"))?.length ?? 0;
}

export function analyze(files: ReadonlyMap<string, string>): AuditReport {
  const totals = new Map<string, number>();
  for (const text of files.values())
    for (const token of text.matchAll(/[A-Za-z_$][\w$]*/g))
      totals.set(token[0], (totals.get(token[0]) ?? 0) + 1);

  const imported = new Set<string>();
  const literals = new Set<string>();
  for (const text of files.values()) {
    for (const stem of importedStems(text)) imported.add(stem);
    for (const literal of stringLiterals(text)) literals.add(literal);
  }

  // A name declared in two files cancels itself out in the totals: each declaration is one
  // occurrence, and neither file's declaration is a reference to the other's.
  const declarations = new Map<string, number>();
  for (const [path, text] of files) {
    if (!isCandidatePath(path)) continue;
    for (const { name } of declaredExports(text))
      declarations.set(name, (declarations.get(name) ?? 0) + 1);
  }

  let candidates = 0;
  const modules: OrphanModule[] = [];
  const exports: DeadExport[] = [];
  const bodies = new Map<string, { name: string; copies: { path: string; line: number }[] }>();
  for (const [path, text] of files) {
    if (!isCandidatePath(path)) continue;
    candidates += 1;
    const stem = path
      .split("/")
      .at(-1)!
      .replace(/\.tsx?$/, "");
    if (!imported.has(stem) && !loadedByPath(path, literals))
      modules.push({ path, lines: text.split("\n").length });
    for (const { name, line } of declaredExports(text)) {
      // References outside the declaring file, less every other file's declaration of the name:
      // a name only its own file uses is dead as an export, and two dead twins are both dead.
      const outside = (totals.get(name) ?? 0) - occurrences(text, name);
      if (outside - ((declarations.get(name) ?? 0) - 1) <= 0) exports.push({ name, path, line });
    }
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
    candidates,
    modules: modules.sort((left, right) => right.lines - left.lines),
    exports: exports.sort((left, right) => left.path.localeCompare(right.path)),
    duplicates,
  };
}

export function renderMarkdown(report: AuditReport): string {
  const lines = [
    "# Dead-code audit",
    "",
    `${report.files} tracked TypeScript files read, ${report.candidates} of them candidate source.`,
    "A finding is a lead to confirm, not a verdict.",
    "",
    `## Modules nothing imports (${report.modules.length})`,
    "",
    ...(report.modules.length
      ? report.modules.map((module) => `- \`${module.path}\` (${module.lines} lines)`)
      : ["None."]),
    "",
    `## Exports nothing outside their own file references (${report.exports.length})`,
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

/** The work tree's top level, whatever subdirectory `cwd` is in. */
export function repositoryRoot(cwd: string): string | undefined {
  const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return undefined;
  const root = result.stdout.toString().trim();
  return root || undefined;
}

/** Every tracked TypeScript file of the work tree, read once, from its top level. */
export function readTrackedSources(root: string): Map<string, string> {
  const listed = Bun.spawnSync(
    ["git", "-C", root, "ls-files", "-z", "--full-name", "--", "*.ts", "*.tsx"],
    { cwd: root, stdout: "pipe", stderr: "ignore" },
  );
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed in ${root}`);
  const files = new Map<string, string>();
  for (const path of listed.stdout.toString().split("\0")) {
    if (!path) continue;
    files.set(path, readFileSync(`${root}/${path}`, "utf8"));
  }
  return files;
}

if (import.meta.main) {
  const root = repositoryRoot(process.cwd());
  if (!root) {
    process.stderr.write("dead-code: run this inside a git work tree\n");
    process.exit(1);
  }
  const report = analyze(readTrackedSources(root));
  if (report.candidates === 0) {
    process.stderr.write(`dead-code: no apps/*/src or packages/*/src TypeScript under ${root}\n`);
    process.exit(1);
  }
  process.stdout.write(
    process.argv.includes("--json")
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderMarkdown(report),
  );
}
