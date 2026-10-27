import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import {
  AgentEnvironmentError,
  type AgentRuntimeEvent,
  type AgentSession,
} from "@lrm/coforge-anvil";
import { OpenCodeProvider } from "@lrm/coforge-anvil/opencode";
import { fixturePerTurnHost, fixtureVersionReader } from "./fixtures/runtime-host";

const FIXTURE = new URL("./fixtures/opencode-fixture.ts", import.meta.url).pathname;
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

function provider(): OpenCodeProvider {
  return new OpenCodeProvider({
    host: fixturePerTurnHost,
    versionReader: fixtureVersionReader,
    command: [process.execPath, FIXTURE],
  });
}

function nthCompleted(session: AgentSession, n: number): Promise<void> {
  return new Promise((resolve) => {
    let count = 0;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "completed" && ++count >= n) {
        unsubscribe();
        resolve();
      }
    });
  });
}

function firstProgress(session: AgentSession): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = session.subscribe((event: AgentRuntimeEvent) => {
      if (event.type !== "progress") return;
      unsubscribe();
      resolve();
    });
  });
}

async function readLaunches(
  log: string,
): Promise<Array<{ prompt?: string; resumeId?: string; configContent?: string }>> {
  const text = await readFile(log, "utf8").catch(() => "");
  return text
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

async function turn(session: AgentSession, text: string): Promise<void> {
  const completed = nthCompleted(session, 1);
  await session.sendMessage(text);
  await completed;
}

test("every launch appends the standing instructions, and dispose removes the private file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-instructions-workspace-"));
  const log = join(directory, "launches.jsonl");
  const session = await provider().createAgentSession({
    agentWorkspaceDirectory: directory,
    instructions: INSTRUCTIONS,
    environment: {
      COFORGE_OPENCODE_MODE: "text",
      COFORGE_OPENCODE_SESSION_ID: "session-overlay",
      COFORGE_OPENCODE_LAUNCH_LOG: log,
    },
  });
  let instructionsPath = "";
  try {
    expect(await readLaunches(log)).toHaveLength(0);
    await turn(session, "first");
    await turn(session, "second");
    const launches = await readLaunches(log);
    expect(launches.map((launch) => launch.prompt)).toEqual(["first", "second"]);
    expect(launches[0]?.resumeId).toBeUndefined();
    expect(launches[1]?.resumeId).toBe("session-overlay");
    expect(launches[0]?.configContent).toBe(launches[1]?.configContent);
    const parsed = JSON.parse(launches[0]?.configContent ?? "") as { instructions?: string[] };
    instructionsPath = parsed.instructions?.[0] ?? "";
    expect(launches[0]?.configContent).toBe(JSON.stringify({ instructions: [instructionsPath] }));
    expect(isAbsolute(instructionsPath)).toBe(true);
    expect(relative(directory, instructionsPath).startsWith("..")).toBe(true);
    expect(await Bun.file(instructionsPath).text()).toBe(INSTRUCTIONS);
    expect((await stat(instructionsPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(instructionsPath, ".."))).mode & 0o777).toBe(0o700);
    expect(await readdir(directory)).toEqual(["launches.jsonl"]);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
  expect(await Bun.file(instructionsPath).exists()).toBe(false);
});

test("a resumed session appends instructions on its first real launch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-instructions-resume-"));
  const log = join(directory, "launches.jsonl");
  const session = await provider().createAgentSession({
    agentWorkspaceDirectory: directory,
    instructions: INSTRUCTIONS,
    sessionId: "session-existing",
    environment: { COFORGE_OPENCODE_MODE: "text", COFORGE_OPENCODE_LAUNCH_LOG: log },
  });
  try {
    expect(await readLaunches(log)).toHaveLength(0);
    await turn(session, "wake");
    const [launch] = await readLaunches(log);
    const parsed = JSON.parse(launch?.configContent ?? "") as { instructions?: string[] };
    expect(launch).toMatchObject({ prompt: "wake", resumeId: "session-existing" });
    expect(await Bun.file(parsed.instructions?.[0] ?? "").text()).toBe(INSTRUCTIONS);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("dispose during a running turn removes the instructions file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-instructions-hang-"));
  const log = join(directory, "launches.jsonl");
  const session = await provider().createAgentSession({
    agentWorkspaceDirectory: directory,
    instructions: INSTRUCTIONS,
    sessionId: "session-existing",
    environment: { COFORGE_OPENCODE_MODE: "hang", COFORGE_OPENCODE_LAUNCH_LOG: log },
  });
  const running = firstProgress(session);
  try {
    await session.sendMessage("go");
    await running;
    const [launch] = await readLaunches(log);
    const parsed = JSON.parse(launch?.configContent ?? "") as { instructions?: string[] };
    const instructionsPath = parsed.instructions?.[0] ?? "";
    expect(await Bun.file(instructionsPath).exists()).toBe(true);
    await session.dispose();
    expect(await Bun.file(instructionsPath).exists()).toBe(false);
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an Agent environment that already sets OPENCODE_CONFIG_CONTENT is refused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-instructions-declared-"));
  try {
    await expectConfigAlreadySet(
      provider().createAgentSession({
        agentWorkspaceDirectory: directory,
        instructions: INSTRUCTIONS,
        environment: { OPENCODE_CONFIG_CONTENT: "" },
      }),
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
      provider().createAgentSession({
        agentWorkspaceDirectory: directory,
        instructions: INSTRUCTIONS,
        runtime: {
          provider: "opencode",
          model: "opencode/big-pickle",
          reasoning: "high",
          envVars: { OPENCODE_CONFIG_CONTENT: '{"instructions":["/tmp/user.md"]}' },
        },
      }),
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
      provider().createAgentSession({
        agentWorkspaceDirectory: directory,
        instructions: INSTRUCTIONS,
      }),
    );
    expect(Bun.env.OPENCODE_CONFIG_CONTENT).toBe('{"instructions":["/tmp/user.md"]}');
    expect(await readdir(directory)).toEqual([]);
  } finally {
    if (previous === undefined) delete Bun.env.OPENCODE_CONFIG_CONTENT;
    else Bun.env.OPENCODE_CONFIG_CONTENT = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
