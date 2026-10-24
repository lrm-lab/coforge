import { expect, test } from "bun:test";
import type { AgentAppView } from "@lrm/coforge-sdk/agent";
import { parseAgentManifest } from "@lrm/coforge-sdk/agent";
import { parseAppArgs, runAppCommand } from "#src/app-commands";
import type { AppClient } from "#src/app-client";
import { CliError, renderCliError } from "#src/cli-error";
import type { ManifestOutcome } from "#src/manifest-fetch";

const MANIFEST_URL = "https://notes.acme.example/.well-known/coforge-agent-manifest.json";

const NOTES: AgentAppView = {
  key: "acme-notes",
  name: "Acme Notes",
  description: "The team's notes.",
  whenToUse: "Read or write the team's notes.",
  homepageUrl: "https://notes.acme.example/",
  builtIn: false,
  access: "granted",
  agentManifestUrl: MANIFEST_URL,
  agentManifestUrlSource: "well_known",
};

const parsed = parseAgentManifest({
  schema: "coforge-agent-manifest.v1",
  execution: { mode: "http_api", base_url: "https://notes.acme.example/api" },
  auth: { type: "login_with_coforge" },
  actions: [
    {
      name: "notes.get",
      description: "Find a note.‮\u001b[31m hidden",
      effect: "read",
      endpoint: { method: "GET", path: "/notes/{id}" },
      idempotency: "safe",
      required_scopes: ["email"],
      input_schema: {
        type: "object",
        properties: { id: { type: "string" }, verbose: { type: "boolean" } },
        required: ["id"],
      },
    },
    {
      name: "notes.create",
      effect: "create",
      endpoint: { method: "POST", path: "/notes" },
      idempotency: "key_required",
      idempotency_header: "Idempotency-Key",
      required_scopes: ["email", "profile"],
      input_schema: { type: "object", properties: { title: { type: "string" } }, required: [] },
    },
  ],
});
if (!parsed.ok) throw new Error("fixture manifest is invalid");
const MANIFEST = parsed.manifest;

async function invoke(args: string[], outcome: ManifestOutcome, apps: AgentAppView[] = [NOTES]) {
  const out: string[] = [];
  const err: string[] = [];
  const urls: string[] = [];
  const client: AppClient = {
    appList: async () => ({ ok: true, apps }),
    appToken: async () => {
      throw new Error("no token is needed to list actions");
    },
  };
  let code = 0;
  try {
    code = await runAppCommand(parseAppArgs(args), client, {
      stdout: (text) => out.push(Buffer.from(text).toString()),
      stderr: (text) => err.push(Buffer.from(text).toString()),
      env: {},
      fetchManifest: async (options) => {
        urls.push(options.url);
        return outcome;
      },
    });
  } catch (error) {
    // The CLI entry point prints a CliError this way and exits 1.
    if (!(error instanceof CliError)) throw error;
    (error.outputMode === "json" ? out : err).push(renderCliError(error));
    code = 1;
  }
  return { code, stdout: out.join(""), stderr: err.join(""), urls };
}
const valid: ManifestOutcome = { kind: "valid", manifest: MANIFEST };

test("app invoke is parsed", () => {
  expect(
    parseAppArgs(["invoke", "acme-notes", "--list-actions", "--action", "a", "--json"]),
  ).toEqual({
    command: "app-invoke",
    appKey: "acme-notes",
    action: "a",
    listActions: true,
    json: true,
  });
  expect(() => parseAppArgs(["invoke", "acme-notes"])).toThrow("needs an action name");
  for (const args of [
    ["invoke"],
    ["invoke", "a", "--list-actions", "--bogus"],
    ["invoke", "a", "--list-actions", "--action"],
  ])
    expect(() => parseAppArgs(args)).toThrow("Usage: coforge app");
});

test("--list-actions prints each action, with untrusted text cleaned", async () => {
  const result = await invoke(["invoke", "acme-notes", "--list-actions"], valid);
  expect(result.code).toBe(0);
  expect(result.urls).toEqual([MANIFEST_URL]);
  expect(result.stdout).toContain("notes.get");
  expect(result.stdout).toContain("read  GET /notes/{id}");
  expect(result.stdout).toContain("email, profile");
  expect(result.stdout).toContain("id (string, required)");
  expect(result.stdout).toContain("verbose (boolean)");
  expect(result.stdout).toContain("key_required");
  expect(result.stdout.replaceAll("\n", "")).not.toMatch(/[\p{Cc}\p{Cf}]/u);
});

test("--action prints one action in full; an unknown one is ACTION_NOT_FOUND", async () => {
  const one = await invoke(
    ["invoke", "acme-notes", "--list-actions", "--action", "notes.create"],
    valid,
  );
  expect(one.stdout).toContain("notes.create");
  expect(one.stdout).toContain("Idempotency-Key");
  expect(one.stdout).not.toContain("notes.get");
  const missing = await invoke(
    ["invoke", "acme-notes", "--list-actions", "--action", "nope", "--json"],
    valid,
  );
  expect(missing.code).toBe(1);
  expect(JSON.parse(missing.stdout)).toMatchObject({
    error: { code: "ACTION_NOT_FOUND", retryable: false },
  });
});

test("--json prints the parsed actions", async () => {
  const result = await invoke(["invoke", "acme-notes", "--list-actions", "--json"], valid);
  const body = JSON.parse(result.stdout);
  expect(body.ok).toBe(true);
  expect(body.data.actions.map((a: { name: string }) => a.name)).toEqual([
    "notes.get",
    "notes.create",
  ]);
  const one = JSON.parse(
    (
      await invoke(
        ["invoke", "acme-notes", "--list-actions", "--action", "notes.get", "--json"],
        valid,
      )
    ).stdout,
  );
  expect(one.data.action.name).toBe("notes.get");
});

const errorOf = async (outcome: ManifestOutcome, app = NOTES, args: string[] = []) => {
  const result = await invoke(["invoke", app.key, "--list-actions", "--json", ...args], outcome, [
    app,
  ]);
  return { code: result.code, body: JSON.parse(result.stdout) };
};

test("each failure has a typed code, retryability and next action", async () => {
  const explicit: AgentAppView = { ...NOTES, agentManifestUrlSource: "explicit" };
  expect((await errorOf({ kind: "unreachable", message: "boom" })).body.error).toMatchObject({
    code: "MANIFEST_UNREACHABLE",
    retryable: true,
  });
  expect(
    (await errorOf({ kind: "unavailable", status: 503, retryAfter: "30" })).body.error,
  ).toMatchObject({
    code: "MANIFEST_UNAVAILABLE",
    retryable: true,
    message: expect.stringContaining("30"),
  });
  const invalid = await errorOf({
    kind: "invalid",
    problems: [{ path: "/schema", message: "bad" }],
  });
  expect(invalid.body.error).toMatchObject({
    code: "MANIFEST_INVALID",
    retryable: false,
  });
  expect(invalid.body.details.problems).toEqual([{ path: "/schema", message: "bad" }]);
  expect(invalid.body.error.next_action).toBeString();
  const missing = await errorOf({ kind: "missing", status: 404 }, explicit);
  expect(missing).toMatchObject({ code: 1, body: { error: { code: "MANIFEST_MISSING" } } });
  const none = { ...NOTES, agentManifestUrl: null, agentManifestUrlSource: null };
  expect((await errorOf({ kind: "not_configured" }, none)).body.error.code).toBe(
    "MANIFEST_NOT_CONFIGURED",
  );
  const unknown = await invoke(["invoke", "ghost", "--list-actions", "--json"], valid);
  expect(JSON.parse(unknown.stdout).error.code).toBe("APP_NOT_FOUND");
});

test("an app the server lists without a manifest location is not reported as having no homepage", async () => {
  const { agentManifestUrl: _url, agentManifestUrlSource: _source, ...unlisted } = NOTES;
  const error = (await errorOf({ kind: "not_configured" }, unlisted)).body.error;
  expect(error.code).toBe("MANIFEST_NOT_CONFIGURED");
  expect(error.message).toBe(
    "CoForge does not give Agents the Agent manifest of acme-notes in this Workspace.",
  );
  const none = {
    ...NOTES,
    homepageUrl: null,
    agentManifestUrl: null,
    agentManifestUrlSource: null,
  };
  expect((await errorOf({ kind: "not_configured" }, none)).body.error.message).toBe(
    "The app acme-notes names no Agent manifest URL and has no homepage to derive one from.",
  );
});

test("an absent manifest is a normal answer, not an error exit", async () => {
  const result = await invoke(["invoke", "acme-notes", "--list-actions"], {
    kind: "absent",
    status: 404,
  });
  expect(result).toMatchObject({ code: 0, stderr: "" });
  expect(result.stdout).toContain("publishes no Agent manifest");
});

test("--json for an absent manifest is ok:true with exit 0; a missing explicit one is an error", async () => {
  const absent: ManifestOutcome = { kind: "absent", status: 404 };
  const missing: ManifestOutcome = { kind: "missing", status: 404 };
  const normal = await invoke(["invoke", "acme-notes", "--list-actions", "--json"], absent);
  expect(normal.code).toBe(0);
  expect(JSON.parse(normal.stdout)).toEqual({
    ok: true,
    data: { app: "acme-notes", manifest: null, actions: [] },
  });
  const gone: ManifestOutcome = { kind: "absent", status: 410 };
  expect((await invoke(["invoke", "acme-notes", "--list-actions", "--json"], gone)).code).toBe(0);
  const explicit = { ...NOTES, agentManifestUrlSource: "explicit" } as AgentAppView;
  const failed = await invoke(["invoke", "acme-notes", "--list-actions", "--json"], missing, [
    explicit,
  ]);
  expect(failed.code).toBe(1);
  expect(JSON.parse(failed.stdout).error.code).toBe("MANIFEST_MISSING");
});

test("--action text sanitises and caps the schema; --json keeps manifest strings as they are", async () => {
  const noisy = parseAgentManifest({
    schema: "coforge-agent-manifest.v1",
    execution: { mode: "http_api", base_url: "https://notes.acme.example/api" },
    auth: { type: "login_with_coforge" },
    actions: [
      {
        name: "big",
        effect: "read",
        endpoint: { method: "GET", path: "/big" },
        idempotency: "safe",
        required_scopes: [],
        input_schema: {
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: 60 }, (_, i) => [
              `p${i}`,
              { type: "string", description: `${"x".repeat(60)}\u202e\u001b[31m` },
            ]),
          ),
        },
      },
    ],
  });
  if (!noisy.ok) throw new Error("fixture");
  const outcome: ManifestOutcome = { kind: "valid", manifest: noisy.manifest };
  const text = await invoke(["invoke", "acme-notes", "--list-actions", "--action", "big"], outcome);
  expect(text.stdout.replaceAll("\n", "")).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  expect(text.stdout).toContain("use --json");
  const schemaLine = text.stdout.split("\n").find((line) => line.includes("Input schema:"))!;
  expect(schemaLine.length).toBeLessThan(4200);
  const json = await invoke(
    ["invoke", "acme-notes", "--list-actions", "--action", "big", "--json"],
    outcome,
  );
  expect(JSON.parse(json.stdout).data.action.input_schema.properties.p0.description).toContain(
    "\u202e",
  );
});

test("--action on a local_cli app says it declares no HTTP actions", async () => {
  const local = parseAgentManifest({
    schema: "coforge-agent-manifest.v1",
    execution: { mode: "local_cli", command: "acme-notes" },
  });
  if (!local.ok) throw new Error("fixture");
  const result = await invoke(
    ["invoke", "acme-notes", "--list-actions", "--action", "x", "--json"],
    { kind: "valid", manifest: local.manifest },
  );
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).error).toMatchObject({ code: "NO_HTTP_ACTIONS" });
  expect(JSON.parse(result.stdout).error.message).toContain("declares no HTTP actions");
});

test("a base_url on another origin is invalid", async () => {
  const elsewhere = parseAgentManifest({
    schema: "coforge-agent-manifest.v1",
    execution: { mode: "http_api", base_url: "https://evil.example/api" },
    actions: [],
  });
  if (!elsewhere.ok) throw new Error("fixture");
  const { body } = await errorOf({ kind: "valid", manifest: elsewhere.manifest });
  expect(body.error).toMatchObject({
    code: "MANIFEST_INVALID",
  });
  expect(body.details.problems).toMatchObject([{ path: "/execution/base_url" }]);
});

test("a local_cli manifest lists no actions and names its command", async () => {
  const local = parseAgentManifest({
    schema: "coforge-agent-manifest.v1",
    execution: { mode: "local_cli", command: "acme-notes" },
  });
  if (!local.ok) throw new Error("fixture");
  const result = await invoke(["invoke", "acme-notes", "--list-actions"], {
    kind: "valid",
    manifest: local.manifest,
  });
  expect(result.stdout).toContain("acme-notes");
  expect(result.stdout).toContain("no actions");
});
