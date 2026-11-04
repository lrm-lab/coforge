import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { AgentEnvironmentError } from "@lrm/coforge-anvil";
import { OpenCodeAcpProvider } from "@lrm/coforge-anvil/opencode";
import { fixturePerTurnHost } from "./fixtures/runtime-host";

const FIXTURE = new URL("./fixtures/opencode-acp.ts", import.meta.url).pathname;
const INSTRUCTIONS = 'Standing OpenCode instructions.\n"quoted"\n';
const ALREADY_SET =
  "OpenCode cannot start because OPENCODE_CONFIG_CONTENT is already set. CoForge will not overwrite it.";

async function expectConfigAlreadySet(start: Promise<unknown>): Promise<void> {
  const error = await start.then(
    () => {
      throw new Error("expected OPENCODE_CONFIG_CONTENT to refuse the launch");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AgentEnvironmentError);
  expect(error).toMatchObject({
    code: "agent_environment_invalid",
    message: ALREADY_SET,
  });
}

function provider(log: string): OpenCodeAcpProvider {
  return new OpenCodeAcpProvider({
    host: {
      clientInfo: { name: "oc-acp-fixture", version: "1" },
      processTreeSpawner: fixturePerTurnHost.processTreeSpawner,
      buildEnvironment: () => ({
        OPENCODE_ACP_FIXTURE_LOG: log,
        OPENCODE_ACP_FIXTURE_REQUIRE_CONFIG: "1",
      }),
      versionReader: async () => "2.1.0",
      createReplyIntentScanner: () => ({
        feed: () => undefined,
        complete: () => {},
        reset: () => [],
      }),
      isShellToolName: () => false,
    },
    command: [process.execPath, FIXTURE],
  });
}

/** The fixture records the `OPENCODE_CONFIG_CONTENT` it received as a log line. */
async function readConfigContent(log: string): Promise<string> {
  const text = await readFile(log, "utf8").catch(() => "");
  const entry = text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((record) => typeof record.configContent === "string");
  expect(entry).toBeDefined();
  return entry!.configContent;
}

test("the launch environment carries the private instructions, and dispose removes them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-instructions-workspace-"));
  const log = join(directory, "rpc.jsonl");
  const session = await provider(log).createAgentSession({
    agentWorkspaceDirectory: directory,
    instructions: INSTRUCTIONS,
  } as never);
  let instructionsPath = "";
  try {
    const parsed = JSON.parse(await readConfigContent(log)) as { instructions?: string[] };
    instructionsPath = parsed.instructions?.[0] ?? "";
    expect(isAbsolute(instructionsPath)).toBe(true);
    expect(relative(directory, instructionsPath).startsWith("..")).toBe(true);
    expect(await Bun.file(instructionsPath).text()).toBe(INSTRUCTIONS);
    expect((await stat(instructionsPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(instructionsPath, ".."))).mode & 0o777).toBe(0o700);
    expect(await readdir(directory)).toEqual(["rpc.jsonl"]);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
  expect(await Bun.file(instructionsPath).exists()).toBe(false);
});

test("a resumed session carries instructions on the process that loads it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-instructions-resume-"));
  const log = join(directory, "rpc.jsonl");
  const session = await provider(log).createAgentSession({
    agentWorkspaceDirectory: directory,
    instructions: INSTRUCTIONS,
    sessionId: "session-existing",
  } as never);
  try {
    const parsed = JSON.parse(await readConfigContent(log)) as { instructions?: string[] };
    expect(await Bun.file(parsed.instructions?.[0] ?? "").text()).toBe(INSTRUCTIONS);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an Agent environment that already sets OPENCODE_CONFIG_CONTENT is refused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-instructions-declared-"));
  try {
    await expectConfigAlreadySet(
      provider(join(directory, "rpc.jsonl")).createAgentSession({
        agentWorkspaceDirectory: directory,
        instructions: INSTRUCTIONS,
        environment: { OPENCODE_CONFIG_CONTENT: "" },
      } as never),
    );
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime envVars that already set OPENCODE_CONFIG_CONTENT are refused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-instructions-runtime-"));
  try {
    await expectConfigAlreadySet(
      provider(join(directory, "rpc.jsonl")).createAgentSession({
        agentWorkspaceDirectory: directory,
        instructions: INSTRUCTIONS,
        runtime: {
          provider: "opencode",
          model: "opencode/big-pickle",
          reasoning: "high",
          envVars: { OPENCODE_CONFIG_CONTENT: '{"instructions":["/tmp/user.md"]}' },
        },
      } as never),
    );
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a process environment that already sets OPENCODE_CONFIG_CONTENT is left unchanged", async () => {
  const previous = Bun.env.OPENCODE_CONFIG_CONTENT;
  Bun.env.OPENCODE_CONFIG_CONTENT = '{"instructions":["/tmp/user.md"]}';
  const directory = await mkdtemp(join(tmpdir(), "opencode-instructions-process-"));
  try {
    await expectConfigAlreadySet(
      provider(join(directory, "rpc.jsonl")).createAgentSession({
        agentWorkspaceDirectory: directory,
        instructions: INSTRUCTIONS,
      } as never),
    );
    expect(Bun.env.OPENCODE_CONFIG_CONTENT).toBe('{"instructions":["/tmp/user.md"]}');
    expect(await readdir(directory)).toEqual([]);
  } finally {
    if (previous === undefined) delete Bun.env.OPENCODE_CONFIG_CONTENT;
    else Bun.env.OPENCODE_CONFIG_CONTENT = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
