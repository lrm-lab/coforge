import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAppArgs } from "#src/app-commands";
import { isAppManagementInvocation, type AppManagementInvocation } from "#src/app-management-args";
import { connectAppManagementClient, type AppManagementClient } from "#src/app-management-client";
import { runAppManagementCommand } from "#src/app-management-commands";

function management(args: string[]): AppManagementInvocation {
  const invocation = parseAppArgs(args);
  if (!isAppManagementInvocation(invocation)) throw new Error("not a management command");
  return invocation;
}

const refused = (args: string[]) => {
  try {
    parseAppArgs(args);
  } catch (error) {
    return (error as Error).message.split("\n")[0];
  }
  throw new Error("accepted");
};

test("update parses every changeable field", () => {
  expect(
    management([
      "update",
      "--client",
      "acme",
      "--name",
      "Acme",
      "--when-to-use",
      "notes",
      "--redirect-url",
      "https://a.example/cb",
      "--redirect-url",
      "https://b.example/cb",
      "--scope",
      "email",
      "--clear-homepage-url",
      "--json",
    ]),
  ).toEqual({
    command: "app-update",
    client: "acme",
    json: true,
    changes: {
      name: "Acme",
      whenToUse: "notes",
      redirectUrls: ["https://a.example/cb", "https://b.example/cb"],
      scopes: ["email"],
      homepageUrl: null,
    },
  });
  const clear = management(["update", "--client", "acme", "--clear-scopes"]);
  expect(clear).toMatchObject({ changes: { scopes: [] } });
});

test("update refuses an empty change, a bad scope and conflicting flags", () => {
  expect(refused(["update", "--client", "acme"])).toContain("at least one field");
  expect(refused(["update", "--client", "acme", "--scope", "admin"])).toContain("--scope takes");
  expect(refused(["update", "--client", "acme", "--scope", "email", "--clear-scopes"])).toContain(
    "cannot be combined",
  );
  expect(
    refused([
      "update",
      "--client",
      "acme",
      "--redirect-url",
      "https://a.example/",
      "--add-redirect-url",
      "https://b.example/",
    ]),
  ).toContain("cannot be combined");
  expect(refused(["update", "--name", "x"])).toContain("--client is required");
});

test("share-link takes 1 to 365 days and defaults to 30", () => {
  expect(management(["share-link", "--client", "acme"])).toMatchObject({ expiresDays: 30 });
  expect(management(["share-link", "--client", "acme", "--expires-days", "365"])).toMatchObject({
    expiresDays: 365,
  });
  for (const days of ["0", "366", "1.5", "x"])
    expect(refused(["share-link", "--client", "acme", "--expires-days", days])).toContain(
      "--expires-days takes",
    );
});

test("the simple commands and the recover card parse", () => {
  for (const [name, command] of [
    ["clear-logo", "app-clear-logo"],
    ["delete", "app-delete"],
    ["share-link-status", "app-share-link-status"],
    ["revoke-share-link", "app-revoke-share-link"],
    ["request-publish", "app-request-publish"],
    ["request-unpublish", "app-request-unpublish"],
  ] as const)
    expect(management([name, "--client", "acme"])).toMatchObject({ command, client: "acme" });
  expect(management(["transfer-owner", "--client", "acme", "--to-agent", "bob"])).toMatchObject({
    toAgent: "bob",
  });
  expect(
    management([
      "prepare",
      "recover-owner",
      "--client",
      "acme",
      "--to-agent",
      "bob",
      "--target",
      "#ops",
    ]),
  ).toEqual({
    command: "app-prepare-recover-owner",
    target: "#ops",
    action: { type: "app:recover_owner", clientKey: "acme", toAgent: "bob" },
  });
  expect(refused(["prepare", "recover-owner", "--client", "acme", "--to-agent", "bob"])).toContain(
    "--target is required",
  );
});

function fakeClient() {
  const calls: unknown[] = [];
  const app = {
    clientKey: "acme",
    name: "Acme",
    description: "",
    whenToUse: "",
    category: "other",
    homepageUrl: null,
    redirectUrls: [],
    agentManifestUrl: null,
    scopes: ["openid"],
    hasLogo: true,
    publishStatus: "private",
  };
  const answers: Record<string, unknown> = {
    update: { ok: true, app },
    logo_set: { ok: true, app },
    share_link_create: {
      ok: true,
      clientKey: "acme",
      url: "https://x.example/apps/share/tok",
      createdAt: "a",
      expiresAt: "b",
    },
    transfer_owner: {
      ok: true,
      clientKey: "acme",
      changed: false,
      ownerAgent: "bob",
      previousOwnerAgent: "bob",
      at: "t",
    },
  };
  const client = {
    call: async (operation: string, body: unknown) => {
      calls.push({ operation, body });
      return answers[operation];
    },
  } as unknown as AppManagementClient;
  return { client, calls };
}

async function run(args: string[], io: Record<string, unknown> = {}) {
  const { client, calls } = fakeClient();
  const out: string[] = [];
  const prepared: unknown[] = [];
  const code = await runAppManagementCommand(
    management(args),
    {
      client,
      prepare: async (target, action) => {
        prepared.push({ target, action });
        return { messageId: "m1" };
      },
    },
    { stdout: (text) => out.push(text), ...io },
  );
  return { code, out: out.join(""), calls, prepared };
}

test("update sends its changes and prints the app, or JSON without ok", async () => {
  const text = await run(["update", "--client", "acme", "--name", "Acme"]);
  expect(text.calls).toEqual([
    { operation: "update", body: { clientKey: "acme", changes: { name: "Acme" } } },
  ]);
  expect(text.out).toContain("acme — Acme (private)");
  const json = await run(["update", "--client", "acme", "--name", "Acme", "--json"]);
  expect(JSON.parse(json.out).app.clientKey).toBe("acme");
  expect(JSON.parse(json.out).ok).toBeUndefined();
});

test("logo reads the file, names its type from the extension and refuses a bad one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-logo-"));
  const png = join(directory, "logo.PNG");
  await writeFile(png, new Uint8Array([1, 2, 3]));
  const sent = await run(["logo", "--client", "acme", "--file", png]);
  expect(sent.calls).toEqual([
    {
      operation: "logo_set",
      body: { clientKey: "acme", contentType: "image/png", dataBase64: "AQID" },
    },
  ]);
  const bad = run(["logo", "--client", "acme", "--file", "/x/logo.svg"]);
  await expect(bad).rejects.toThrow(".png");
  const big = join(directory, "big.png");
  await writeFile(big, new Uint8Array(5 * 1024 * 1024 + 1));
  await expect(run(["logo", "--client", "acme", "--file", big])).rejects.toThrow("5 MB");
  await rm(directory, { recursive: true, force: true });
});

test("share-link prints the URL once, and a no-op transfer says nothing changed", async () => {
  const link = await run(["share-link", "--client", "acme", "--expires-days", "7"]);
  expect(link.calls).toEqual([
    { operation: "share_link_create", body: { clientKey: "acme", expiresDays: 7 } },
  ]);
  expect(link.out).toContain("https://x.example/apps/share/tok");
  const transfer = await run(["transfer-owner", "--client", "acme", "--to-agent", "bob"]);
  expect(transfer.out).toContain("already owns");
});

test("prepare recover-owner posts the card and changes nothing itself", async () => {
  const result = await run([
    "prepare",
    "recover-owner",
    "--client",
    "acme",
    "--to-agent",
    "bob",
    "--target",
    "#ops",
  ]);
  expect(result.calls).toEqual([]);
  expect(result.prepared).toEqual([
    {
      target: "#ops",
      action: { type: "app:recover_owner", clientKey: "acme", toAgent: "bob" },
    },
  ]);
  expect(result.out).toContain("Nothing changed yet");
});

test("the client posts the operation and its fields to the registration route", async () => {
  const seen: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      seen.push({ path: new URL(request.url).pathname, body: await request.json() });
      return Response.json({ ok: true, clientKey: "acme", deleted: true });
    },
  });
  try {
    const client = connectAppManagementClient(`sfp_${"a".repeat(43)}`, server.url.origin);
    expect(await client.call("delete", { clientKey: "acme" })).toEqual({
      ok: true,
      clientKey: "acme",
      deleted: true,
    });
    expect(seen).toEqual([
      {
        path: "/api/agent/v1/app-registrations",
        body: { operation: "delete", clientKey: "acme" },
      },
    ]);
  } finally {
    await server.stop(true);
  }
});
