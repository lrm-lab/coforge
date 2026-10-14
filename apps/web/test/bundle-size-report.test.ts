import { expect, test } from "bun:test";
import {
  formatSummary,
  referencedAssets,
  staticClosureOf,
  staticImportsOf,
  summarizeBundle,
  uniqueAsset,
} from "../scripts/bundle-size-report";

test("staticImportsOf reads the two static import shapes a built chunk uses", () => {
  const source = [
    'import{r as e}from"./vendor-react-DSXBqanM.js";',
    'import"./styles-side-effect.js";',
    "export{a}from'./named-export.js';",
  ].join("\n");
  expect(staticImportsOf(source)).toEqual(["vendor-react-DSXBqanM.js", "styles-side-effect.js"]);
});

test("staticImportsOf ignores dynamic imports and preload lists", () => {
  const source = [
    'const map=["./lazy-page-A.js","./lazy-page-B.js"];',
    'import("./lazy-page-C.js");',
    'const later=()=>import("./lazy-page-D.js");',
  ].join("\n");
  expect(staticImportsOf(source)).toEqual([]);
});

test("staticClosureOf follows the closure transitively and survives a cycle", () => {
  const contents = new Map([
    ["index-aaa.js", 'import"./a.js";import"./b.js";'],
    ["a.js", 'import"./b.js";'],
    ["b.js", 'import"./index-aaa.js";'],
    ["orphan.js", ""],
  ]);
  expect(staticClosureOf(contents, "index-aaa.js").sort()).toEqual([
    "a.js",
    "b.js",
    "index-aaa.js",
  ]);
});

test("staticClosureOf keeps the entry first and skips names the build did not emit", () => {
  const contents = new Map([
    ["index-aaa.js", 'import"./missing.js";import"./a.js";'],
    ["a.js", ""],
  ]);
  expect(staticClosureOf(contents, "index-aaa.js")).toEqual(["index-aaa.js", "a.js"]);
});

test("summarizeBundle counts the closure plus the entry stylesheet", () => {
  const entrySource = Buffer.from('import"./a.js";');
  const contents = new Map([
    ["index-aaa.js", entrySource],
    ["a.js", Buffer.from("x".repeat(4096))],
    ["styles-bbb.css", Buffer.from("y".repeat(1024))],
    ["lazy-page.js", Buffer.from("z".repeat(1_000_000))],
  ]);
  const summary = summarizeBundle({ contents, entry: "index-aaa.js", css: "styles-bbb.css" });
  expect(summary.files.map((file) => file.name)).toEqual(["a.js", "index-aaa.js"]);
  expect(summary.rawBytes).toBe(entrySource.byteLength + 4096);
  expect(summary.css?.bytes).toBe(1024);
  expect(summary.totalRawBytes).toBe(entrySource.byteLength + 4096 + 1024);
  expect(summary.gzipBytes).toBeLessThanOrEqual(summary.rawBytes);
});

test("formatSummary names the entry, both totals and the largest chunks", () => {
  const summary = summarizeBundle({
    contents: new Map([["index-aaa.js", Buffer.from("x".repeat(2048))]]),
    entry: "index-aaa.js",
  });
  const report = formatSummary(summary);
  expect(report).toContain("entry: index-aaa.js");
  expect(report).toContain("initial JS: 1 files");
  expect(report).toContain("index-aaa.js");
});

test("uniqueAsset refuses to guess between two candidates", () => {
  expect(uniqueAsset(["index-a.js", "vendor.js"], /^index-.*\.js$/, "entry chunk")).toBe(
    "index-a.js",
  );
  expect(() => uniqueAsset(["index-a.js", "index-b.js"], /^index-.*\.js$/, "entry chunk")).toThrow(
    "more than one entry chunk",
  );
  expect(() => uniqueAsset(["vendor.js"], /^index-.*\.js$/, "entry chunk")).toThrow(
    "no entry chunk",
  );
});

test("referencedAssets reads the page's scripts and preloads, not its data", () => {
  const html = [
    '<script type="module" src="/assets/index-aaa.js"></script>',
    '<link rel="modulepreload" href="/assets/vendor-react.js">',
    '<link rel="stylesheet" href="/assets/styles-bbb.css">',
    '<a href="/assets/not-an-asset.js">link</a>',
  ].join("\n");
  expect(referencedAssets(html)).toEqual(["index-aaa.js", "vendor-react.js", "styles-bbb.css"]);
});
