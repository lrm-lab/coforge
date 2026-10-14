import { parse } from "@babel/parser";
import type { Expression, Node, ObjectExpression } from "@babel/types";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Bun does not put the implicit `text/plain` of a string body into `new Response("…").headers`
// (oven-sh/bun#17085 / #8530, fix pending in oven-sh/bun#33677). Start's response handling re-wraps
// every response as `new Response(response.body, response)`; the body is then a stream, so Bun
// sends `application/octet-stream` — which is how `/health` and every Agent API 401 lost their type
// in the TanStack Start upgrade (#204). A string body therefore has to name its type up front:
// `textResponse()` from `src/server/http/text-response.server.ts`, `Response.json()`, or a
// `content-type` key in an inline `headers` object of the same call.
//
// The scan works on the parsed syntax tree, so comments and string contents are never mistaken for
// calls or headers. A body counts as a string when it is a string literal, a template, a `+` with a
// string-typed side, or a `JSON.stringify(…)` / `String(…)` call. A string held in a variable is out
// of a syntactic scan's reach, which is what the helper is for.

function isStringBody(node: Node): boolean {
  switch (node.type) {
    case "StringLiteral":
    case "TemplateLiteral":
      return true;
    case "BinaryExpression":
      return node.operator === "+" && (isStringBody(node.left) || isStringBody(node.right));
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
      return isStringBody(node.expression);
    case "CallExpression": {
      const { callee } = node;
      if (callee.type === "Identifier") return callee.name === "String";
      return (
        callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        callee.object.name === "JSON" &&
        callee.property.type === "Identifier" &&
        callee.property.name === "stringify"
      );
    }
    default:
      return false;
  }
}

/** The literal key of an object-literal entry: `a` and `"a"` and `["a"]`, but not `[a]` or a spread. */
function keyOf(entry: ObjectExpression["properties"][number]): string | undefined {
  if (entry.type !== "ObjectProperty") return undefined;
  if (entry.key.type === "StringLiteral") return entry.key.value;
  if (entry.key.type === "Identifier" && !entry.computed) return entry.key.name;
  return undefined;
}

/** True only when `init` is an object literal whose inline `headers` object names `content-type`. */
function declaresContentType(init: Node | undefined): boolean {
  if (init?.type !== "ObjectExpression") return false;
  const headers = init.properties.find((entry) => keyOf(entry) === "headers");
  if (headers?.type !== "ObjectProperty" || headers.value.type !== "ObjectExpression") return false;
  return headers.value.properties.some((entry) => keyOf(entry)?.toLowerCase() === "content-type");
}

function* nodes(node: unknown): Generator<Node> {
  if (Array.isArray(node)) {
    for (const child of node) yield* nodes(child);
    return;
  }
  if (typeof node !== "object" || node === null || typeof (node as Node).type !== "string") return;
  yield node as Node;
  for (const value of Object.values(node)) yield* nodes(value);
}

const mentionsConstructor = /\bnew\s+Response\b/;

/** `file:line` of every string-bodied `new Response(` that leaves its content-type to Bun. */
function untypedStringResponses(files: Record<string, string>): string[] {
  return Object.entries(files).flatMap(([file, source]) => {
    // Only a file that spells the constructor can contain the call; parsing the rest is waste.
    if (!mentionsConstructor.test(source)) return [];
    const ast = parse(source, {
      sourceType: "module",
      plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
    });
    const found: string[] = [];
    for (const node of nodes(ast.program)) {
      if (node.type !== "NewExpression") continue;
      if (node.callee.type !== "Identifier" || node.callee.name !== "Response") continue;
      const [body, init] = node.arguments;
      if (body && isStringBody(body as Expression) && !declaresContentType(init)) {
        found.push(`${file}:${node.loc?.start.line}`);
      }
    }
    return found;
  });
}

const repoRoot = join(import.meta.dir, "..", "..", "..");
const SCANNED = ["apps/web/src/**/*.ts", "apps/web/src/**/*.tsx"];

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
  const sources = webSources();
  expect(Object.keys(sources)).toContain("apps/web/src/server/http/text-response.server.ts");
  // The one inline-typed string body in the tree today, so the accepting branch is live too.
  expect(sources["apps/web/src/server/centrifugo/rpc-handler.server.ts"]).toContain(
    "new Response(JSON.stringify(body)",
  );
});

test("the scan flags each untyped string body", () => {
  const flagged = {
    "literal.ts": 'new Response("ok");',
    "single.ts": "new Response('ok', { status: 401 });",
    "template.ts": "new Response(`missing ${name} (id)`, { status: 404 });",
    "concat.ts": 'new Response(\n  "a" +\n    "b",\n  { status: 503 },\n);',
    "concat-identifier-first.ts": 'new Response(code + ": bad", { status: 400 });',
    "concat-literal-first.ts": 'new Response("bad: " + code, { status: 400 });',
    "concat-nested.ts": 'new Response(a + (b + "!"));',
    "cast.ts": 'new Response(("ok" as string));',
    "json.ts": "new Response(JSON.stringify({ ok: true }), { status: 200 });",
    "string.ts": "new Response(String(count));",
    "spaced.ts": 'new  Response ("ok");',
    // Header-looking text in the body is payload, not a declared header.
    "body-mentions-header.ts": 'new Response("content-type: unavailable");',
    "json-body-has-key.ts": 'new Response(JSON.stringify({ "content-type": "text/plain" }));',
    "other-header.ts": 'new Response("ok", { headers: { "cache-control": "no-store" } });',
    "lookalike-header.ts": 'new Response("ok", { headers: { "x-content-type": "text/plain" } });',
    "content-type-outside-headers.ts": 'new Response("ok", { "content-type": "text/plain" });',
    "headers-not-literal.ts": 'new Response("ok", { headers: new Headers(init) });',
    "computed-key.ts": 'new Response("ok", { headers: { [name]: "text/plain" } });',
    "computed-headers-key.ts":
      'new Response("ok", { [headers]: { "content-type": "text/plain" } });',
    "satisfies.ts": 'new Response("ok" satisfies string);',
    "non-null.ts": 'new Response("ok"!);',
    "tsx.tsx": 'const el = <div />;\nnew Response("ok");',
  };
  expect(untypedStringResponses(flagged)).toEqual(
    Object.keys(flagged).map((file) => `${file}:${file === "tsx.tsx" ? 2 : 1}`),
  );
});

test("the scan accepts typed string bodies, non-string bodies, and non-code mentions", () => {
  const accepted = {
    "typed.ts": 'new Response("ok", { headers: { "content-type": "text/plain" } });',
    "typed-caps.ts": 'new Response("x", { headers: { "Content-Type": "text/csv" } });',
    "typed-json.ts":
      'new Response(JSON.stringify(b), {\n  headers: { "content-type": "application/json" },\n});',
    "quoted-headers-key.ts": 'new Response("ok", { "headers": { "content-type": "text/plain" } });',
    "computed-literal-key.ts":
      'new Response("ok", { headers: { ["content-type"]: "text/plain" } });',
    "stream.ts": "new Response(file.body, { headers: imageHeaders(type) });",
    "other-call.ts": 'new Response(render("x"));',
    "other-stringify.ts": "new Response(serializer.stringify(document));",
    "json-parse.ts": 'new Response(JSON.parse("{}"));',
    "non-plus-operator.ts": 'new Response(flag !== "off");',
    "other-constructor.ts": 'new Request("https://example.test", { body: "ok" });',
    "variable.ts": "new Response(body);",
    "empty.ts": "new Response(null, { status: 204 });",
    "helper.ts": 'textResponse("ok", { status: 401 });',
    "json-factory.ts": "Response.json({ ok: true });",
    "line-comment.ts": '// new Response("example")\nexport {};',
    "block-comment.ts": "/* unmatched new Response( in prose */\nexport {};",
    "string-example.ts": "const doc = 'new Response(\"x\")';",
    "template-example.ts": 'const doc = `call new Response("x") here`;',
  };
  expect(untypedStringResponses(accepted)).toEqual([]);
});
