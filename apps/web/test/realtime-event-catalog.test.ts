import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";

const catalog = readFileSync(new URL("../../../docs/realtime-events.md", import.meta.url), "utf8");
const listed = new Set(
  [...catalog.matchAll(/\| `([a-z][a-z0-9.-]*\.v1)` \|/g)].map((match) => match[1]!),
);
const registered = Object.values(REALTIME_EVENTS);

test("every registered realtime event is in the catalog", () => {
  expect(registered.filter((event) => !listed.has(event))).toEqual([]);
});

test("the catalog names no event outside the registry", () => {
  expect([...listed].filter((event) => !registered.includes(event as never))).toEqual([]);
});
