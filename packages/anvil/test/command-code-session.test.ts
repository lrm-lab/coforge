import { PROCESS_TREE_EXIT_GRACE_MS } from "@lrm/coforge-anvil";
import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRuntimeEvent } from "@coforge/agent";
import type { OwnedProcessTree } from "#src/process-tree";
import { CommandCodeProvider } from "#src/command-code/provider";
import { fixturePerTurnHost } from "./fixtures/runtime-host";

const TEST_ACP_TIMEOUT_MS = 10_000;
// Version probe, initialize/new/cancel (catalog: initialize/new/close), then TERM and KILL waits.
const TEST_BUDGET_MS = 3 * TEST_ACP_TIMEOUT_MS + 2 * PROCESS_TREE_EXIT_GRACE_MS;

async function fixture(
  sessionId?: string,
  instructions = "",
  environment: Record<string, string> = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-command-code-session-"));
  const log = join(cwd, "rpc.jsonl");
  let tree: OwnedProcessTree | undefined;
  let launch: readonly string[] = [];
  const promptWritten = Promise.withResolvers<void>();
  const provider = new CommandCodeProvider({
    acpTimeoutMs: TEST_ACP_TIMEOUT_MS,
    command: [
      process.execPath,
      new URL("./fixtures/command-code-acp.ts", import.meta.url).pathname,
    ],
    host: {
      clientInfo: { name: "command-code-fixture", version: "1" },
      processTreeSpawner: {
        spawn: (command, directory, env, options) => {
          launch = command;
          tree = fixturePerTurnHost.processTreeSpawner.spawn(command, directory, env, options);
          const stdin = tree.child.stdin;
          const write = stdin.write.bind(stdin);
          stdin.write = (value) => {
            const written = write(value);
            if (JSON.parse(value).method === "session/prompt") promptWritten.resolve();
            return written;
          };
          return tree;
        },
      },
      versionReader: async () => "1.87.3",
      buildEnvironment: () => ({ COMMAND_CODE_FIXTURE_LOG: log, ...environment }),
      createReplyIntentScanner: () => ({
        feed: () => undefined,
        complete: () => {},
        reset: () => [],
      }),
      isShellToolName: (name: string) => name === "bash",
    },
  });
  try {
    const session = await provider.createAgentSession({
      agentWorkspaceDirectory: cwd,
      instructions,
      ...(sessionId ? { sessionId } : {}),
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    const nextCompleted = () => {
      const done = Promise.withResolvers<void>();
      const off = session.subscribe((event) => {
        if (event.type === "completed") done.resolve();
      });
      return done.promise.finally(off);
    };
    return {
      session,
      events,
      nextCompleted,
      waitForPrompt: () => promptWritten.promise,
      launch: () => launch,
      records: async () =>
        (await Bun.file(log).text())
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      release: async () => {
        await promptWritten.promise;
        tree!.child.stdin!.write(
          JSON.stringify({ jsonrpc: "2.0", method: "fixture/release" }) + "\n",
        );
        await tree!.child.stdin!.flush?.();
      },
      close: async () => {
        try {
          await session.dispose();
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(cwd, { recursive: true, force: true });
    throw error;
  }
}

test(
  "COMMAND_CODE keeps a persistent ACP process and drains queued messages only after turn settlement",
  async () => {
    const f = await fixture();
    try {
      await f.session.notify!("hold");
      expect(f.session.hasLiveTurn).toBe(true);
      expect(
        f.events.some((event) => event.type === "session" && event.identity.state === "resumable"),
      ).toBe(true);
      let accepted = false;
      const second = f.session.notify!("second").then(() => {
        accepted = true;
      });
      expect(accepted).toBe(false);
      expect((await f.records()).filter((r) => r.method === "session/prompt")).toHaveLength(1);
      const completed = f.nextCompleted();
      await f.release();
      await second;
      await completed;
      const records = await f.records();
      expect(records.filter((r) => r.method === "session/prompt")).toHaveLength(2);
      expect(records.filter((r) => r.method === "initialize")).toHaveLength(1);
      expect(records.find((r) => r.method === "session/new")?.params).toMatchObject({
        mcpServers: [],
      });
      expect(await f.session.readSessionIdentity!()).toEqual({
        sessionId: "command-code-fixture-session",
        state: "resumable",
      });
    } finally {
      await f.close();
    }
  },
  TEST_BUDGET_MS,
);

test(
  "COMMAND_CODE cancellation rejects local queued input and settles the native prompt as interrupted",
  async () => {
    const f = await fixture();
    try {
      await f.session.notify!("hold");
      const queued = f.session.notify!("never submitted").then(
        () => undefined,
        (error: unknown) => error,
      );
      await f.session.interrupt();
      expect(await queued).toMatchObject({
        message: "Command Code queued input cancelled before submission",
      });
      expect(f.events).toContainEqual({ type: "completed", status: "interrupted" });
      expect((await f.records()).filter((r) => r.method === "session/prompt")).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
  TEST_BUDGET_MS,
);

test(
  "COMMAND_CODE successful silent completion is acceptance evidence and resume uses session/resume",
  async () => {
    const f = await fixture("command-code-fixture-session");
    try {
      let accepted = false;
      const sent = f.session.notify!("silent-hold").then(() => {
        accepted = true;
      });
      // The fixture release follows the prompt on the same stream; no timer is the admission boundary.
      await f.release();
      await sent;
      expect(accepted).toBe(true);
      expect((await f.records()).find((r) => r.method === "session/resume")?.params).toMatchObject({
        mcpServers: [],
      });
    } finally {
      await f.close();
    }
  },
  TEST_BUDGET_MS,
);

test(
  "COMMAND_CODE grants a native allow_once permission request",
  async () => {
    const f = await fixture();
    try {
      const completed = f.nextCompleted();
      await f.session.notify!("permission");
      await completed;
      const answer = (await f.records()).find((r) => r.id === "permission" && r.result);
      expect(answer.result.outcome).toEqual({ outcome: "selected", optionId: "once" });
    } finally {
      await f.close();
    }
  },
  TEST_BUDGET_MS,
);

for (const input of ["refuse", "model-failed"]) {
  test(
    `COMMAND_CODE submitted RPC error (${input}) fails the turn without rejecting or re-sending input`,
    async () => {
      const f = await fixture();
      try {
        const failed = f.nextCompleted();
        await expect(f.session.notify!(input)).resolves.toBeUndefined();
        await failed;
        expect(f.events).toContainEqual({ type: "completed", status: "failed" });
        expect(f.events.filter((event) => event.type === "error")[0]).toMatchObject({
          providerErrorCode: input === "refuse" ? "-32602" : "-32603",
        });
        if (input === "model-failed")
          expect(f.events.filter((event) => event.type === "error")[0]).toMatchObject({
            message: "native model failure",
          });
        expect(f.events.some((event) => event.type === "notice-undelivered")).toBe(false);
        const completed = f.nextCompleted();
        await f.session.notify!("next distinct input");
        await completed;
        expect((await f.records()).filter((r) => r.method === "session/prompt")).toHaveLength(2);
      } finally {
        await f.close();
      }
    },
    TEST_BUDGET_MS,
  );
}

test(
  "COMMAND_CODE exit after submission rejects an unknown outcome without re-sending it",
  async () => {
    const f = await fixture();
    try {
      const exited = Promise.withResolvers<void>();
      f.session.onExit(exited.resolve);
      await expect(f.session.notify!("exit-before-evidence")).rejects.toThrow(
        "delivery outcome is unknown",
      );
      expect((await f.records()).filter((r) => r.method === "session/prompt")).toHaveLength(1);
      expect(f.events.some((event) => event.type === "notice-undelivered")).toBe(false);
      await exited.promise;
    } finally {
      await f.close();
    }
  },
  TEST_BUDGET_MS,
);

test(
  "COMMAND_CODE disposal rejects input that has never been submitted",
  async () => {
    const f = await fixture();
    try {
      await f.session.dispose();
      await expect(f.session.notify!("retry elsewhere")).rejects.toThrow("before submission");
      expect((await f.records()).some((r) => r.method === "session/prompt")).toBe(false);
    } finally {
      await f.close();
    }
  },
  TEST_BUDGET_MS,
);

test(
  "COMMAND_CODE terminal disposal settles pending input",
  async () => {
    const f = await fixture();
    try {
      await f.session.notify!("hold");
      const queued = f.session.notify!("not submitted").catch((error: unknown) => error);
      await f.session.dispose();
      expect(await queued).toMatchObject({
        message: "Command Code queued input cancelled before submission",
      });
    } finally {
      await f.close();
    }
  },
  TEST_BUDGET_MS,
);

test(
  "COMMAND_CODE purging pending notices settles an undecided submitted admission as unknown",
  async () => {
    const f = await fixture();
    try {
      const pending = f.session.notify!("silent-hold").catch((error: unknown) => error);
      await f.waitForPrompt();
      f.session.cancelPendingNotices!();
      expect(await pending).toMatchObject({
        message: "Command Code input cancelled; delivery outcome is unknown",
      });
      const completed = f.nextCompleted();
      await f.release();
      await completed;
      expect((await f.records()).filter((r) => r.method === "session/prompt")).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
  TEST_BUDGET_MS,
);

test(
  "COMMAND_CODE non-cancelled terminal responses confirm admission even when the turn is truncated",
  async () => {
    const f = await fixture();
    try {
      const completed = f.nextCompleted();
      await expect(f.session.notify!("truncated")).resolves.toBeUndefined();
      await completed;
      expect(f.events).toContainEqual({ type: "completed", status: "failed" });
      expect((await f.records()).filter((r) => r.method === "session/prompt")).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
  TEST_BUDGET_MS,
);

test(
  "COMMAND_CODE autonomous cancellation without acceptance evidence reports an unknown outcome",
  async () => {
    const f = await fixture();
    try {
      const completed = f.nextCompleted();
      await expect(f.session.notify!("self-cancel")).rejects.toThrow("delivery outcome is unknown");
      await completed;
      expect(f.events).toContainEqual({ type: "completed", status: "interrupted" });
      expect((await f.records()).filter((r) => r.method === "session/prompt")).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
  TEST_BUDGET_MS,
);

function instructionModPath(launch: readonly string[]) {
  const index = launch.indexOf("--mod");
  const path = index >= 0 ? launch[index + 1] : undefined;
  if (!path) throw new Error("Command Code launch is missing --mod");
  return path;
}

async function expectPrivateInstructions(modPath: string, instructions: string) {
  const directory = dirname(modPath);
  expect(modPath.endsWith("/mod.mjs") || modPath.endsWith("\\mod.mjs")).toBe(true);
  expect(await Bun.file(join(directory, "instructions.md")).text()).toBe(instructions);
  expect((await stat(join(directory, "instructions.md"))).mode & 0o777).toBe(0o600);
  expect((await stat(modPath)).mode & 0o777).toBe(0o600);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
}

test(
  "Command Code launches with --mod, the latest instructions, and no --safe-mode",
  async () => {
    const instructions = "latest briefing";
    const f = await fixture(undefined, instructions);
    try {
      const launch = f.launch();
      expect(launch).toContain("acp");
      expect(launch).not.toContain("--safe-mode");
      const modPath = instructionModPath(launch);
      expect(launch[launch.indexOf("--mod") + 1]).toBe(modPath);
      await expectPrivateInstructions(modPath, instructions);
      expect((await f.records()).some((record) => record.method === "session/prompt")).toBe(false);
    } finally {
      await f.close();
    }
  },
  TEST_BUDGET_MS,
);

test(
  "Command Code resume reloads the latest instructions through --mod and does not send them as a prompt",
  async () => {
    const instructions = "resumed briefing";
    const f = await fixture("command-code-fixture-session", instructions);
    try {
      expect(f.launch()).not.toContain("--safe-mode");
      await expectPrivateInstructions(instructionModPath(f.launch()), instructions);
      expect((await f.records()).some((record) => record.method === "session/prompt")).toBe(false);
      expect((await f.records()).some((record) => record.method === "session/resume")).toBe(true);
      const completed = f.nextCompleted();
      await f.session.notify!("real message");
      await completed;
      const prompts = (await f.records()).filter((record) => record.method === "session/prompt");
      expect(prompts.map((record) => record.params.prompt[0].text)).toEqual(["real message"]);
    } finally {
      await f.close();
    }
  },
  TEST_BUDGET_MS,
);

test(
  "Command Code removes the instruction mod when the session ends",
  async () => {
    const f = await fixture(undefined, "discard me");
    const modPath = instructionModPath(f.launch());
    const directory = dirname(modPath);
    try {
      await f.session.dispose();
      await expect(stat(modPath)).rejects.toThrow();
      await expect(stat(directory)).rejects.toThrow();
    } finally {
      await f.close();
    }
  },
  TEST_BUDGET_MS,
);

async function rejectedLaunch(options: {
  instructions: string;
  environment?: Record<string, string>;
  failSpawn?: boolean;
}) {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-command-code-fail-"));
  const log = join(cwd, "rpc.jsonl");
  let launch: readonly string[] = [];
  const provider = new CommandCodeProvider({
    acpTimeoutMs: TEST_ACP_TIMEOUT_MS,
    command: [
      process.execPath,
      new URL("./fixtures/command-code-acp.ts", import.meta.url).pathname,
    ],
    host: {
      clientInfo: { name: "command-code-fixture", version: "1" },
      processTreeSpawner: {
        spawn: (command, directory, env, spawnOptions) => {
          launch = command;
          if (options.failSpawn) throw new Error("spawn failed");
          return fixturePerTurnHost.processTreeSpawner.spawn(command, directory, env, spawnOptions);
        },
      },
      versionReader: async () => "1.87.3",
      buildEnvironment: () => ({ COMMAND_CODE_FIXTURE_LOG: log, ...options.environment }),
      createReplyIntentScanner: () => ({
        feed: () => undefined,
        complete: () => {},
        reset: () => [],
      }),
      isShellToolName: (name: string) => name === "bash",
    },
  });
  let error: unknown;
  try {
    await provider.createAgentSession({
      agentWorkspaceDirectory: cwd,
      instructions: options.instructions,
    });
  } catch (caught) {
    error = caught;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
  return { error, launch };
}

test(
  "Command Code removes the instruction mod when startup fails",
  async () => {
    const { error, launch } = await rejectedLaunch({
      instructions: "startup briefing",
      failSpawn: true,
    });
    expect(error).toMatchObject({ message: "spawn failed" });
    expect(launch).not.toContain("--safe-mode");
    const modPath = instructionModPath(launch);
    await expect(stat(modPath)).rejects.toThrow();
    await expect(stat(dirname(modPath))).rejects.toThrow();
  },
  TEST_BUDGET_MS,
);

test(
  "Command Code removes the instruction mod when the mod factory does not run",
  async () => {
    const { error, launch } = await rejectedLaunch({
      instructions: "must not be skipped",
      environment: { COMMAND_CODE_FIXTURE_SKIP_MOD: "1" },
    });
    expect(error).toMatchObject({
      message:
        "Command Code did not load the instruction mod. A CLI older than 1.87.2 ignores --mod on cmd acp, and a mods.disableAll setting skips --mod, so the standing instructions would be missing.",
    });
    expect(launch).not.toContain("--safe-mode");
    const modPath = instructionModPath(launch);
    await expect(stat(modPath)).rejects.toThrow();
    await expect(stat(dirname(modPath))).rejects.toThrow();
  },
  TEST_BUDGET_MS,
);

test(
  "Command Code removes the instruction mod when initialize fails",
  async () => {
    const { error, launch } = await rejectedLaunch({
      instructions: "initialize briefing",
      environment: { COMMAND_CODE_FIXTURE_PROTOCOL: "0" },
    });
    expect(error).toMatchObject({
      message: "Unsupported Command Code ACP protocol version",
    });
    expect(launch).not.toContain("--safe-mode");
    const modPath = instructionModPath(launch);
    await expect(stat(modPath)).rejects.toThrow();
    await expect(stat(dirname(modPath))).rejects.toThrow();
  },
  TEST_BUDGET_MS,
);
