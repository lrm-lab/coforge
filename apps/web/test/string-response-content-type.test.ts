import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Bun does not put the implicit `text/plain` of a string body into `new Response("…").headers`
// (oven-sh/bun#17085 / #8530, fix pending in oven-sh/bun#33677). Start's response handling re-wraps
// every response as `new Response(response.body, response)`; the body is then a stream, so Bun
// sends `application/octet-stream` — which is how `/health` and every Agent API 401 lost their type
// in the TanStack Start upgrade (#204). A string body therefore has to name its type up front:
// `textResponse()` from `src/server/http/text-response.server.ts`, `Response.json()`, or an inline
// `content-type` header on the same call.
//
// The scan is syntactic: it catches string literals, templates, `+` concatenations and
// `JSON.stringify(…)` / `String(…)` passed straight to `new Response(`. A string held in a variable
// is out of its reach, which is what the helper is for.
const repoRoot = join(import.meta.dir, "..", "..", "..");
const SCANNED = ["apps/web/src/**/*.ts", "apps/web/src/**/*.tsx"];
const constructor = /\bnew Response\(/g;
const stringBody = /^\s*(?:["'`]|JSON\.stringify\(|String\()/;
const contentTypeKey = /["']?content-type["']?\s*:/i;

/** The argument list of the call whose `(` ends at `open`, skipping parens inside strings. */
function argumentsOf(source: string, open: number): string {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      for (index++; index < source.length && source[index] !== char; index++) {
        if (source[index] === "\\") index++;
      }
    } else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return source.slice(open + 1, index);
  }
  throw new Error(`unbalanced new Response( at offset ${open}`);
}

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

/** `file:line` of every string-bodied `new Response(` that leaves its content-type to Bun. */
function untypedStringResponses(files: Record<string, string>): string[] {
  return Object.entries(files).flatMap(([file, source]) =>
    [...source.matchAll(constructor)]
      .map((match) => ({
        offset: match.index,
        args: argumentsOf(source, match.index + match[0].length - 1),
      }))
      .filter(({ args }) => stringBody.test(args) && !contentTypeKey.test(args))
      .map(({ offset }) => `${file}:${lineOf(source, offset)}`),
  );
}

function webSources(): Record<string, string> {
  const files = SCANNED.flatMap((pattern) => [...new Bun.Glob(pattern).scanSync({ cwd: repoRoot })])
    .filter((file) => !file.includes("node_modules") && !/\.test\.tsx?$/.test(file))
    .sort();
  return Object.fromEntries(
    files.map((file) => [file, readFileSync(join(repoRoot, file), "utf8")]),
  );
}

test("no web source sends a string-bodied Response without declaring its content-type", () => {
  expect(untypedStringResponses(webSources())).toEqual([]);
});

test("the scan reads the web sources, so an empty result above is not a broken glob", () => {
  expect(Object.keys(webSources())).toContain("apps/web/src/server/http/text-response.server.ts");
});

test("the scan flags each untyped string body and accepts typed or non-string ones", () => {
  const flagged = {
    "literal.ts": 'return new Response("ok");',
    "single.ts": "return new Response('ok', { status: 401 });",
    "template.ts": "return new Response(`missing ${name} (id)`, { status: 404 });",
    "concat.ts": 'return new Response(\n  "a" +\n    "b",\n  { status: 503 },\n);',
    "json.ts": "return new Response(JSON.stringify({ ok: true }), { status: 200 });",
    "string.ts": "return new Response(String(count));",
    "other-header.ts": 'return new Response("ok", { headers: { "cache-control": "no-store" } });',
    "lookalike.ts":
      'return new Response("ok", { headers: { "x-content-type-options": "nosniff" } });',
  };
  const accepted = {
    "typed.ts": 'return new Response("ok", { headers: { "content-type": "text/plain" } });',
    "typed-caps.ts": 'return new Response("x", { headers: { "Content-Type": "text/csv" } });',
    "typed-json.ts":
      'return new Response(JSON.stringify(b), {\n  headers: { "content-type": "application/json" },\n});',
    "paren-in-string.ts":
      'return new Response("a)", { headers: { "content-type": "text/plain" } });',
    "escaped-quote.ts":
      'return new Response("a\\")", { headers: { "content-type": "text/plain" } });',
    "stream.ts": "return new Response(file.body, { headers: imageHeaders(type) });",
    "empty.ts": "return new Response(null, { status: 204 });",
    "helper.ts": 'return textResponse("ok", { status: 401 });',
  };
  expect(untypedStringResponses(flagged)).toEqual(Object.keys(flagged).map((file) => `${file}:1`));
  expect(untypedStringResponses(accepted)).toEqual([]);
});
