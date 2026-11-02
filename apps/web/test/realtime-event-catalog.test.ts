import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const serverRoot = new URL("../src/server", import.meta.url).pathname;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const events = new Set<string>();
for (const file of sourceFiles(serverRoot))
  for (const match of readFileSync(file, "utf8").matchAll(/type: "([a-z][a-z0-9.-]*\.v1)"/g))
    events.add(match[1]!);

const catalog = readFileSync(new URL("../../../docs/realtime-events.md", import.meta.url), "utf8");
const listed = new Set(
  [...catalog.matchAll(/\| `([a-z][a-z0-9.-]*\.v1)` \|/g)].map((match) => match[1]!),
);

test("every server realtime event is in the catalog", () => {
  expect([...events].filter((event) => !listed.has(event))).toEqual([]);
});

test("the catalog names no event the server does not publish", () => {
  expect([...listed].filter((event) => !events.has(event))).toEqual([]);
});
