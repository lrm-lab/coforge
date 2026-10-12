import { expect, test } from "bun:test";
import {
  attributeChunk,
  decodeVlq,
  formatAttribution,
  moduleOf,
  pickChunk,
  segmentsOf,
  summarizeChunk,
} from "../scripts/bundle-attribute";

test("decodeVlq reads the magnitudes, signs and continuation groups a map uses", () => {
  expect(decodeVlq("A", 0)).toEqual({ value: 0, next: 1 });
  expect(decodeVlq("K", 0)).toEqual({ value: 5, next: 1 });
  expect(decodeVlq("C", 0)).toEqual({ value: 1, next: 1 });
  // The sign is the low bit of the final group: `D` is one, negated.
  expect(decodeVlq("D", 0)).toEqual({ value: -1, next: 1 });
  // A single group holds magnitudes up to 15 (the field is `magnitude << 1`, and five bits plus the
  // continuation bit are all a character has), so 16 is two digits: `gB` is 32 then 1, and
  // `32 + (1 << 5) >> 1` is 16. `wA` is 16 then 0, which is the same shape reading 8.
  expect(decodeVlq("gB", 0)).toEqual({ value: 16, next: 2 });
  expect(decodeVlq("wA", 0)).toEqual({ value: 8, next: 2 });
});

test("segmentsOf keeps generated order and tracks the delta fields", () => {
  // Two segments on one line: column 0 from source 0, then column 5 from source 1.
  expect(segmentsOf("AAAA,KCAA", ["a.ts", "b.ts"])).toEqual([
    { generatedLine: 0, generatedColumn: 0, source: "a.ts" },
    { generatedLine: 0, generatedColumn: 5, source: "b.ts" },
  ]);
});

test("segmentsOf carries the source delta across lines, as the format does", () => {
  // `AAAA;ACAA` — the second line starts a new generated column run but keeps the source
  // accumulator, so `ACAA` (source delta 1) is the second source, not the first.
  expect(segmentsOf("AAAA;ACAA", ["a.ts", "b.ts"])).toEqual([
    { generatedLine: 0, generatedColumn: 0, source: "a.ts" },
    { generatedLine: 1, generatedColumn: 0, source: "b.ts" },
  ]);
});

test("segmentsOf keeps a segment without a source so the following span stays anchored", () => {
  expect(segmentsOf("A,AAAA", ["a.ts"])?.length).toBe(2);
  expect(segmentsOf("A,AAAA", ["a.ts"])[0]?.source).toBe("");
});

test("attributeChunk credits each module the characters up to the next segment", () => {
  const { characters, byModule } = attributeChunk("1234567890", {
    sources: ["a.ts", "b.ts"],
    mappings: "AAAA,KCAA",
  });
  expect(characters).toBe(10);
  expect([...byModule]).toEqual([
    ["a.ts", 5],
    ["b.ts", 5],
  ]);
});

test("attributeChunk keeps the source index across lines, as the map format defines it", () => {
  // Regression: decoding each line on its own restarted the source accumulator, so every line after
  // the first was credited to the previous module. Two lines, each naming the next source, must come
  // out as one span per module — and the wrong answer here is a single module holding both spans.
  const { characters, byModule } = attributeChunk("1234567890\n1234567890", {
    sources: ["apps/web/src/a.ts", "apps/web/src/b.ts", "apps/web/src/c.ts"],
    mappings: "ACAA;ACAA",
  });
  expect(characters).toBe(20);
  expect([...byModule]).toEqual([
    ["apps/web/src/b.ts", 10],
    ["apps/web/src/c.ts", 10],
  ]);
});

test("moduleOf names the package in a bun store path, not the store", () => {
  // Bun's store: the first `node_modules/` is the store, the package is the second one.
  expect(
    moduleOf("../../../../../node_modules/.bun/zod@4.1.12/node_modules/zod/v4/core/schemas.js"),
  ).toBe("zod");
  expect(moduleOf("../../../../../node_modules/@bufbuild/protobuf/dist/esm/index.js")).toBe(
    "@bufbuild/protobuf",
  );
  expect(
    moduleOf(
      "../../../../../node_modules/.bun/@untitledui+file-icons@0.0.9/node_modules/@untitledui/file-icons/dist/aep.mjs",
    ),
  ).toBe("@untitledui/file-icons");
  expect(moduleOf("../../../../../apps/web/src/features/computers/computer-detail.tsx")).toBe(
    "apps/web/src/features/computers/computer-detail.tsx",
  );
});

test("summarizeChunk scales a module's character share by the chunk's bytes", () => {
  const summary = summarizeChunk("chunk.js", 100, {
    characters: 10,
    byModule: new Map([
      ["zod", 5],
      ["app.ts", 5],
    ]),
  });
  expect(summary.modules.map((entry) => [entry.module, entry.share, entry.bytes])).toEqual([
    ["zod", 0.5, 50],
    ["app.ts", 0.5, 50],
  ]);
});

test("summarizeChunk ranks by characters, and survives a chunk with nothing traced", () => {
  const ranked = summarizeChunk("c.js", 100, {
    characters: 10,
    byModule: new Map([
      ["small", 2],
      ["large", 8],
    ]),
  });
  expect(ranked.modules.map((entry) => entry.module)).toEqual(["large", "small"]);
  const empty = summarizeChunk("c.js", 100, { characters: 0, byModule: new Map() });
  expect(empty.modules).toEqual([]);
});

test("pickChunk takes the largest chunk by size, or the one named", () => {
  const sizes = new Map([
    ["/a/short-name.js", 7_000],
    ["/a/a-very-long-chunk-name-with-many-routes-in-it.js", 900],
  ]);
  const files = [...sizes.keys()];
  const sizeOf = (file: string) => sizes.get(file) ?? 0;
  // The name length is a red herring: the biggest chunk is the short-named one.
  expect(pickChunk(files, undefined, sizeOf)).toBe("/a/short-name.js");
  expect(pickChunk(files, "long-chunk-name", sizeOf)).toBe(files[1]);
  expect(() => pickChunk([], undefined, sizeOf)).toThrow("no client chunk found");
});

test("pickChunk refuses a name that matches nothing instead of attributing another chunk", () => {
  const files = ["/a/vendor-initial.js", "/a/vendor-tanstack.js"];
  // A typo in --chunk must not silently fall back to the largest chunk: the table would name one
  // chunk and measure another.
  expect(() => pickChunk(files, "vendor-records", () => 1)).toThrow(
    'no chunk matching "vendor-records"',
  );
});

test("formatAttribution shows the share, the bytes and where the list was cut", () => {
  const summary = summarizeChunk("c.js", 200, {
    characters: 10,
    byModule: new Map([["zod", 10]]),
  });
  const complete = formatAttribution(summary, 1);
  expect(complete).toContain("100.0%");
  expect(complete).toContain("zod");
  expect(complete).not.toContain("more");
  // With no rows the header survives and only the cut is reported, which is what makes a long
  // attribution readable in a run log.
  expect(formatAttribution(summary, 0)).toContain("… 1 more");
});
