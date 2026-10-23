import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAppTokenResponse, AgentAppView } from "@lrm/coforge-sdk/agent";
import { parseAppArgs, runAppCommand } from "#src/app-commands";
import { createRedactor, runWithAppToken } from "#src/app-token-exec";
import { connectAppClient, type AppClient } from "#src/app-client";
import { CliError } from "#src/cli-error";

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhZ2VudC0xIn0.c2lnbmF0dXJlLXZhbHVl";
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "coforge-app-token-"));
  dirs.push(dir);
  return dir;
}

/** A `sleep` duration no other process uses, so its processes can be found by it. */
const uniqueSleep = () => `${30 + Math.floor(Math.random() * 1000)}.${Date.now() % 1000}`;

/** The processes still running `sleep <marker>`, once the stopped group has had time to exit. */
async function leftovers(marker: string): Promise<string[]> {
  const find = () => {
    const ps = Bun.spawnSync(["ps", "-axo", "pid=,command="]);
    return ps.stdout
      .toString()
      .split("\n")
      .filter((line) => line.includes(`sleep ${marker}`));
  };
  for (let attempt = 0; attempt < 20 && find().length > 0; attempt++) await Bun.sleep(100);
  const left = find();
  // Never leave them behind, even when the assertion fails.
  for (const line of left) process.kill(Number(line.trim().split(/\s+/)[0]), "SIGKILL");
  return left;
}

/** Runs `sh -c script` with the token, capturing what the child wrote. */
async function run(script: string, options: { timeoutSeconds?: number; tmp?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runWithAppToken({
    token: TOKEN,
    program: "sh",
    args: ["-c", script],
    timeoutSeconds: options.timeoutSeconds ?? 30,
    env: {
      PATH: process.env.PATH,
      HOME: "/home/agent",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      TZ: "Asia/Shanghai",
      TMPDIR: options.tmp ?? tmpdir(),
      COFORGE_AGENT_CONTEXT: "sfp_secret",
      COFORGE_AGENT_PROXY_URL: "http://127.0.0.1:1",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
    },
    stdout: (chunk) => out.push(chunk.toString()),
    stderr: (chunk) => err.push(chunk.toString()),
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

test("the child reads the token from the file descriptor COFORGE_APP_TOKEN_FD names", async () => {
  const dir = await scratch();
  const result = await run(
    'cat <&"$COFORGE_APP_TOKEN_FD" > "$TMPDIR/got"; echo "fd=$COFORGE_APP_TOKEN_FD"',
    {
      tmp: dir,
    },
  );
  expect(result).toEqual({ code: 0, stdout: "fd=3\n", stderr: "" });
  expect(await readFile(join(dir, "got"), "utf8")).toBe(TOKEN);
});

test("the child gets only PATH, the locale, the time zone and TMPDIR", async () => {
  const { stdout } = await run("env");
  const names = stdout
    .trim()
    .split("\n")
    .map((line) => line.slice(0, line.indexOf("=")))
    .filter((name) => !["PWD", "SHLVL", "_"].includes(name))
    .sort();
  expect(names).toEqual(["COFORGE_APP_TOKEN_FD", "LANG", "LC_ALL", "PATH", "TMPDIR", "TZ"]);
});

test("the token never reaches the child's output: it is redacted from stdout and stderr", async () => {
  const result = await run('t=$(cat <&3); echo "out $t"; echo "err $t" >&2');
  expect(result).toEqual({ code: 0, stdout: "out [REDACTED]\n", stderr: "err [REDACTED]\n" });
});

test("redaction holds when the token is split across chunks", () => {
  const out: string[] = [];
  const redactor = createRedactor(TOKEN, (chunk) => out.push(chunk.toString()));
  const text = `a${TOKEN}b${TOKEN}`;
  for (const piece of [text.slice(0, 10), text.slice(10, 40), text.slice(40, 41), text.slice(41)])
    redactor.write(Buffer.from(piece));
  redactor.end();
  expect(out.join("")).toBe("a[REDACTED]b[REDACTED]");
  expect(out.some((chunk) => chunk.includes(TOKEN.slice(0, 20)))).toBe(false);
});

test("the command exits with the child's exit code", async () => {
  expect((await run("exit 7")).code).toBe(7);
});

test("a child that outlives the timeout is stopped and the command exits 124", async () => {
  const started = Date.now();
  const marker = uniqueSleep();
  const result = await run(`sleep ${marker}`, { timeoutSeconds: 1 });
  expect(await leftovers(marker)).toEqual([]);
  expect(result.code).toBe(124);
  expect(Date.now() - started).toBeLessThan(10_000);
}, 15_000);

test("app token takes --app, --exec and the program's own arguments after --", () => {
  expect(
    parseAppArgs(["token", "--app", "acme-notes", "--exec", "curl", "--", "-s", "--app", "x"]),
  ).toEqual({
    command: "app-token",
    appKey: "acme-notes",
    program: "curl",
    args: ["-s", "--app", "x"],
    timeoutSeconds: 60,
  });
  expect(
    parseAppArgs(["token", "--app", "a-1", "--target", "#ops", "--timeout", "300", "--exec", "x"]),
  ).toMatchObject({ target: "#ops", timeoutSeconds: 300, args: [] });
  for (const args of [
    ["token", "--exec", "curl"],
    ["token", "--app", "a-1"],
    ["token", "--app", "a-1", "--exec", "x", "--timeout", "0"],
    ["token", "--app", "a-1", "--exec", "x", "--timeout", "301"],
    ["token", "--app", "a-1", "--exec", "x", "--timeout", "1.5"],
    ["token", "--app", "a-1", "--exec", "x", "--json"],
    ["list", "--target", "#ops"],
  ])
    expect(() => parseAppArgs(args)).toThrow("Usage: coforge app");
  expect(parseAppArgs(["list"])).toEqual({ command: "app-list" });
  expect(parseAppArgs(["list", "--all", "--json"])).toEqual({
    command: "app-list",
    all: true,
    json: true,
  });
});

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
    appToken: async (appKey, target) => {
      calls.push({ appKey, target });
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

test("a stopped program's leftover children holding its output do not keep the command waiting", async () => {
  const started = Date.now();
  const marker = uniqueSleep();
  // The shell itself, a background child and a grandchild all hold the program's output.
  const result = await run(`sleep ${marker} & (sleep ${marker} &); sleep ${marker}`, {
    timeoutSeconds: 1,
  });
  expect(await leftovers(marker)).toEqual([]);
  expect(result.code).toBe(124);
  expect(Date.now() - started).toBeLessThan(10_000);
}, 15_000);

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

test("a program that cannot be run exits 127", async () => {
  const err: string[] = [];
  const code = await runWithAppToken({
    token: TOKEN,
    program: "coforge-no-such-program",
    args: [],
    timeoutSeconds: 5,
    env: { PATH: process.env.PATH },
    stdout: () => {},
    stderr: (chunk) => err.push(chunk.toString()),
  });
  expect(code).toBe(127);
  expect(err.join("")).toContain("could not run coforge-no-such-program");
});

test("a program that ignores SIGTERM is killed, with its group, after the grace", async () => {
  const marker = uniqueSleep();
  const started = Date.now();
  const result = await run(`trap "" TERM; sleep ${marker} & sleep ${marker}`, {
    timeoutSeconds: 1,
  });
  expect(result.code).toBe(124);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(await leftovers(marker)).toEqual([]);
}, 15_000);

test("what the program left running is stopped once it exits, even with its output closed", async () => {
  const started = Date.now();
  const [holding, silent] = [uniqueSleep(), uniqueSleep()];
  const result = await run(`sleep ${holding} & sleep ${silent} >/dev/null 2>&1 &`);
  expect(result.code).toBe(0);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(await leftovers(holding)).toEqual([]);
  expect(await leftovers(silent)).toEqual([]);
}, 15_000);

test("the timeout still holds when a process outside the program's group keeps its output open", async () => {
  const started = Date.now();
  const marker = uniqueSleep();
  // A grandchild in a session of its own: stopping the program's group does not reach it.
  const escape = `require("node:child_process").spawn("sleep", ["${marker}"], { detached: true, stdio: ["ignore", "inherit", "inherit"] }).unref()`;
  const result = await run(`"${process.execPath}" -e '${escape}'`, { timeoutSeconds: 1 });
  await leftovers(marker);
  expect(result.code).toBe(124);
  expect(Date.now() - started).toBeLessThan(10_000);
}, 15_000);

test("a signal to the CLI stops the program's whole group and exits 128 plus its number", async () => {
  const marker = uniqueSleep();
  const exec = join(import.meta.dir, "../src/app-token-exec.ts");
  const script = `import { runWithAppToken } from ${JSON.stringify(exec)};
process.exitCode = await runWithAppToken({
  token: ${JSON.stringify(TOKEN)}, program: "sh",
  args: ["-c", ${JSON.stringify(`sleep ${marker} & echo started; sleep ${marker}`)}],
  timeoutSeconds: 60, env: { PATH: process.env.PATH },
  stdout: (chunk) => process.stdout.write(chunk), stderr: (chunk) => process.stderr.write(chunk),
});`;
  const cli = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const reader = cli.stdout.getReader();
  let seen = "";
  while (!seen.includes("started")) {
    const read = await reader.read();
    if (read.done) break;
    seen += Buffer.from(read.value).toString();
  }
  expect(seen).toContain("started");
  cli.kill("SIGTERM");
  expect(await cli.exited).toBe(143);
  expect(await leftovers(marker)).toEqual([]);
}, 15_000);

test("the token's signature, or its header and payload, printed alone are redacted too", async () => {
  const result = await run('t=$(cat <&3); echo "${t##*.}"; echo "${t%.*}"');
  expect(result).toEqual({ code: 0, stdout: "[REDACTED]\n[REDACTED]\n", stderr: "" });
});

test("output that cannot be the start of the token is passed on at once", () => {
  const out: string[] = [];
  const redactor = createRedactor(TOKEN, (chunk) => out.push(chunk.toString()));
  redactor.write(Buffer.from("progress 50%\n"));
  expect(out.join("")).toBe("progress 50%\n");
  redactor.write(Buffer.from(`done ${TOKEN.slice(0, 5)}`));
  expect(out.join("")).toBe("progress 50%\ndone ");
  redactor.end();
  expect(out.join("")).toBe(`progress 50%\ndone ${TOKEN.slice(0, 5)}`);
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
