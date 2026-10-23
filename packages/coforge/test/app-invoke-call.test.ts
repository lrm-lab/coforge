import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAppTokenResponse, AgentAppView } from "@lrm/coforge-sdk/agent";
import { parseAgentManifest } from "@lrm/coforge-sdk/agent";
import { readCappedStdin } from "#src/action-input";
import { parseAppArgs, runAppCommand } from "#src/app-commands";
import type { AppClient } from "#src/app-client";
import { CliError, renderCliError } from "#src/cli-error";

const TOKEN = "hdr.payload.sig-secret";
const MANIFEST_URL = "https://notes.acme.example/.well-known/coforge-agent-manifest.json";
const APP: AgentAppView = {
  key: "acme-notes",
  name: "Acme Notes",
  description: "Notes.",
  whenToUse: "Notes.",
  homepageUrl: "https://notes.acme.example/",
  builtIn: false,
  access: "granted",
  agentManifestUrl: MANIFEST_URL,
  agentManifestUrlSource: "explicit",
};
const parsed = parseAgentManifest({
  schema: "coforge-agent-manifest.v1",
  execution: { mode: "http_api", base_url: "https://notes.acme.example/api" },
  auth: { type: "login_with_coforge" },
  actions: [
    {
      name: "notes.get",
      effect: "read",
      endpoint: { method: "GET", path: "/notes/{id}" },
      idempotency: "safe",
      required_scopes: ["email"],
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
          full: { type: "boolean" },
          score: { type: "number" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      output_schema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
    },
    {
      name: "notes.ping",
      effect: "read",
      endpoint: { method: "GET", path: "/ping" },
      idempotency: "safe",
      required_scopes: [],
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "notes.create",
      effect: "create",
      endpoint: { method: "POST", path: "/notes" },
      idempotency: "key_required",
      idempotency_header: "Idempotency-Key",
      required_scopes: ["profile"],
      input_schema: {
        type: "object",
        properties: { title: { type: "string", pattern: "^(a+)+$" }, tags: { type: "array" } },
        required: ["title"],
      },
    },
  ],
});
if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));

const MANIFEST = parsed.manifest;

type Seen = { method: string; url: URL; headers: Headers; body: string };
let handler: (request: Request) => Response | Promise<Response> = () => new Response("{}");
const seen: Seen[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    seen.push({
      method: request.method,
      url: new URL(request.url),
      headers: request.headers,
      body: await request.text(),
    });
    return handler(request);
  },
});
afterAll(() => void server.stop(true));
beforeAll(() => {
  seen.length = 0;
});

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

async function call(
  args: string[],
  respond: typeof handler = () => json({ title: "T" }),
  extra: { stdin?: string; timeoutMs?: number; token?: AgentAppTokenResponse } = {},
) {
  handler = respond;
  seen.length = 0;
  const out: string[] = [];
  const err: string[] = [];
  const tokenCalls: unknown[] = [];
  const client: AppClient = {
    appList: async () => ({ ok: true, apps: [APP] }),
    appToken: async (appKey, target, scopes) => {
      tokenCalls.push({ appKey, target, scopes });
      return (
        extra.token ?? {
          ok: true,
          status: "issued",
          access_token: TOKEN,
          token_type: "Bearer",
          expires_in: 300,
          audience: "client",
          scope: "openid profile identity email",
        }
      );
    },
  };
  let code = 0;
  try {
    code = await runAppCommand(parseAppArgs(args), client, {
      stdout: (text) => out.push(Buffer.from(text).toString()),
      stderr: (text) => err.push(Buffer.from(text).toString()),
      env: {},
      fetchManifest: async () => ({ kind: "valid", manifest: MANIFEST }),
      fetch: (input, init) =>
        fetch(input.replace("https://notes.acme.example", `http://localhost:${server.port}`), init),
      requestTimeoutMs: extra.timeoutMs,
      readStdin: async () => extra.stdin ?? "",
      readFile: async (path) => Bun.file(path).text(),
    });
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    (error.outputMode === "json" ? out : err).push(renderCliError(error));
    code = error.exitCode ?? 1;
  }
  const stdout = out.join("");
  const stderr = err.join("");
  expect(stdout + stderr).not.toContain(TOKEN);
  return { code, stdout, stderr, tokenCalls };
}
const errorCode = (result: { stdout: string }) => JSON.parse(result.stdout).error.code;

test("GET: path params are encoded, the rest is query, Bearer is sent, no redirect following", async () => {
  const result = await call([
    "invoke",
    "acme-notes",
    "notes.get",
    "--param",
    "id=a/b c",
    "--param",
    "limit=5",
    "--param",
    "full=true",
    "--json",
  ]);
  expect(result.code).toBe(0);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.method).toBe("GET");
  expect(seen[0]!.url.pathname).toBe("/api/notes/a%2Fb%20c");
  expect(seen[0]!.url.search).toBe("?limit=5&full=true");
  expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  expect(seen[0]!.headers.get("accept")).toBe("application/json");
  expect(seen[0]!.headers.get("cookie")).toBeNull();
  expect(JSON.parse(result.stdout)).toEqual({
    ok: true,
    data: { app: "acme-notes", action: "notes.get", status: 200, result: { title: "T" } },
  });
  expect(result.tokenCalls).toEqual([
    { appKey: "acme-notes", target: undefined, scopes: ["email"] },
  ]);
});

test("text output pretty-prints the result", async () => {
  const result = await call(["invoke", "acme-notes", "notes.get", "--param", "id=1"]);
  expect(result.stdout).toBe('{\n  "title": "T"\n}\n');
});

test("POST sends a JSON body, a generated idempotency key, and prints the key", async () => {
  const result = await call(
    [
      "invoke",
      "acme-notes",
      "notes.create",
      "--data-json",
      '{"title":"hi","tags":["a"]}',
      "--json",
    ],
    () => json({ id: 1 }, { status: 201 }),
  );
  expect(result.code).toBe(0);
  expect(seen[0]!.method).toBe("POST");
  expect(seen[0]!.headers.get("content-type")).toBe("application/json");
  expect(JSON.parse(seen[0]!.body)).toEqual({ title: "hi", tags: ["a"] });
  const key = seen[0]!.headers.get("idempotency-key")!;
  expect(key).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.parse(result.stdout).data).toMatchObject({ status: 201, idempotency_key: key });
});

test("--idempotency-key reuses a key; it is refused where no key is needed", async () => {
  await call([
    "invoke",
    "acme-notes",
    "notes.create",
    "--param",
    "title=x",
    "--idempotency-key",
    "my-key-1",
  ]);
  expect(seen[0]!.headers.get("idempotency-key")).toBe("my-key-1");
  const refused = await call([
    "invoke",
    "acme-notes",
    "notes.get",
    "--param",
    "id=1",
    "--idempotency-key",
    "k",
    "--json",
  ]);
  expect(errorCode(refused)).toBe("INPUT_INVALID");
  expect(seen).toHaveLength(0);
});

test("--param @file and @- read text; --data-file - reads JSON from stdin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "invoke-"));
  const file = join(dir, "title.txt");
  writeFileSync(file, "from file");
  await call(["invoke", "acme-notes", "notes.create", "--param", `title=@${file}`]);
  expect(JSON.parse(seen[0]!.body)).toEqual({ title: "from file" });
  await call(["invoke", "acme-notes", "notes.create", "--param", "title=@-"], undefined, {
    stdin: "piped",
  });
  expect(JSON.parse(seen[0]!.body)).toEqual({ title: "piped" });
  await call(["invoke", "acme-notes", "notes.create", "--data-file", "-"], undefined, {
    stdin: '{"title":"j"}',
  });
  expect(JSON.parse(seen[0]!.body)).toEqual({ title: "j" });
});

test("input is validated before anything is sent; patterns are never run", async () => {
  const missing = await call(["invoke", "acme-notes", "notes.get", "--json"]);
  expect(errorCode(missing)).toBe("INPUT_INVALID");
  expect(JSON.parse(missing.stdout).details.problems[0]).toEqual({
    path: "/id",
    message: "is required",
  });
  const range = await call([
    "invoke",
    "acme-notes",
    "notes.get",
    "--param",
    "id=1",
    "--param",
    "limit=99",
    "--json",
  ]);
  expect(errorCode(range)).toBe("INPUT_INVALID");
  const extra = await call([
    "invoke",
    "acme-notes",
    "notes.get",
    "--data-json",
    '{"id":"1","zzz":1}',
    "--json",
  ]);
  expect(errorCode(extra)).toBe("INPUT_INVALID");
  const notInt = await call([
    "invoke",
    "acme-notes",
    "notes.get",
    "--param",
    "id=1",
    "--param",
    "limit=x",
    "--json",
  ]);
  expect(errorCode(notInt)).toBe("INPUT_INVALID");
  const both = await call([
    "invoke",
    "acme-notes",
    "notes.get",
    "--param",
    "id=1",
    "--data-json",
    "{}",
    "--json",
  ]);
  expect(errorCode(both)).toBe("INPUT_INVALID");
  const arrayParam = await call([
    "invoke",
    "acme-notes",
    "notes.create",
    "--param",
    "tags=a",
    "--json",
  ]);
  expect(errorCode(arrayParam)).toBe("INPUT_INVALID");
  expect(seen).toHaveLength(0);
  const pattern = await call([
    "invoke",
    "acme-notes",
    "notes.create",
    "--param",
    "title=aaaaaaaaaaaaaaaaaaaaaaaa!",
  ]);
  expect(pattern.code).toBe(0);
});

test("--preflight prints the request and the scopes, asks for no token, sends nothing", async () => {
  const result = await call([
    "invoke",
    "acme-notes",
    "notes.create",
    "--param",
    "title=x",
    "--preflight",
  ]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Would send: POST https://notes.acme.example/api/notes");
  expect(result.stdout).toContain("profile");
  expect(result.stdout).toContain("Idempotency-Key");
  expect(seen).toHaveLength(0);
  expect(result.tokenCalls).toHaveLength(0);
  const asJson = await call([
    "invoke",
    "acme-notes",
    "notes.get",
    "--param",
    "id=1",
    "--preflight",
    "--json",
  ]);
  expect(JSON.parse(asJson.stdout).data).toMatchObject({
    preflight: true,
    request: { method: "GET", query: [] },
    required_scopes: ["email"],
  });
});

test("the token is asked for exactly the action's required_scopes; none named asks for none", async () => {
  const read = await call(["invoke", "acme-notes", "notes.get", "--param", "id=1"]);
  expect(read.tokenCalls).toEqual([{ appKey: "acme-notes", target: undefined, scopes: ["email"] }]);
  // An action naming no scope asks for none: a token of the fixed scopes only. An older server
  // ignores the field and answers more, which is not a missing scope.
  const ping = await call(["invoke", "acme-notes", "notes.ping"]);
  expect(ping.code).toBe(0);
  expect(ping.tokenCalls).toEqual([{ appKey: "acme-notes", target: undefined, scopes: [] }]);
  const create = await call(["invoke", "acme-notes", "notes.create", "--param", "title=x"]);
  expect(create.tokenCalls).toEqual([
    { appKey: "acme-notes", target: undefined, scopes: ["profile"] },
  ]);
});

test("a token whose scope lacks what was asked (an older server) fails before anything is sent", async () => {
  seen.length = 0;
  const older = await call(
    ["invoke", "acme-notes", "notes.get", "--param", "id=1", "--json"],
    undefined,
    {
      token: {
        ok: true,
        status: "issued",
        access_token: TOKEN,
        token_type: "Bearer",
        expires_in: 300,
        audience: "client",
        scope: "openid profile identity",
      },
    },
  );
  expect(errorCode(older)).toBe("TOKEN_SCOPE_MISSING");
  expect(older.code).toBe(1);
  expect(seen).toHaveLength(0);
});

test("unknown app, unknown action, and approval are CliErrors", async () => {
  expect(errorCode(await call(["invoke", "nope", "x", "--json"]))).toBe("APP_NOT_FOUND");
  expect(errorCode(await call(["invoke", "acme-notes", "nope", "--json"]))).toBe(
    "ACTION_NOT_FOUND",
  );
  const pending = await call(
    ["invoke", "acme-notes", "notes.get", "--param", "id=1", "--target", "#ops", "--json"],
    undefined,
    {
      token: { ok: true, status: "approval_required", requestId: "req-1" },
    },
  );
  expect(errorCode(pending)).toBe("TOKEN_APPROVAL_REQUIRED");
  expect(pending.code).toBe(2);
  expect(pending.tokenCalls).toEqual([{ appKey: "acme-notes", target: "#ops", scopes: ["email"] }]);
  expect(seen).toHaveLength(0);
});

test("a redirect is an error and is not followed", async () => {
  const result = await call(
    ["invoke", "acme-notes", "notes.get", "--param", "id=1", "--json"],
    () => new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }),
  );
  expect(errorCode(result)).toBe("APP_UNREACHABLE");
  expect(seen).toHaveLength(1);
});

test("401 is APP_UNAUTHORIZED, 422 is APP_REJECTED with the app's message, 503 is APP_UNAVAILABLE", async () => {
  const unauthorized = await call(
    ["invoke", "acme-notes", "notes.get", "--param", "id=1", "--json"],
    () => json({}, { status: 401 }),
  );
  expect(JSON.parse(unauthorized.stdout).error).toMatchObject({
    code: "APP_UNAUTHORIZED",
    retryable: false,
  });
  const rejected = await call(
    ["invoke", "acme-notes", "notes.get", "--param", "id=1", "--json"],
    () => json({ error: `title too long \u001b[31m ${TOKEN}` }, { status: 422 }),
  );
  const error = JSON.parse(rejected.stdout).error;
  expect(error.code).toBe("APP_REJECTED");
  expect(error.message).toContain("title too long");
  expect(error.message).not.toContain("\u001b");
  expect(error.message).toContain("[REDACTED]");
  const unavailable = await call(
    ["invoke", "acme-notes", "notes.create", "--param", "title=x", "--json"],
    () => json({}, { status: 503, headers: { "retry-after": "30" } }),
  );
  const down = JSON.parse(unavailable.stdout).error;
  expect(down).toMatchObject({ code: "APP_UNAVAILABLE", retryable: true });
  expect(down.message).toContain("30");
  expect(down.next_action).toContain("--idempotency-key");
});

test("a timeout after a POST was sent is OPERATION_INDETERMINATE; a GET is only unreachable", async () => {
  const slow = async () => {
    await Bun.sleep(400);
    return json({});
  };
  const post = await call(
    ["invoke", "acme-notes", "notes.create", "--param", "title=x", "--json"],
    slow,
    { timeoutMs: 100 },
  );
  expect(JSON.parse(post.stdout).error).toMatchObject({
    code: "OPERATION_INDETERMINATE",
    retryable: false,
  });
  expect(post.stdout).toContain("--idempotency-key");
  const get = await call(["invoke", "acme-notes", "notes.get", "--param", "id=1", "--json"], slow, {
    timeoutMs: 100,
  });
  expect(errorCode(get)).toBe("APP_UNREACHABLE");
});

test("a response over 1 MiB is refused", async () => {
  const result = await call(
    ["invoke", "acme-notes", "notes.get", "--param", "id=1", "--json"],
    () =>
      new Response("x".repeat(1024 * 1024 + 10), {
        headers: { "content-type": "application/json" },
      }),
  );
  expect(errorCode(result)).toBe("OUTPUT_INVALID");
});

test("an output_schema mismatch is OUTPUT_INVALID and keeps the body", async () => {
  const result = await call(
    ["invoke", "acme-notes", "notes.get", "--param", "id=1", "--json"],
    () => json({ title: 5 }),
  );
  expect(result.code).toBe(1);
  const body = JSON.parse(result.stdout);
  expect(body.error.code).toBe("OUTPUT_INVALID");
  expect(body.details.result).toEqual({ title: 5 });
  expect(body.details.problems[0].path).toBe("/title");
});

test("non-JSON content comes back as text, sanitised", async () => {
  const result = await call(
    ["invoke", "acme-notes", "notes.create", "--param", "title=x"],
    () => new Response("plain \u001b[31mtext", { headers: { "content-type": "text/plain" } }),
  );
  expect(result.stdout).toContain("plain  [31mtext");
  expect(result.stdout).not.toContain("\u001b");
});

test("the token is scrubbed before the display cut, so a token across the cut leaks no part", async () => {
  const result = await call(
    ["invoke", "acme-notes", "notes.create", "--param", "title=x"],
    () =>
      new Response(`${"a".repeat(3990)}${TOKEN}${"b".repeat(50)}`, {
        headers: { "content-type": "text/plain" },
      }),
  );
  expect(result.stdout).toContain("truncated");
  expect(result.stdout).not.toContain("hdr.pay");
});

test("--param of type number takes a decimal literal only", async () => {
  const ok = await call([
    "invoke",
    "acme-notes",
    "notes.get",
    "--param",
    "id=1",
    "--param",
    "score=-1.5e2",
  ]);
  expect(ok.code).toBe(0);
  expect(seen[0]!.url.searchParams.get("score")).toBe("-150");
  for (const bad of ["0x10", " 5", "5 ", "", "Infinity", "NaN", "1e999", "1_0"]) {
    const result = await call([
      "invoke",
      "acme-notes",
      "notes.get",
      "--param",
      "id=1",
      "--param",
      `score=${bad}`,
      "--json",
    ]);
    expect(errorCode(result)).toBe("INPUT_INVALID");
    expect(seen).toHaveLength(0);
  }
});

test("standard input is read up to 1 MiB and no further", async () => {
  const stream = (size: number) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(size).fill(97));
        controller.close();
      },
    });
  expect((await readCappedStdin(stream(1024 * 1024))).length).toBe(1024 * 1024);
  await expect(readCappedStdin(stream(1024 * 1024 + 1))).rejects.toThrow("larger than 1 MiB");
});
