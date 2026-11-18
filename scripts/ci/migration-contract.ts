import { type ChangeSource, diffArgs, git } from "../git-hooks/staged-file-size";
import { keyword, splitStatements, type Token } from "../migration-safety/tokenize";

function resultRevision(source: ChangeSource): string {
  return source.kind === "staged" ? ":0" : source.head;
}

function readFiles(revision: string, paths: string[]): Map<string, string> {
  const contents = new Map<string, string>();
  for (const path of paths) {
    const out = Bun.spawnSync(["git", "show", `${revision}:${path}`], { stderr: "ignore" });
    if (out.exitCode === 0) contents.set(path, out.stdout.toString());
  }
  return contents;
}

export const MIGRATION_CONTRACT_FIX =
  "A migration drops a table, column, or constraint that origin/main (or this change) still references in Prisma schema or source code. Stop reading/declaring it in an earlier release first, then split the DROP into the next release (拆到下一个版本).";

export type DropTarget =
  | { kind: "table"; table: string; line: number }
  | { kind: "column"; table: string; column: string; line: number }
  | { kind: "constraint"; table: string; constraint: string; line: number };

export type PrismaModelInfo = {
  modelName: string;
  tableName: string;
  fields: Array<{ name: string; columnName: string }>;
  constraintMaps: string[];
};

const MIGRATION_PATH = /^apps\/web\/prisma\/migrations\/([^/]+)\/migration\.sql$/;
const PRISMA_PATH = /^apps\/web\/prisma\/(?:schema\.prisma|models\/[^/]+\.prisma)$/;
const SOURCE_PATH = /^(?:apps\/web\/src|packages\/[^/]+\/src)\/.*\.(?:ts|tsx|mts|cts)$/;
const EXCLUDED_SOURCE =
  /(?:^|\/)(?:generated|test|__tests__)\/|\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/;

function unquotedName(token: Token | undefined): string | undefined {
  if (!token || (token.kind !== "word" && token.kind !== "ident")) return undefined;
  return token.kind === "word" ? token.text.toLowerCase() : token.text;
}

function readQualifiedName(tokens: Token[], index: number): { name?: string; next: number } {
  const first = unquotedName(tokens[index]);
  if (!first) return { next: index };
  if (tokens[index + 1]?.kind === "punct" && tokens[index + 1]?.text === ".") {
    const second = unquotedName(tokens[index + 2]);
    return { name: second ?? first, next: index + (second ? 3 : 2) };
  }
  return { name: first, next: index + 1 };
}

function skipIfExists(tokens: Token[], index: number): number {
  if (keyword(tokens[index]) === "IF" && keyword(tokens[index + 1]) === "EXISTS") {
    return index + 2;
  }
  return index;
}

export function extractDrops(sql: string): DropTarget[] {
  const drops: DropTarget[] = [];
  for (const statement of splitStatements(sql)) {
    const tokens = statement.tokens;
    const first = keyword(tokens[0]);
    const second = keyword(tokens[1]);
    if (first === "DROP" && second === "TABLE") {
      const idx = skipIfExists(tokens, 2);
      const { name } = readQualifiedName(tokens, idx);
      if (name) drops.push({ kind: "table", table: name, line: statement.line });
      continue;
    }
    if (first === "ALTER" && second === "TABLE") {
      let idx = skipIfExists(tokens, 2);
      const { name: table, next } = readQualifiedName(tokens, idx);
      if (!table) continue;
      idx = next;
      while (idx < tokens.length) {
        if (keyword(tokens[idx]) === "DROP") {
          const what = keyword(tokens[idx + 1]);
          if (what === "CONSTRAINT") {
            const nameIdx = skipIfExists(tokens, idx + 2);
            const constraint = unquotedName(tokens[nameIdx]);
            if (constraint) {
              drops.push({ kind: "constraint", table, constraint, line: statement.line });
            }
            idx = nameIdx + 1;
            continue;
          }
          let colIdx = what === "COLUMN" ? idx + 2 : idx + 1;
          if (what !== "CONSTRAINT" && what !== "INDEX") {
            colIdx = skipIfExists(tokens, colIdx);
            const column = unquotedName(tokens[colIdx]);
            if (column) {
              drops.push({ kind: "column", table, column, line: statement.line });
            }
            idx = colIdx + 1;
            continue;
          }
        }
        idx++;
      }
    }
  }
  return drops;
}

export function parsePrismaSchemaModels(schemaFiles: Map<string, string>): PrismaModelInfo[] {
  const models: PrismaModelInfo[] = [];
  for (const text of schemaFiles.values()) {
    const lines = text.split(/\r?\n/);
    let current: PrismaModelInfo | null = null;
    for (const rawLine of lines) {
      const line = rawLine.replace(/\/\/.*$/, "").trim();
      if (!line) continue;
      const modelMatch = /^model\s+(\w+)\s*\{/.exec(line);
      if (modelMatch) {
        current = {
          modelName: modelMatch[1]!,
          tableName: modelMatch[1]!,
          fields: [],
          constraintMaps: [],
        };
        continue;
      }
      if (!current) continue;
      if (line.startsWith("}")) {
        models.push(current);
        current = null;
        continue;
      }
      const tableMap = /^@@map\(\s*"([^"]+)"\s*\)/.exec(line);
      if (tableMap) {
        current.tableName = tableMap[1]!;
        continue;
      }
      for (const mapMatch of line.matchAll(/\bmap:\s*"([^"]+)"/g)) {
        current.constraintMaps.push(mapMatch[1]!);
      }
      if (!line.startsWith("@@")) {
        const fieldMatch = /^(\w+)\s+\S/.exec(line);
        if (fieldMatch) {
          const fieldName = fieldMatch[1]!;
          const colMap = /@map\(\s*"([^"]+)"\s*\)/.exec(line);
          current.fields.push({ name: fieldName, columnName: colMap ? colMap[1]! : fieldName });
        }
      }
    }
  }
  return models;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function camelCase(name: string): string {
  return name.length === 0 ? name : name[0]!.toLowerCase() + name.slice(1);
}

function sameIdentifier(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function findContractViolationsInSnapshot(
  drops: Array<{ file: string; drop: DropTarget }>,
  revisionLabel: string,
  prismaFiles: Map<string, string>,
  sourceFiles: Map<string, string>,
): Array<{ location: string; found: string }> {
  if (drops.length === 0) return [];
  const models = parsePrismaSchemaModels(prismaFiles);
  const violations: Array<{ location: string; found: string }> = [];

  for (const { file, drop } of drops) {
    const matchingModels = models.filter((m) => sameIdentifier(m.tableName, drop.table));
    if (drop.kind === "table") {
      if (matchingModels.length > 0) {
        violations.push({
          location: `${file}:${drop.line}`,
          found: `DROP TABLE "${drop.table}" while ${revisionLabel} Prisma model ${matchingModels[0]!.modelName} still maps to it`,
        });
        continue;
      }
      const tablePattern = new RegExp(`["'\`\\b]${escapeRegex(drop.table)}["'\`\\b]`);
      for (const [srcPath, content] of sourceFiles) {
        if (tablePattern.test(content)) {
          violations.push({
            location: `${file}:${drop.line}`,
            found: `DROP TABLE "${drop.table}" while ${revisionLabel} code (${srcPath}) still references "${drop.table}"`,
          });
          break;
        }
      }
      continue;
    }

    if (drop.kind === "column") {
      const matchingFields = matchingModels.flatMap((m) =>
        m.fields
          .filter((f) => sameIdentifier(f.columnName, drop.column))
          .map((f) => ({ model: m, field: f })),
      );
      if (matchingFields.length > 0) {
        const { model, field } = matchingFields[0]!;
        violations.push({
          location: `${file}:${drop.line}`,
          found: `DROP COLUMN "${drop.table}"."${drop.column}" while ${revisionLabel} Prisma model ${model.modelName}.${field.name} still maps to it`,
        });
        continue;
      }
      const contextPatterns = [
        new RegExp(`["'\`\\b]${escapeRegex(drop.table)}["'\`\\b]`),
        ...matchingModels.map((m) => new RegExp(`\\b${escapeRegex(camelCase(m.modelName))}\\b`)),
        ...matchingModels.map((m) => new RegExp(`\\b${escapeRegex(m.modelName)}\\b`)),
      ];
      const colPattern = new RegExp(`\\b${escapeRegex(drop.column)}\\b`);
      for (const [srcPath, content] of sourceFiles) {
        if (contextPatterns.some((re) => re.test(content)) && colPattern.test(content)) {
          violations.push({
            location: `${file}:${drop.line}`,
            found: `DROP COLUMN "${drop.table}"."${drop.column}" while ${revisionLabel} code (${srcPath}) still references it`,
          });
          break;
        }
      }
      continue;
    }

    if (drop.kind === "constraint") {
      if (models.some((m) => m.constraintMaps.some((c) => sameIdentifier(c, drop.constraint)))) {
        violations.push({
          location: `${file}:${drop.line}`,
          found: `DROP CONSTRAINT "${drop.constraint}" while ${revisionLabel} Prisma schema still declares it`,
        });
        continue;
      }
      const constraintPattern = new RegExp(`["'\`]${escapeRegex(drop.constraint)}["'\`]`);
      for (const [srcPath, content] of sourceFiles) {
        if (constraintPattern.test(content)) {
          violations.push({
            location: `${file}:${drop.line}`,
            found: `DROP CONSTRAINT "${drop.constraint}" while ${revisionLabel} code (${srcPath}) still references it`,
          });
          break;
        }
      }
    }
  }

  return violations;
}

function addedMigrations(source: ChangeSource): string[] {
  const fields = git(diffArgs(source, "--name-status", "-z", "--no-renames", "--diff-filter=A"))
    .toString()
    .split("\0");
  const added: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (MIGRATION_PATH.test(fields[i + 1]!)) added.push(fields[i + 1]!);
  }
  return added;
}

function pathsInRevision(revision: string, prefix: string[]): string[] {
  const tree =
    revision === ":0"
      ? ["ls-files", "-z", "--", ...prefix]
      : ["ls-tree", "-r", "-z", "--name-only", revision, "--", ...prefix];
  return git(tree).toString().split("\0").filter(Boolean);
}

function baseRevision(source: ChangeSource): string {
  if (source.kind === "range") return source.base;
  const hasOriginMain =
    Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", "origin/main"], {
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode === 0;
  return hasOriginMain ? "origin/main" : "HEAD";
}

export function migrationContractViolations(source: ChangeSource) {
  const added = addedMigrations(source);
  if (added.length === 0) return [];
  const resultRev = resultRevision(source);
  const drops: Array<{ file: string; drop: DropTarget }> = [];
  for (const [file, sql] of readFiles(resultRev, added)) {
    for (const drop of extractDrops(sql)) drops.push({ file, drop });
  }
  if (drops.length === 0) return [];

  const baseRev = baseRevision(source);
  const checkRevision = (revision: string, label: string) => {
    const prismaPaths = pathsInRevision(revision, ["apps/web/prisma"]).filter((p) =>
      PRISMA_PATH.test(p),
    );
    const sourcePaths = pathsInRevision(revision, ["apps/web/src", "packages"]).filter(
      (p) => SOURCE_PATH.test(p) && !EXCLUDED_SOURCE.test(p),
    );
    return findContractViolationsInSnapshot(
      drops,
      label,
      readFiles(revision, prismaPaths),
      readFiles(revision, sourcePaths),
    );
  };

  return [
    ...checkRevision(baseRev, "base (origin/main)"),
    ...checkRevision(resultRev, "current"),
  ].map((v) => ({ rule: "migration-contract" as const, ...v }));
}
