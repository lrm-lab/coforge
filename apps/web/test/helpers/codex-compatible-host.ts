import { homedir } from "node:os";
import { readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

const poisonedEnvironment = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "COFORGE_CODEX_COMPATIBLE_API_KEY",
] as const;

export async function isolatedHomeDirectory(path: string) {
  const directory = resolve(path);
  const home = await realpath(homedir());
  if (!directory.startsWith(`${home}${sep}`) || directory !== (await realpath(directory))) {
    throw new Error(
      "Fixture directories must be real directories inside the disposable user's home",
    );
  }
  return directory;
}

export function codexFixtureEnvironment(name: string) {
  const value = Bun.env[name];
  if (!value) throw new Error(`Missing isolated Codex fixture prerequisite ${name}`);
  return value;
}

export async function beginCodexReceipt(phase: "backend" | "browser") {
  const path = resolve(codexFixtureEnvironment("COFORGE_CODEX_E2E_EVIDENCE_PATH"));
  const directory = await isolatedHomeDirectory(dirname(path));
  const candidate = codexFixtureEnvironment("COFORGE_CODEX_E2E_CANDIDATE_SHA");
  const receipt = { candidate, phases: { [phase]: { status: "incomplete" } } };
  await Bun.write(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return { path, directory };
}

export async function codexIsSignedOut() {
  const codex = codexFixtureEnvironment("COFORGE_CODEX_E2E_REAL_CODEX");
  const child = Bun.spawn([codex, "login", "status"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return code === 1 && `${stdout}${stderr}`.trim() === "Not logged in";
}

async function runHostCommand(command: string[], environment: NodeJS.ProcessEnv = process.env) {
  const child = Bun.spawn(command, { env: environment, stdout: "ignore", stderr: "ignore" });
  if ((await child.exited) !== 0) throw new Error(`Isolated host command failed: ${command[0]}`);
}

export async function withPoisonedCodexHost<T>(input: {
  codexHome: string;
  defaultBaseUrl: URL;
  model: string;
  run: () => Promise<T>;
}) {
  const config = join(input.codexHome, "config.toml");
  const savedConfig = await readFile(config, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  const computer = join(homedir(), ".coforge/computer/install/active/coforge-computer");
  const environment = {
    ...process.env,
    OPENAI_API_KEY: `poison-${crypto.randomUUID()}`,
    OPENAI_BASE_URL: input.defaultBaseUrl.href,
    COFORGE_CODEX_COMPATIBLE_API_KEY: `poison-${crypto.randomUUID()}`,
  };
  await writeFile(
    config,
    [
      `model = ${JSON.stringify(input.model)}`,
      'model_provider = "coforge-e2e-default"',
      "[model_providers.coforge-e2e-default]",
      'name = "Local test provider"',
      `base_url = ${JSON.stringify(input.defaultBaseUrl.href)}`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  try {
    await runHostCommand(
      ["systemctl", "--user", "import-environment", ...poisonedEnvironment],
      environment,
    );
    const probe = Bun.spawn(["systemctl", "--user", "show-environment"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const applied = (await new Response(probe.stdout).text()).split("\n");
    if (
      (await probe.exited) !== 0 ||
      !poisonedEnvironment.every((name) => applied.includes(`${name}=${environment[name]}`))
    ) {
      throw new Error("The disposable service manager did not receive the synthetic variables");
    }
    await runHostCommand([computer, "stop"]);
    await runHostCommand([computer, "start"]);
    return await input.run();
  } finally {
    await runHostCommand(["systemctl", "--user", "unset-environment", ...poisonedEnvironment]);
    if (savedConfig === undefined) await unlink(config);
    else await writeFile(config, savedConfig, { mode: 0o600 });
    await runHostCommand([computer, "stop"]);
    await runHostCommand([computer, "start"]);
  }
}

export async function codexThreads(
  codexHome: string,
  agentId: string,
  provider: string,
  reply?: string,
) {
  const sessions = join(codexHome, "sessions");
  const matches: string[] = [];
  for await (const file of new Bun.Glob("**/rollout-*.jsonl").scan({
    cwd: sessions,
    absolute: true,
  })) {
    const rollout = await Bun.file(file).text();
    if (!rollout || (reply && !rollout.includes(reply))) continue;
    const metadata = JSON.parse(rollout.split("\n", 1)[0] ?? "null");
    const session = metadata?.type === "session_meta" ? metadata.payload : undefined;
    if (
      typeof session?.id === "string" &&
      typeof session.cwd === "string" &&
      basename(session.cwd) === agentId &&
      session.model_provider === provider
    ) {
      matches.push(session.id);
    }
  }
  return matches;
}

export async function codexThreadOpens(agentId: string) {
  const workspaces = join(homedir(), ".coforge/daemon/workspaces");
  const opens: { threadId: string; runtimeId: string; method: string }[] = [];
  for await (const file of new Bun.Glob("*/logs/daemon/daemon.jsonl").scan({
    cwd: workspaces,
    absolute: true,
  })) {
    const lines = (await Bun.file(file).text()).split("\n");
    for (const line of lines) {
      if (!line.includes("codex.thread.instructions_shape")) continue;
      try {
        const record = JSON.parse(line);
        const properties = record.properties ?? record;
        if (
          properties?.event === "codex.thread.instructions_shape" &&
          properties.agent_id === agentId &&
          typeof properties.thread_id === "string" &&
          typeof properties.runtime_id === "string" &&
          typeof properties.method === "string"
        ) {
          opens.push({
            threadId: properties.thread_id,
            runtimeId: properties.runtime_id,
            method: properties.method,
          });
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
  }
  return opens;
}
