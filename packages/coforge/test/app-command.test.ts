import { expect, test } from "bun:test";
import type { AgentAppTokenResponse, AgentAppView } from "@lrm/coforge-sdk/agent";
import { parseAppArgs, runAppCommand } from "#src/app-commands";
import { connectAppClient, type AppClient } from "#src/app-client";
import { CliError } from "#src/cli-error";

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhZ2VudC0xIn0.c2lnbmF0dXJlLXZhbHVl";

const NOTES: AgentAppView = {
  key: "acme-notes",
  name: "Acme Notes",
  description: "The team's notes.",
  whenToUse: "Read or write the team's notes.",
  homepageUrl: "https://notes.acme.example/",
  builtIn: false,
  access: "automatic",
};
const CLEANER: AgentAppView = {
  key: "system.cleaner",
  name: "System Cleaner",
  description: "Watches MEMORY.md.",
  whenToUse: "Act on its hint.",
  homepageUrl: null,
  builtIn: true,
};

function client(
  answer: AgentAppTokenResponse,
  apps = [NOTES, CLEANER],
): AppClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    appList: async () => ({ ok: true, apps }),
    appToken: async (appKey, target, scopes) => {
      calls.push(scopes ? { appKey, target, scopes } : { appKey, target });
      return answer;
    },
  };
}

async function command(args: string[], answer: AgentAppTokenResponse, apps?: AgentAppView[]) {
  const out: string[] = [];
  const err: string[] = [];
  const fake = client(answer, apps);
  const code = await runAppCommand(parseAppArgs(args), fake, {
    stdout: (text) => out.push(Buffer.from(text).toString()),
    stderr: (text) => err.push(Buffer.from(text).toString()),
    env: { PATH: process.env.PATH },
  });
  return { code, stdout: out.join(""), stderr: err.join(""), calls: fake.calls };
}

test("app list shows the Workspace's apps, and the built-in ones only with --all", async () => {
  const notInstalled: AgentAppTokenResponse = { ok: true, status: "not_installed" };
  const listed = (await command(["list"], notInstalled)).stdout;
  expect(listed).toContain("acme-notes — Acme Notes");
  expect(listed).toContain("Read or write the team's notes.");
  expect(listed).toContain("https://notes.acme.example/");
  expect(listed).toContain("granted on first use");
  expect(listed).not.toContain("system.cleaner");
  expect((await command(["list", "--all"], notInstalled)).stdout).toContain(
    "system.cleaner — System Cleaner (built in)",
  );
  expect(JSON.parse((await command(["list", "--json"], notInstalled)).stdout)).toEqual({
    apps: [NOTES],
  });
  expect(
    JSON.parse((await command(["list", "--json", "--all"], notInstalled)).stdout).apps,
  ).toHaveLength(2);
  expect((await command(["list"], notInstalled, [CLEANER])).stdout).toContain(
    "No apps are installed in this Workspace",
  );
});

test("app list shows an app's Agent manifest location and where it came from, only when listed", async () => {
  const notInstalled: AgentAppTokenResponse = { ok: true, status: "not_installed" };
  const explicit: AgentAppView = {
    ...NOTES,
    agentManifestUrl: "https://notes.acme.example/agents.json",
    agentManifestUrlSource: "explicit",
  };
  const derived: AgentAppView = {
    ...NOTES,
    key: "acme-wiki",
    agentManifestUrl: "https://wiki.acme.example/.well-known/coforge-agent-manifest.json",
    agentManifestUrlSource: "well_known",
  };
  const none: AgentAppView = { ...NOTES, key: "acme-none", agentManifestUrl: null };
  const listed = (await command(["list"], notInstalled, [explicit, derived, none, NOTES])).stdout;
  expect(listed).toContain("  Agent manifest: https://notes.acme.example/agents.json\n");
  expect(listed).toContain(
    "  Agent manifest: https://wiki.acme.example/.well-known/coforge-agent-manifest.json (derived from the homepage",
  );
  expect(listed.match(/Agent manifest:/g)).toHaveLength(2);
  expect((await command(["list"], notInstalled)).stdout).not.toContain("Agent manifest");
  expect(
    JSON.parse((await command(["list", "--json"], notInstalled, [explicit])).stdout).apps[0],
  ).toEqual(explicit);
});

test("app token runs the program with the token it got, and prints nothing of the token", async () => {
  const issued: AgentAppTokenResponse = {
    ok: true,
    status: "issued",
    access_token: TOKEN,
    token_type: "Bearer",
    expires_in: 300,
    audience: "acme-notes",
    scope: "openid profile identity",
  };
  const result = await command(
    ["token", "--app", "acme-notes", "--exec", "sh", "--", "-c", 'printf "%s" "$(cat <&3)"'],
    issued,
  );
  expect(result).toEqual({
    code: 0,
    stdout: "[REDACTED]",
    stderr: "",
    calls: [{ appKey: "acme-notes", target: undefined }],
  });
});

test("app token says who must approve, and where, when the use waits for a person", async () => {
  const waiting: AgentAppTokenResponse = {
    ok: true,
    status: "approval_required",
    requestId: "r-1",
    actionCardMessageId: "01a15a03-8fe6-70f8-a36b-ec7439a7a5c0",
  };
  const withTarget = await command(
    ["token", "--app", "acme-notes", "--target", "#ops", "--exec", "true"],
    waiting,
  );
  expect(withTarget.code).toBe(2);
  expect(withTarget.calls).toEqual([{ appKey: "acme-notes", target: "#ops" }]);
  expect(withTarget.stderr).toContain("needs a person's approval");
  expect(withTarget.stderr).toContain("01a15a03");
  expect(withTarget.stderr).toContain("Workspace owner or admin, or your creator");

  const noTarget = await command(["token", "--app", "acme-notes", "--exec", "true"], {
    ok: true,
    status: "approval_required",
    requestId: "r-1",
  });
  expect(noTarget.code).toBe(2);
  expect(noTarget.stderr).toContain("--target");
});

test("app token explains an app that is not installed in the Workspace", async () => {
  const result = await command(["token", "--app", "nope", "--exec", "true"], {
    ok: true,
    status: "not_installed",
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("not installed");
  expect(result.stderr).toContain("coforge app list");
});

test("the app client asks the local proxy as the Agent and reports a refusal by its code", async () => {
  const seen: unknown[] = [];
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = request.method === "POST" ? await request.json() : undefined;
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body,
      });
      if (request.method === "GET") return Response.json({ ok: true, apps: [NOTES] });
      return Response.json(
        { ok: false, errorCode: "target_invalid", error: "not a member of #ops" },
        { status: 422 },
      );
    },
  });
  try {
    const context = `sfp_${"a".repeat(43)}`;
    const apps = connectAppClient(context, proxy.url.href);
    expect(await apps.appList()).toEqual({ ok: true, apps: [NOTES] });
    const refused = await apps.appToken("acme-notes", "#ops").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CliError);
    expect(refused).toMatchObject({ code: "TARGET_INVALID", message: "not a member of #ops" });
    expect(seen).toEqual([
      {
        method: "GET",
        path: "/api/agent/v1/apps",
        authorization: `Bearer ${context}`,
        body: undefined,
      },
      {
        method: "POST",
        path: "/api/agent/v1/apps/acme-notes/token",
        authorization: `Bearer ${context}`,
        body: { target: "#ops" },
      },
    ]);
  } finally {
    void proxy.stop(true);
  }
});

test("app token --scope is repeatable, validated, and sent with the request", async () => {
  expect(
    parseAppArgs([
      "token",
      "--app",
      "a-1",
      "--scope",
      "email",
      "--scope",
      "profile",
      "--exec",
      "x",
    ]),
  ).toMatchObject({ scopes: ["email", "profile"] });
  expect(parseAppArgs(["token", "--app", "a-1", "--exec", "x"])).not.toHaveProperty("scopes");
  for (const scope of ["notes:read", ""])
    expect(() => parseAppArgs(["token", "--app", "a-1", "--scope", scope, "--exec", "x"])).toThrow(
      "Usage: coforge app",
    );
  expect(() =>
    parseAppArgs(["token", "--app", "a-1", "--scope", "email", "--scope", "email", "--exec", "x"]),
  ).toThrow("given twice");

  const issued = (scope: string): AgentAppTokenResponse => ({
    ok: true,
    status: "issued",
    access_token: TOKEN,
    token_type: "Bearer",
    expires_in: 300,
    audience: "acme-notes",
    scope,
  });
  const args = ["token", "--app", "acme-notes", "--scope", "email", "--exec", "true"];
  const covered = await command(args, issued("openid profile identity email"));
  expect(covered.code).toBe(0);
  expect(covered.calls).toEqual([{ appKey: "acme-notes", target: undefined, scopes: ["email"] }]);

  // A server that predates scope requests answers with the grant's scopes: nothing is run.
  const older = await command(args, issued("openid profile identity"));
  expect(older.code).toBe(1);
  expect(older.stderr).toContain("lacks the scope email");
  expect(older.stdout).toBe("");
});

test("the app client sends scopes, an empty list included, and names the scopes the app refuses", async () => {
  const bodies: unknown[] = [];
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      bodies.push(await request.json());
      return Response.json(
        {
          ok: false,
          errorCode: "invalid_input",
          error: "The app does not allow the scope email: it is not among the scopes.",
        },
        { status: 400 },
      );
    },
  });
  try {
    const apps = connectAppClient(`sfp_${"a".repeat(43)}`, proxy.url.href);
    const refused = await apps.appToken("acme-notes", undefined, []).catch((e: unknown) => e);
    await apps.appToken("acme-notes", undefined, ["email"]).catch(() => {});
    await apps.appToken("acme-notes").catch(() => {});
    expect(bodies).toEqual([{ scopes: [] }, { scopes: ["email"] }, {}]);
    expect(refused).toBeInstanceOf(CliError);
    expect((refused as CliError).message).toContain("does not allow the scope email");
  } finally {
    void proxy.stop(true);
  }
});

test("app token asks once more after a lost race (CONFLICT), and reports a second one", async () => {
  const conflict = () => new CliError({ code: "CONFLICT", message: "raced", retryable: false });
  const answers: (AgentAppTokenResponse | CliError)[] = [
    conflict(),
    { ok: true, status: "not_installed" },
  ];
  const calls: string[] = [];
  const io = { stdout: () => {}, stderr: () => {}, env: { PATH: process.env.PATH } };
  const racing: AppClient = {
    appList: async () => ({ ok: true, apps: [] }),
    appToken: async (appKey) => {
      calls.push(appKey);
      const answer = answers.shift()!;
      if (answer instanceof CliError) throw answer;
      return answer;
    },
  };
  const invocation = parseAppArgs(["token", "--app", "acme-notes", "--exec", "true"]);
  expect(await runAppCommand(invocation, racing, io)).toBe(1);
  expect(calls).toEqual(["acme-notes", "acme-notes"]);

  answers.push(conflict(), conflict());
  await expect(runAppCommand(invocation, racing, io)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(calls).toHaveLength(4);
});

test("a running Computer that predates scoped tokens is reported, and never asked again without scopes", async () => {
  const calls: unknown[] = [];
  const old: AppClient = {
    appList: async () => ({ ok: true, apps: [NOTES] }),
    appToken: async (_appKey, _target, scopes) => {
      calls.push(scopes);
      throw new CliError({ code: "REQUEST_INVALID", message: "The body must be { target? }" });
    },
  };
  const io = { stdout: () => {}, stderr: () => {}, env: {} };
  const scoped = parseAppArgs(["token", "--app", "acme-notes", "--scope", "email", "--exec", "x"]);
  const refused = await runAppCommand(scoped, old, io).catch((error: unknown) => error);
  expect(refused).toMatchObject({ code: "TOKEN_SCOPES_UNSUPPORTED", effect: "none" });
  expect((refused as CliError).suggestedNextAction).toContain("coforge-computer restart");
  expect(calls).toEqual([["email"]]);
  // Without scopes the same refusal is the daemon's own and passes through.
  const plain = parseAppArgs(["token", "--app", "acme-notes", "--exec", "x"]);
  expect(await runAppCommand(plain, old, io).catch((error: unknown) => error)).toMatchObject({
    code: "REQUEST_INVALID",
  });
});
