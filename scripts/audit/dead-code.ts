// Finds the simplification candidates the repository's own checks cannot see: source files nothing
// imports, exports nothing outside their own file references, and identical function bodies kept in
// more than one place. It only reads the tree, never edits it, and every finding is a lead to
// confirm rather than a verdict: an export may be public API, a module may be an entry point, a
// duplicate may be deliberate (two providers that agree today).
//
// It runs from any directory inside the work tree and always scans the whole repository.
//
// What it can misread, and why a finding is never a removal on its own:
// - A regex literal is recognised where an expression may start (after `=`, `(`, `,`, `:`,
//   `return` and the like); a `/` after a value is read as division.
// - Function declarations and arrow functions assigned to const/let are compared; class methods
//   and object methods are not.
// - A module whose name appears in any import counts as used, so an unrelated same-named import
//   can hide it (a missed finding, never a wrong removal).
//
// usage: bun scripts/audit/dead-code.ts [--json]
import { readFileSync } from "node:fs";

export type ExportKind = "value" | "type";
export type DeadExport = {
  name: string;
  kind: ExportKind;
  path: string;
  line: number;
  /** Occurrences of the name inside its own file, the declaration included. */
  sameFileUses: number;
};
export type OrphanModule = { path: string; lines: number };
export type DuplicateBody = { name: string; copies: { path: string; line: number }[] };
export type AuditReport = {
  files: number;
  candidates: number;
  modules: OrphanModule[];
  /** Nothing outside the declaring file names it: the strongest removal candidate. */
  unused: DeadExport[];
  /** Only its own file uses it: an un-export candidate, not a deletion. */
  internal: DeadExport[];
  duplicates: DuplicateBody[];
};

/** A refusal with a message for the person running the command, never a stack trace. */
export class AuditError extends Error {}

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

/** The characters after which a `/` opens a regex rather than dividing. */
const REGEX_AFTER_CHAR = new Set("(,=:[!&|?{};+-*%~^<>".split(""));
const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "yield",
  "await",
  "delete",
  "void",
  "instanceof",
  "new",
  "do",
  "else",
  "throw",
]);

/** The index of the `/` closing the regex literal that starts at `start`, or undefined when this
 * `/` is division. Escapes and `[...]` classes are honoured; a regex cannot span a line. */
function regexEnd(text: string, start: number): number | undefined {
  let index = start + 1;
  let inClass = false;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\n") return undefined;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) return index;
    index += 1;
  }
  return undefined;
}

/**
 * `text` with the contents of strings, template literals, regex literals and comments replaced by
 * spaces, keeping every newline so line numbers still line up. A brace or a quote inside any of
 * them can then not be mistaken for code.
 */
export function stripNoise(text: string): string {
  const out = [...text];
  const blank = (from: number, to: number) => {
    for (let index = from; index < to && index < out.length; index += 1)
      if (out[index] !== "\n") out[index] = " ";
  };
  let index = 0;
  let lastChar = "";
  let lastWord = "";
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"' || char === "'" || char === "`") {
      let end = index + 1;
      while (end < text.length && text[end] !== char) end += text[end] === "\\" ? 2 : 1;
      blank(index, end + 1);
      index = end + 1;
      lastChar = char;
      lastWord = "";
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index);
      blank(index, end === -1 ? text.length : end);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      blank(index, end === -1 ? text.length : end + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    if (
      char === "/" &&
      (lastChar === "" || REGEX_AFTER_CHAR.has(lastChar) || REGEX_AFTER_WORD.has(lastWord))
    ) {
      const end = regexEnd(text, index);
      if (end !== undefined) {
        let after = end + 1;
        while (after < text.length && /[a-z]/.test(text[after]!)) after += 1;
        blank(index, after);
        index = after;
        lastChar = "/";
        lastWord = "";
        continue;
      }
    }
    if (!/\s/.test(char)) {
      if (/[A-Za-z0-9_$]/.test(char)) lastWord += char;
      else lastWord = "";
      lastChar = char;
    }
    index += 1;
  }
  return out.join("");
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** The names a file exports with a value or type declaration, with their line. */
export function declaredExports(text: string): { name: string; kind: ExportKind; line: number }[] {
  const declaration =
    /^export\s+(?:declare\s+)?(?:async\s+)?(function|const\s+enum|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;
  return [...text.matchAll(declaration)].map((match) => ({
    name: match[2]!,
    kind: match[1] === "type" || match[1] === "interface" ? "type" : "value",
    line: lineOf(text, match.index!),
  }));
}

/** The last segment of every module a file imports, without its extension, which is what names
 * that file. Covers `from "…"`, `import("…")`, a bare side-effect `import "…"` and `require("…")`. */
export function importedStems(text: string): string[] {
  const specifier = /(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
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

/** Function declarations and arrow functions assigned to const/let, with their bodies. */
export function functionBodies(text: string): { name: string; line: number; body: string }[] {
  const stripped = stripNoise(text);
  const declarations = [
    /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm,
    /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/gm,
  ];
  const bodies: { name: string; line: number; body: string }[] = [];
  for (const declaration of declarations)
    for (const match of stripped.matchAll(declaration)) {
      const open = stripped.indexOf("{", match.index! + match[0].length - 1);
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
  const unused: DeadExport[] = [];
  const internal: DeadExport[] = [];
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
    for (const { name, kind, line } of declaredExports(text)) {
      // References outside the declaring file, less every other file's declaration of the name:
      // a name only its own file uses is not dead code, but it is dead as an export.
      const sameFileUses = occurrences(text, name);
      const outside = (totals.get(name) ?? 0) - sameFileUses;
      if (outside - ((declarations.get(name) ?? 0) - 1) > 0) continue;
      (sameFileUses === 1 ? unused : internal).push({ name, kind, path, line, sameFileUses });
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

  const byPlace = (left: DeadExport, right: DeadExport) =>
    left.path.localeCompare(right.path) || left.line - right.line;
  return {
    files: files.size,
    candidates,
    modules: modules.sort((left, right) => right.lines - left.lines),
    unused: unused.sort(byPlace),
    internal: internal.sort(byPlace),
    duplicates,
  };
}

function exportLine(entry: DeadExport): string {
  const kind = entry.kind === "type" ? " (type)" : "";
  return `- \`${entry.name}\`${kind} - \`${entry.path}:${entry.line}\``;
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
    `## Exports nothing references anywhere (${report.unused.length})`,
    "",
    ...(report.unused.length ? report.unused.map(exportLine) : ["None."]),
    "",
    `## Exports only their own file uses (${report.internal.length})`,
    "",
    "An un-export candidate: the declaration stays, the `export` may go.",
    "",
    ...(report.internal.length ? report.internal.map(exportLine) : ["None."]),
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
export function repositoryRoot(cwd: string): string {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    throw new AuditError("git is not on PATH");
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim();
    throw new AuditError(
      detail.includes("not a git repository")
        ? "run this inside a git work tree"
        : `git rev-parse failed: ${detail || "unknown error"}`,
    );
  }
  const root = result.stdout.toString().trim();
  if (!root) throw new AuditError("git rev-parse named no work tree");
  return root;
}

/** Every tracked TypeScript file of the work tree, read once, from its top level. */
export function readTrackedSources(root: string): Map<string, string> {
  const listed = Bun.spawnSync(
    ["git", "-C", root, "ls-files", "-z", "--full-name", "--", "*.ts", "*.tsx"],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (listed.exitCode !== 0)
    throw new AuditError(
      `git ls-files failed in ${root}: ${listed.stderr.toString().trim() || "unknown error"}`,
    );
  const files = new Map<string, string>();
  for (const path of listed.stdout.toString().split("\0")) {
    if (!path) continue;
    files.set(path, readFileSync(`${root}/${path}`, "utf8"));
  }
  return files;
}

if (import.meta.main) {
  try {
    const report = analyze(readTrackedSources(repositoryRoot(process.cwd())));
    if (report.candidates === 0)
      throw new AuditError("no apps/*/src or packages/*/src TypeScript in this work tree");
    process.stdout.write(
      process.argv.includes("--json")
        ? `${JSON.stringify(report, null, 2)}\n`
        : renderMarkdown(report),
    );
  } catch (error) {
    process.stderr.write(
      `dead-code: ${error instanceof AuditError ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
