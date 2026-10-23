import { expect, test } from "bun:test";

import { parseAgentManifest } from "./agent-manifest";
import { AGENT_MANIFEST_JSON_SCHEMA } from "./agent-manifest-json-schema";

const SCHEMA_FILE = new URL(
  "../../../../docs/agent-manifest/coforge-agent-manifest.v1.schema.json",
  import.meta.url,
);

const action = (over: Record<string, unknown> = {}) => ({
  description: "Find a note.",
  effect: "read",
  endpoint: { method: "GET", path: "/api/notes/{id}" },
  idempotency: "safe",
  required_scopes: ["notes:read"],
  input_schema: {
    type: "object",
    properties: { id: { type: "string", minLength: 1 } },
    required: ["id"],
    additionalProperties: false,
  },
  output_schema: { type: "object", properties: { title: { type: "string" } } },
  ...over,
});

const http = (over: Record<string, unknown> = {}) => ({
  schema: "coforge-agent-manifest.v1",
  name: "Acme Notes",
  description: "Team notes.",
  docs_url: "https://notes.acme.example/docs",
  app_origin: "https://notes.acme.example",
  execution: { mode: "http_api", base_url: "https://notes.acme.example/api" },
  auth: { type: "login_with_coforge" },
  actions: [{ name: "notes.get", ...action() }],
  ...over,
});

const local = (over: Record<string, unknown> = {}) => ({
  schema: "coforge-agent-manifest.v1",
  execution: { mode: "local_cli", command: "acme-notes" },
  credential_boundary: { storage: "per_agent_home", forbid_user_home: true },
  ...over,
});

function problems(value: unknown) {
  const result = parseAgentManifest(value);
  if (result.ok) throw new Error("expected problems");
  return result.problems;
}
const rejects = (value: unknown, path: string, text = "") =>
  expect(problems(value)).toContainEqual({
    path,
    message: expect.stringContaining(text),
  });
const withAction = (over: Record<string, unknown>, name = "notes.get") =>
  http({ actions: [{ name, ...action(over) }] });

test("a valid http_api manifest and a valid local_cli manifest parse", () => {
  const parsed = parseAgentManifest(http());
  expect(parsed.ok && parsed.manifest.actions[0]?.name).toBe("notes.get");
  expect(parseAgentManifest(local()).ok).toBe(true);
  expect(parseAgentManifest(http({ actions: [], auth: undefined })).ok).toBe(true);
});

test("x- keys are allowed and dropped, other unknown fields are rejected everywhere", () => {
  const ok = parseAgentManifest(
    http({ "x-note": 1, actions: [{ name: "a", ...action({ "x-y": 2 }) }] }),
  );
  expect(ok.ok && "x-note" in ok.manifest).toBe(false);
  rejects(http({ extra: 1 }), "/extra", "unknown");
  rejects(withAction({ extra: 1 }), "/actions/0/extra");
  rejects(
    withAction({ endpoint: { method: "GET", path: "/a/{id}", q: 1 } }),
    "/actions/0/endpoint/q",
  );
  rejects(http({ auth: { type: "login_with_coforge", z: 1 } }), "/auth/z");
});

test("the document must be an object with exactly the v1 schema id", () => {
  rejects([], "", "object");
  rejects(null, "", "object");
  rejects(http({ schema: "coforge-agent-manifest.v2" }), "/schema", "coforge-agent-manifest.v1");
  rejects({ ...http(), schema: undefined }, "/schema");
});

test("name, description, docs_url and app_origin are bounded and well formed", () => {
  rejects(http({ name: "x".repeat(81) }), "/name");
  rejects(http({ description: "x".repeat(501) }), "/description");
  rejects(http({ name: 5 }), "/name");
  rejects(http({ docs_url: "http://a.example/" }), "/docs_url", "https");
  rejects(http({ app_origin: "https://u:p@a.example" }), "/app_origin", "credentials");
  rejects(http({ app_origin: "https://a.example/#x" }), "/app_origin", "fragment");
  rejects(http({ app_origin: "not a url" }), "/app_origin");
});

test("execution: http_api needs a clean https base_url", () => {
  rejects(http({ execution: undefined }), "/execution");
  rejects(http({ execution: { mode: "ssh" } }), "/execution/mode");
  rejects(http({ execution: { mode: "http_api" } }), "/execution/base_url");
  for (const base_url of [
    "http://a.example/api",
    "https://a.example/api?x=1",
    "https://a.example/api#f",
    "https://u:p@a.example/api",
    "nope",
  ])
    rejects(http({ execution: { mode: "http_api", base_url } }), "/execution/base_url");
  rejects(
    http({ execution: { mode: "http_api", base_url: "https://a.example", command: "x" } }),
    "/execution/command",
  );
});

test("execution: local_cli takes a bare command, no actions, and a credential boundary", () => {
  for (const command of ["a/b", "a\\b", "a b", "a;b", "a$b", "a|b", "", "../x", "a`b"])
    rejects(local({ execution: { mode: "local_cli", command } }), "/execution/command");
  rejects(
    local({ actions: [{ name: "a", ...action() }], auth: { type: "login_with_coforge" } }),
    "/actions",
    "no actions",
  );
  expect(parseAgentManifest(local({ actions: [] })).ok).toBe(true);
  rejects(
    local({ credential_boundary: { storage: "user_home", forbid_user_home: true } }),
    "/credential_boundary/storage",
  );
  rejects(
    local({ credential_boundary: { storage: "per_agent_home", forbid_user_home: false } }),
    "/credential_boundary/forbid_user_home",
  );
  rejects(
    http({ credential_boundary: { storage: "per_agent_home", forbid_user_home: true } }),
    "/credential_boundary",
    "local_cli",
  );
});

test("actions: required for http_api, bounded, named and unique; auth is required with them", () => {
  rejects(http({ actions: undefined }), "/actions");
  rejects(http({ actions: {} }), "/actions");
  rejects(http({ auth: undefined }), "/auth", "login_with_coforge");
  rejects(http({ auth: { type: "basic" } }), "/auth/type");
  const many = Array.from({ length: 65 }, (_, i) => ({ name: `a${i}`, ...action() }));
  rejects(http({ actions: many }), "/actions", "64");
  expect(parseAgentManifest(http({ actions: many.slice(0, 64) })).ok).toBe(true);
  rejects(withAction({}, "bad name"), "/actions/0/name");
  rejects(withAction({}, "x".repeat(81)), "/actions/0/name");
  rejects(
    http({
      actions: [
        { name: "a", ...action() },
        { name: "a", ...action() },
      ],
    }),
    "/actions/1/name",
    "unique",
  );
});

test("endpoint: method and path rules", () => {
  rejects(
    withAction({ endpoint: { method: "TRACE", path: "/a/{id}" } }),
    "/actions/0/endpoint/method",
  );
  for (const path of [
    "a/{id}",
    "//x/{id}",
    "/a/../{id}",
    "/a/{id}?q=1",
    "/a/{id}#f",
    "/a/{id}/%2e%2e",
    "/a b/{id}",
    "/u@h/{id}",
  ])
    rejects(withAction({ endpoint: { method: "GET", path } }), "/actions/0/endpoint/path");
  rejects(
    withAction({ endpoint: { method: "GET", path: "/notes/{other}" } }),
    "/actions/0/endpoint/path",
    "other",
  );
});

test("every path parameter is a required scalar property of the input schema", () => {
  const input = (props: Record<string, unknown>, required: string[]) => ({
    input_schema: { type: "object", properties: props, required },
  });
  rejects(
    withAction(input({ id: { type: "string" } }, [])),
    "/actions/0/endpoint/path",
    "required",
  );
  rejects(
    withAction(input({ id: { type: "array" } }, ["id"])),
    "/actions/0/endpoint/path",
    "boolean",
  );
  expect(parseAgentManifest(withAction(input({ id: { type: "integer" } }, ["id"]))).ok).toBe(true);
});

test("effect, method and idempotency stay coherent", () => {
  rejects(withAction({ effect: "bogus" }), "/actions/0/effect");
  rejects(withAction({ idempotency: "bogus" }), "/actions/0/idempotency");
  const post = { method: "POST", path: "/notes" };
  rejects(
    withAction({ endpoint: post, effect: "read", idempotency: "safe" }),
    "/actions/0/effect",
    "GET",
  );
  rejects(withAction({ effect: "create" }), "/actions/0/effect", "GET");
  rejects(
    withAction({ effect: "read", idempotency: "idempotent" }),
    "/actions/0/idempotency",
    "safe",
  );
  rejects(
    withAction({
      endpoint: { method: "POST", path: "/n" },
      effect: "delete",
      idempotency: "idempotent",
    }),
    "/actions/0/effect",
    "DELETE",
  );
  rejects(
    withAction({ endpoint: { method: "PUT", path: "/n" }, effect: "update", idempotency: "safe" }),
    "/actions/0/idempotency",
    "safe",
  );
  const create = { endpoint: post, effect: "create", input_schema: { type: "object" } };
  expect(parseAgentManifest(withAction({ ...create, idempotency: "non_idempotent" })).ok).toBe(
    true,
  );
  rejects(withAction({ ...create, idempotency: "key_required" }), "/actions/0/idempotency_header");
  expect(
    parseAgentManifest(
      withAction({ ...create, idempotency: "key_required", idempotency_header: "Idempotency-Key" }),
    ).ok,
  ).toBe(true);
  rejects(
    withAction({ ...create, idempotency: "idempotent", idempotency_header: "Idempotency-Key" }),
    "/actions/0/idempotency_header",
  );
  rejects(
    withAction({ ...create, idempotency: "key_required", idempotency_header: "bad header" }),
    "/actions/0/idempotency_header",
  );
  expect(
    parseAgentManifest(
      withAction({
        endpoint: { method: "DELETE", path: "/n/{id}" },
        effect: "delete",
        idempotency: "idempotent",
      }),
    ).ok,
  ).toBe(true);
});

test("required_scopes are unique, sorted and bounded", () => {
  rejects(withAction({ required_scopes: ["b", "a"] }), "/actions/0/required_scopes", "sorted");
  rejects(withAction({ required_scopes: ["a", "a"] }), "/actions/0/required_scopes", "unique");
  rejects(withAction({ required_scopes: ["a b"] }), "/actions/0/required_scopes/0");
  rejects(withAction({ required_scopes: undefined }), "/actions/0/required_scopes");
  rejects(
    withAction({
      required_scopes: Array.from({ length: 65 }, (_, i) => `s${String(i).padStart(2, "0")}`),
    }),
    "/actions/0/required_scopes",
    "64",
  );
});

test("schemas accept only the JSON Schema subset", () => {
  const input = (input_schema: unknown) => withAction({ input_schema });
  rejects(input({ type: "object", $ref: "#/x" }), "/actions/0/input_schema/$ref");
  rejects(input({ type: "object", oneOf: [] }), "/actions/0/input_schema/oneOf");
  rejects(input({ type: "string" }), "/actions/0/input_schema/type", "object");
  rejects(
    input({ type: "object", additionalProperties: { type: "string" } }),
    "/actions/0/input_schema/additionalProperties",
  );
  rejects(
    input({
      type: "object",
      properties: { id: { type: "string", pattern: "(" } },
      required: ["id"],
    }),
    "/actions/0/input_schema/properties/id/pattern",
  );
  rejects(
    input({
      type: "object",
      properties: { id: { type: "string", pattern: "a".repeat(257) } },
      required: ["id"],
    }),
    "/actions/0/input_schema/properties/id/pattern",
  );
  rejects(
    input({
      type: "object",
      properties: { id: { type: "string", enum: Array.from({ length: 65 }, (_, i) => `e${i}`) } },
      required: ["id"],
    }),
    "/actions/0/input_schema/properties/id/enum",
  );
  rejects(
    input({ type: "object", properties: { id: { type: "string" } }, required: ["id", "nope"] }),
    "/actions/0/input_schema/required",
  );
  rejects(
    input({
      type: "object",
      properties: { id: { type: "string", minLength: -1 } },
      required: ["id"],
    }),
    "/actions/0/input_schema/properties/id/minLength",
  );
  rejects(withAction({ output_schema: { type: "weird" } }), "/actions/0/output_schema/type");
});

test("schema depth, node count and property count are bounded", () => {
  let deep: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < 12; i++) deep = { type: "array", items: deep };
  rejects(withAction({ output_schema: deep }), "/actions/0/output_schema", "depth");
  const wide = Object.fromEntries(
    Array.from({ length: 129 }, (_, i) => [`p${i}`, { type: "string" }]),
  );
  rejects(
    withAction({ output_schema: { type: "object", properties: wide } }),
    "/actions/0/output_schema/properties",
    "128",
  );
  const many = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [`p${i}`, { type: "string" }]),
  );
  const nodes = {
    type: "object",
    properties: {
      a: { type: "object", properties: many },
      b: { type: "object", properties: many },
      c: { type: "object", properties: many },
    },
  };
  rejects(withAction({ output_schema: nodes }), "/actions/0/output_schema", "nodes");
});

test("problems are bounded", () => {
  const bad = Array.from({ length: 64 }, (_, i) => ({ name: `a${i}`, bogus: 1 }));
  expect(problems(http({ actions: bad })).length).toBeLessThanOrEqual(50);
});

test("the published JSON Schema file equals the constant", async () => {
  const text = `${JSON.stringify(AGENT_MANIFEST_JSON_SCHEMA, null, 2)}\n`;
  // UPDATE_AGENT_MANIFEST_SCHEMA=1 rewrites the file; otherwise it is only compared.
  if (process.env.UPDATE_AGENT_MANIFEST_SCHEMA === "1") await Bun.write(SCHEMA_FILE, text);
  expect(await Bun.file(SCHEMA_FILE).text()).toBe(text);
});

test("idempotency_header refuses credential, hop-by-hop and CoForge headers, any case", () => {
  const create = {
    endpoint: { method: "POST", path: "/notes" },
    effect: "create",
    idempotency: "key_required",
    input_schema: { type: "object" },
  };
  for (const header of [
    "Authorization",
    "proxy-authorization",
    "COOKIE",
    "Set-Cookie",
    "Host",
    "Content-Length",
    "Transfer-Encoding",
    "Connection",
    "Upgrade",
    "TE",
    "Trailer",
    "Keep-Alive",
    "X-CoForge-Token",
    "x-coforge-anything",
  ])
    rejects(
      withAction({ ...create, idempotency_header: header }),
      "/actions/0/idempotency_header",
      "cannot carry",
    );
});

test("endpoint paths: whole-segment params, balanced braces, valid encoding, no empty segments", () => {
  for (const path of [
    "/a/{id",
    "/a/id}",
    "/a/x{id}",
    "/a/{id}y",
    "/a/{}",
    "/a/{1x}",
    "/a/{{id}}",
    "/a//{id}",
    "/a/{id}/",
    "/a/%zz/{id}",
    "/a/%2/{id}",
    "/a/%2F/{id}",
    "/a/%5c/{id}",
    "/a/%2e/{id}",
    "/a/.%2E/{id}",
  ])
    rejects(withAction({ endpoint: { method: "GET", path } }), "/actions/0/endpoint/path");
  expect(
    parseAgentManifest(withAction({ endpoint: { method: "GET", path: "/a%20b/{id}/c" } })).ok,
  ).toBe(true);
  // The base URL itself is an endpoint too.
  expect(parseAgentManifest(withAction({ endpoint: { method: "GET", path: "/" } })).ok).toBe(true);
});

test("path parameters may be string, integer, number or boolean, nothing else", () => {
  const input = (type: string) =>
    withAction({
      input_schema: { type: "object", properties: { id: { type } }, required: ["id"] },
    });
  for (const type of ["string", "integer", "number", "boolean"])
    expect(parseAgentManifest(input(type)).ok).toBe(true);
  for (const type of ["array", "object", "null"])
    rejects(input(type), "/actions/0/endpoint/path", "boolean");
});

test("a pattern must compile with the u flag and fit 256 characters; it is never executed", () => {
  const pattern = (value: string) =>
    withAction({
      input_schema: {
        type: "object",
        properties: { id: { type: "string", pattern: value } },
        required: ["id"],
      },
    });
  const at = "/actions/0/input_schema/properties/id/pattern";
  rejects(pattern("a".repeat(257)), at, "256");
  rejects(pattern("\\p{Nope}"), at, "regular expression");
  for (const descriptive of ["^[a-z0-9-]+$", "^(a+)+$", "(a)\\1", "(?=a)a", "^\\d{3}-\\d+?$"])
    expect(parseAgentManifest(pattern(descriptive)).ok).toBe(true);
});

test("schema property names cannot be __proto__, constructor or prototype", () => {
  for (const name of ["__proto__", "constructor", "prototype"]) {
    const properties = JSON.parse(`{"${name}": {"type": "string"}}`);
    rejects(
      withAction({ output_schema: { type: "object", properties } }),
      `/actions/0/output_schema/properties/${name}`,
      "reserved",
    );
  }
});
