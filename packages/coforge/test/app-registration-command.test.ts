import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppOwnedListResponse, AppRegistrationStatusResponse } from "@lrm/coforge-sdk/agent";
import { parseAppArgs } from "#src/app-commands";
import { isAppRegistrationInvocation } from "#src/app-registration-args";
import {
  connectAppRegistrationClient,
  type AppRegistrationClient,
} from "#src/app-registration-client";
import { runAppRegistrationCommand } from "#src/app-registration-commands";
import { CliError, renderCliError } from "#src/cli-error";

/** The register invocation `args` parse to. */
function registration(args: string[]) {
  const invocation = parseAppArgs(args);
  if (!isAppRegistrationInvocation(invocation)) throw new Error("not a register command");
  return invocation;
}

const SECRET = `cfa_secret_${"z".repeat(43)}`;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const scratch = async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-rotate-"));
  directories.push(directory);
  return directory;
};

function fakeClient(overrides: Partial<AppRegistrationClient> = {}) {
  const calls: unknown[] = [];
  const client: AppRegistrationClient = {
    status: async (selector) => {
      calls.push({ status: selector });
      return { ok: true, status: "card_pending", cardMessageId: "card-1" };
    },
    owned: async () => ({ ok: true, pending: [], apps: [] }),
    rotateSecret: async (clientKey) => {
      calls.push({ rotate: clientKey });
      return { ok: true, clientKey, clientSecret: SECRET };
    },
    ...overrides,
  };
  return { client, calls };
}

async function run(
  args: string[],
  clientOverrides: Partial<AppRegistrationClient> = {},
  io: Partial<Parameters<typeof runAppRegistrationCommand>[2]> = {},
) {
  const { client, calls } = fakeClient(clientOverrides);
  const out: string[] = [];
  const prepared: unknown[] = [];
  const code = await runAppRegistrationCommand(
    registration(args),
    {
      client,
      prepare: async (target, action) => {
        prepared.push({ target, action });
        return { messageId: "11111111-1111-4111-8111-111111111111" };
      },
    },
    { stdout: (text) => out.push(text), ...io },
  );
  return { code, stdout: out.join(""), calls, prepared };
}

test("the register commands are told apart from the installed-app ones", () => {
  const registers = (...args: string[]) => isAppRegistrationInvocation(parseAppArgs(args));
  expect(registers("prepare", "register", "--target", "#a", "--name", "A")).toBe(true);
  expect(registers("status", "--card", "x")).toBe(true);
  expect(registers("rotate-secret", "--client", "a", "--output", "/tmp/x")).toBe(true);
  expect(registers("list", "--owned")).toBe(true);
  expect(registers("list")).toBe(false);
  expect(registers("token", "--app", "x", "--exec", "true")).toBe(false);
  expect(() => parseAppArgs(["list", "--owned", "--all"])).toThrow("cannot be combined");
});

test("prepare register builds the card from its flags and says what happens next", async () => {
  const result = await run([
    "prepare",
    "register",
    "--target",
    "#ops",
    "--name",
    "Acme Notes",
    "--redirect-url",
    "https://notes.acme.example/cb",
    "--redirect-url",
    "https://notes.acme.example/cb2",
    "--client-key",
    "acme-notes",
    "--homepage-url",
    "https://notes.acme.example/",
    "--scope",
    "email",
  ]);
  expect(result.prepared).toEqual([
    {
      target: "#ops",
      action: {
        type: "app:register",
        name: "Acme Notes",
        clientKey: "acme-notes",
        homepageUrl: "https://notes.acme.example/",
        redirectUrls: ["https://notes.acme.example/cb", "https://notes.acme.example/cb2"],
        scopes: ["email"],
      },
    },
  ]);
  expect(result.stdout).toContain("11111111-1111-4111-8111-111111111111");
  expect(result.stdout).toContain("owner or admin");
  expect(result.stdout).toContain("coforge app status --card 11111111");
});

test("prepare register refuses a missing target or name, an unknown flag and a bad scope", () => {
  const parse =
    (...args: string[]) =>
    () =>
      parseAppArgs(args);
  expect(parse("prepare", "register", "--name", "A")).toThrow("--target is required");
  expect(parse("prepare", "register", "--target", "#a")).toThrow("--name is required");
  expect(parse("prepare", "register", "--target", "#a", "--name", "A", "--secret", "x")).toThrow(
    "Unexpected argument --secret",
  );
  expect(parse("prepare", "register", "--target", "#a", "--name", "A", "--scope", "admin")).toThrow(
    "--scope takes one of",
  );
  expect(parse("prepare", "register", "--target", "#a", "--target", "#b", "--name", "A")).toThrow(
    "--target is given twice",
  );
  expect(parse("status")).toThrow("exactly one of --card and --client");
  expect(parse("status", "--card", "a", "--client", "b")).toThrow("exactly one");
  expect(parse("rotate-secret", "--client", "a")).toThrow("--output is required");
});

test("status and list --owned print text, or JSON with --json", async () => {
  const status = await run(["status", "--card", "card-1"]);
  expect(status.calls).toEqual([{ status: { card: "card-1" } }]);
  expect(status.stdout).toContain("card_pending");
  const committed: AppRegistrationStatusResponse = {
    ok: true,
    status: "committed",
    cardMessageId: "card-1",
    clientKey: "acme-notes",
    committedBy: "Ada",
  };
  const json = await run(["status", "--client", "acme-notes", "--json"], {
    status: async () => committed,
  });
  expect(JSON.parse(json.stdout)).toEqual(committed);
  const text = await run(["status", "--client", "acme-notes"], { status: async () => committed });
  expect(text.stdout).toContain("Committed by Ada");
  expect(text.stdout).toContain("rotate-secret");

  const owned: AppOwnedListResponse = {
    ok: true,
    pending: [{ cardMessageId: "card-2", name: "Draft", clientKey: null }],
    apps: [{ clientKey: "acme-notes", name: "Acme Notes", role: "owner" }],
  };
  const list = await run(["list", "--owned"], { owned: async () => owned });
  expect(list.stdout).toContain("pending card card-2: Draft");
  expect(list.stdout).toContain("acme-notes — Acme Notes (you own it)");
  const listJson = await run(["list", "--owned", "--json"], { owned: async () => owned });
  expect(JSON.parse(listJson.stdout)).toEqual({ pending: owned.pending, apps: owned.apps });
});

test("rotate-secret writes the secret to a new file with mode 0600 and prints it nowhere", async () => {
  const output = join(await scratch(), "secret.txt");
  const result = await run(["rotate-secret", "--client", "acme-notes", "--output", output]);
  expect(result.code).toBe(0);
  expect(result.calls).toEqual([{ rotate: "acme-notes" }]);
  expect(await readFile(output, "utf8")).toBe(`${SECRET}\n`);
  expect((await stat(output)).mode & 0o777).toBe(0o600);
  expect(result.stdout).not.toContain(SECRET);
  expect(result.stdout).toContain(output);
  const json = await run([
    "rotate-secret",
    "--client",
    "acme-notes",
    "--output",
    `${output}.2`,
    "--json",
  ]);
  expect(JSON.parse(json.stdout)).toEqual({
    clientKey: "acme-notes",
    output: `${output}.2`,
    rotated: true,
  });
});

test("rotate-secret refuses an existing path, even a link, before rotating anything", async () => {
  const directory = await scratch();
  const existing = join(directory, "existing.txt");
  await writeFile(existing, "keep me");
  const link = join(directory, "link.txt");
  await symlink(existing, link);
  for (const path of [existing, link]) {
    const { client, calls } = fakeClient();
    const error = await runAppRegistrationCommand(
      registration(["rotate-secret", "--client", "acme", "--output", path]),
      { client, prepare: async () => ({}) },
      { stdout: () => {} },
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("OUTPUT_EXISTS");
    expect(calls).toEqual([]);
    expect(renderCliError(error as CliError)).not.toContain(SECRET);
  }
  expect(await readFile(existing, "utf8")).toBe("keep me");
});

test("rotate-secret is refused on Windows, and a request that fails leaves no file", async () => {
  const directory = await scratch();
  const output = join(directory, "windows.txt");
  const windows = await run(
    ["rotate-secret", "--client", "a", "--output", output],
    {},
    { platform: "win32" },
  ).catch((cause: unknown) => cause);
  expect((windows as CliError).code).toBe("UNSUPPORTED_PLATFORM");
  await expect(stat(output)).rejects.toThrow();

  const failing = join(directory, "failing.txt");
  const refusal = new CliError({
    code: "ACCESS_DENIED",
    message: "not the owner",
    retryable: false,
  });
  const failed = await run(["rotate-secret", "--client", "a", "--output", failing], {
    rotateSecret: async () => {
      throw refusal;
    },
  }).catch((cause: unknown) => cause);
  expect(failed).toBe(refusal);
  await expect(stat(failing)).rejects.toThrow();
});

test("a secret that cannot be written tells the Agent to remove the file and rotate again", async () => {
  const output = join(await scratch(), "broken.txt");
  const error = await run(
    ["rotate-secret", "--client", "acme", "--output", output],
    {},
    {
      createExclusive: async () => ({
        write: async () => {
          throw new Error(`disk full while writing ${SECRET}`);
        },
        close: async () => {},
      }),
    },
  ).catch((cause: unknown) => cause);
  expect((error as CliError).code).toBe("OUTPUT_WRITE_FAILED");
  expect((error as CliError).suggestedNextAction).toContain(`rm ${output}`);
  expect(renderCliError(error as CliError)).not.toContain(SECRET);
});

test("the client posts one operation body to the daemon's registration route", async () => {
  const seen: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      seen.push({ path: new URL(request.url).pathname, body: await request.json() });
      return Response.json({ ok: true, clientKey: "acme", clientSecret: SECRET });
    },
  });
  try {
    const context = `sfp_${"a".repeat(43)}`;
    const client = connectAppRegistrationClient(context, server.url.origin);
    expect(await client.rotateSecret("acme")).toEqual({
      ok: true,
      clientKey: "acme",
      clientSecret: SECRET,
    });
    expect(seen).toEqual([
      {
        path: "/api/agent/v1/app-registrations",
        body: { operation: "rotate_secret", clientKey: "acme" },
      },
    ]);
  } finally {
    await server.stop(true);
  }
});
