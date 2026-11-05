import { expect, test } from "bun:test";
import { dirname, resolve, sep } from "node:path";

const web = resolve(import.meta.dir, "..");
const artifacts = resolve(web, "src/server/artifacts");

/** The module's public entries: the only specifiers code outside `src/server/artifacts/` may
 * import (task #542). Everything else in the directory is internal — composition wires it, the
 * entries expose it. */
const PUBLIC_ENTRIES = new Set([
  "artifact-access.server",
  "artifact-blob-sweep.server",
  "artifact-composition.server",
  "agent-artifacts.server",
  "artifact-sandbox-config.server",
  "artifact-sandbox-http.server",
]);

// Scan specifiers before transpilation so type-only imports and re-exports count too. Tests are
// exempt: they verify the internals directly.
test("only the artifacts module's public entries are imported from outside", async () => {
  const violations: string[] = [];
  const paths = await Array.fromAsync(new Bun.Glob("src/**/*.{ts,tsx}").scan(web));
  for (const path of paths) {
    const absolute = resolve(web, path);
    if (absolute === artifacts || absolute.startsWith(artifacts + sep)) continue;
    const source = await Bun.file(absolute).text();
    const imports = /\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["']([^"']+)["']/g;
    for (const match of source.matchAll(imports)) {
      const specifier = match[1]!;
      const target = specifier.startsWith("#src/server/artifacts/")
        ? resolve(web, "src", specifier.slice(5))
        : specifier.startsWith(".")
          ? resolve(dirname(absolute), specifier)
          : undefined;
      if (!target || target === artifacts || !target.startsWith(artifacts + sep)) continue;
      const entry = target.slice(artifacts.length + 1).replace(/\.(ts|tsx)$/, "");
      if (!PUBLIC_ENTRIES.has(entry)) violations.push(`${path}: ${specifier}`);
    }
  }
  expect(violations, "Import artifacts through its public entries only").toEqual([]);
});

// The artifacts module's one conversation seam is `channel-read-access.server.ts`: home
// access and target lookups go through it, never the conversation tables or their predicates.
test("the artifacts module reaches conversations only through channel-read-access", async () => {
  const violations: string[] = [];
  const conversations = resolve(web, "src/server/conversations");
  for await (const path of new Bun.Glob("src/server/artifacts/**/*.ts").scan(web)) {
    const absolute = resolve(web, path);
    const source = await Bun.file(absolute).text();
    const imports = /\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["']([^"']+)["']/g;
    for (const match of source.matchAll(imports)) {
      const specifier = match[1]!;
      const target = specifier.startsWith("#src/server/conversations/")
        ? resolve(web, "src", specifier.slice(5))
        : specifier.startsWith(".")
          ? resolve(dirname(absolute), specifier)
          : undefined;
      if (
        target &&
        target.startsWith(conversations + sep) &&
        target !== resolve(conversations, "channel-read-access.server")
      )
        violations.push(`${path}: ${specifier}`);
    }
  }
  expect(violations, "Ask conversations through channel-read-access.server only").toEqual([]);
});
