import { parse } from "@babel/parser";
import type { Expression, Node, ObjectExpression } from "@babel/types";
import { expect, test } from "bun:test";
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

/** Strip TS-only wrappers (`x as T`, `x satisfies T`, `x!`, `<T>x`); none changes the runtime value. */
function unwrap(node: Node): Node {
  switch (node.type) {
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "TSTypeAssertion":
      return unwrap(node.expression);
    default:
      return node;
  }
}

/** The literal name `a` of `a` / `"a"` as a key or member: `x.a`, `x["a"]`, `{ a }`, `{ ["a"]: … }`. */
function literalName(key: Node, computed: boolean): string | undefined {
  if (key.type === "StringLiteral") return key.value;
  if (key.type === "Identifier" && !computed) return key.name;
  return undefined;
}

function isStringBody(node: Node): boolean {
  const body = unwrap(node);
  switch (body.type) {
    case "StringLiteral":
    case "TemplateLiteral":
      return true;
    case "BinaryExpression":
      return body.operator === "+" && (isStringBody(body.left) || isStringBody(body.right));
    case "CallExpression": {
      const callee = unwrap(body.callee);
      if (callee.type === "Identifier") return callee.name === "String";
      return (
        callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        callee.object.name === "JSON" &&
        literalName(callee.property, callee.computed) === "stringify"
      );
    }
    default:
      return false;
  }
}

function keyOf(entry: ObjectExpression["properties"][number]): string | undefined {
  return entry.type === "ObjectProperty" ? literalName(entry.key, entry.computed) : undefined;
}

/** True only when `init` is an object literal whose inline `headers` object names `content-type`. */
function declaresContentType(init: Node | undefined): boolean {
  const options = init && unwrap(init);
  if (options?.type !== "ObjectExpression") return false;
  const headers = options.properties.find((entry) => keyOf(entry) === "headers");
  if (headers?.type !== "ObjectProperty") return false;
  const values = unwrap(headers.value);
  if (values.type !== "ObjectExpression") return false;
  return values.properties.some((entry) => keyOf(entry)?.toLowerCase() === "content-type");
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

/** `file:line` of every string-bodied `new Response(` that leaves its content-type to Bun. */
function untypedStringResponses(files: Record<string, string>): string[] {
  return Object.entries(files).flatMap(([file, source]) => {
    // A file without the word `Response` cannot hold an `Identifier(Response)` callee, however the
    // call is spaced, commented or parenthesised; skipping it only saves the parse.
    if (!/\bResponse\b/.test(source)) return [];
    const ast = parse(source, {
      sourceType: "module",
      plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
    });
    const found: string[] = [];
    for (const node of nodes(ast.program)) {
      if (node.type !== "NewExpression") continue;
      const callee = unwrap(node.callee);
      if (callee.type !== "Identifier" || callee.name !== "Response") continue;
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

async function webSources(): Promise<Record<string, string>> {
  const files = SCANNED.flatMap((pattern) => [...new Bun.Glob(pattern).scanSync({ cwd: repoRoot })])
    .filter((file) => !file.includes("node_modules") && !/\.test\.tsx?$/.test(file))
    .sort();
  const sources = await Promise.all(files.map((file) => Bun.file(join(repoRoot, file)).text()));
  return Object.fromEntries(files.map((file, index) => [file, sources[index]]));
}

test("no web source sends a string-bodied Response without declaring its content-type", async () => {
  expect(untypedStringResponses(await webSources())).toEqual([]);
});

test("the scan reads the web sources, so an empty result above is not a broken glob", async () => {
  const sources = await webSources();
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
    "type-assertion.ts": 'new Response(<string>"ok");',
    "commented-callee.ts": 'new /* why */ Response("ok");',
    "parenthesized-callee.ts": 'new (Response)("ok");',
    "cast-callee.ts": 'new (Response as typeof globalThis.Response)("ok");',
    "computed-json-stringify.ts": 'new Response(JSON["stringify"]({ ok: true }));',
    "cast-string-call.ts": "new Response((String as (v: unknown) => string)(count));",
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
    "cast-init.ts":
      'new Response("ok", { headers: { "content-type": "text/plain" } } as ResponseInit);',
    "cast-headers.ts":
      'new Response("ok", { headers: { "content-type": "text/plain" } satisfies HeadersInit });',
    "computed-variable-stringify.ts": "new Response(JSON[stringify](value));",
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
