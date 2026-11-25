import { PROCESS_TREE_EXIT_GRACE_MS } from "@lrm/coforge-anvil";
import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRuntimeEvent } from "@coforge/agent";
import type { OwnedProcessTree } from "#src/process-tree";
import { RuntimeModelNotFoundError } from "#src/contract";
import { DevinProvider } from "#src/devin/provider";
import { fixturePerTurnHost } from "./fixtures/runtime-host";

const TEST_ACP_TIMEOUT_MS = 10_000;
const TEST_BUDGET_MS = 3 * TEST_ACP_TIMEOUT_MS + 2 * PROCESS_TREE_EXIT_GRACE_MS;

function devinProvider(log: string, onTree?: (tree: OwnedProcessTree) => void) {
  return new DevinProvider({
    acpTimeoutMs: TEST_ACP_TIMEOUT_MS,
    command: [process.execPath, new URL("./fixtures/devin-acp.ts", import.meta.url).pathname],
    host: {
      clientInfo: { name: "devin-fixture", version: "1" },
      processTreeSpawner: {
        spawn: (command, directory, env, spawnOptions) => {
          const tree = fixturePerTurnHost.processTreeSpawner.spawn(
            command,
            directory,
            env,
            spawnOptions,
          );
          onTree?.(tree);
          return tree;
        },
      },
      versionReader: async (_command, versionFrom) =>
        versionFrom?.("devin 3000.11.228 (0534)") ?? "3000.11.228",
      buildEnvironment: () => ({ DEVIN_FIXTURE_LOG: log }),
      buildCatalogEnvironment: () => ({ DEVIN_FIXTURE_LOG: log }),
      createReplyIntentScanner: () => ({
        feed: () => undefined,
        complete: () => {},
        reset: () => [],
      }),
      isShellToolName: (name: string) => name === "bash",
    },
  });
}

const ruleNames = async (cwd: string) =>
  (await readdir(join(cwd, ".devin", "rules"))).filter((name) =>
    name.startsWith("coforge-runtime-"),
  );

async function fixture(options: { sessionId?: string; instructions?: string } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-devin-session-"));
  const log = join(cwd, "rpc.jsonl");
  let tree: OwnedProcessTree | undefined;
  const provider = devinProvider(log, (spawned) => (tree = spawned));
  const reports: Array<[string, string | undefined]> = [];
  const session = await provider.createAgentSession({
    agentWorkspaceDirectory: cwd,
    instructions: options.instructions ?? "",
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    async onSessionId(id, replaced) {
      reports.push([id, replaced]);
    },
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
    cwd,
    session,
    events,
    reports,
    nextCompleted,
    records: async () =>
      (await Bun.file(log).text())
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              method?: string;
              params?: Record<string, unknown>;
            },
        ),
    cleanup: async () => {
      await session.dispose().catch(() => undefined);
      await tree?.terminate(true).catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

test(
  "Devin skips already-read queued notices before writing its next ACP prompts",
  async () => {
    const run = await fixture();
    try {
      expect(run.session.steersBusyTurn).toBe(false);
      const active = run.session.sendMessage("busy turn");
      const selection: Array<[string, string]> = [];
      let readThrough = 0;
      const queue = (sequence: number, text: string) =>
        run.session.notify!(text, {
          prepareSubmission(boundary) {
            selection.push([text, boundary]);
            return sequence > readThrough ? text : undefined;
          },
        });
      const admissions = Promise.allSettled([
        queue(46, "old preview first copy"),
        queue(55, "new preview first"),
        queue(46, "old preview second copy"),
        queue(56, "new preview second"),
      ]);
      expect(selection).toEqual([]);
      readThrough = 54;
      await active;
      const outcomes = await admissions;
      const prompts = (await run.records())
        .filter(({ method }) => method === "session/prompt")
        .map(({ params }) => params?.prompt);
      expect(prompts).toEqual([
        [{ type: "text", text: "busy turn" }],
        [{ type: "text", text: "new preview first" }],
        [{ type: "text", text: "new preview second" }],
      ]);
      expect(outcomes.map(({ status }) => status)).toEqual([
        "rejected",
        "fulfilled",
        "rejected",
        "fulfilled",
      ]);
      expect(selection).toEqual([
        ["old preview first copy", "prompt"],
        ["new preview first", "prompt"],
        ["old preview second copy", "prompt"],
        ["new preview second", "prompt"],
      ]);
    } finally {
      await run.cleanup();
    }
  },
  TEST_BUDGET_MS,
);

test(
  "a Devin session writes its standing instructions as an always-on rule and removes it on dispose",
  async () => {
    const run = await fixture({ instructions: "Stay brief." });
    try {
      const directory = join(run.cwd, ".devin", "rules");
      const names = (await readdir(directory)).filter((name) =>
        name.startsWith("coforge-runtime-"),
      );
      expect(names).toHaveLength(1);
      const text = await readFile(join(directory, names[0]!), "utf8");
      expect(text).toContain("trigger: always_on");
      expect(text).toContain("Stay brief.");
      await run.session.dispose();
      expect(
        (await readdir(directory)).filter((name) => name.startsWith("coforge-runtime-")),
      ).toEqual([]);
    } finally {
      await run.cleanup();
    }
  },
  TEST_BUDGET_MS,
);

test(
  "a Devin session applies the configured model and then its effort",
  async () => {
    const run = await fixture();
    try {
      // The fixture starts on gpt-6-sol-high; the launch asks for another model and effort.
      const configured = await devinProvider(join(run.cwd, "config.jsonl")).createAgentSession({
        agentWorkspaceDirectory: run.cwd,
        instructions: "",
        runtime: {
          provider: "devin",
          model: "gpt-6-sol-low",
          modelProvider: "",
          reasoning: "max",
        },
      });
      await configured.dispose();
      const records = (await Bun.file(join(run.cwd, "config.jsonl")).text())
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              method?: string;
              params?: Record<string, unknown>;
            },
        )
        .filter((record) => record.method === "session/set_config_option");
      expect(records.map((record) => record.params?.configId)).toEqual(["model", "thought_level"]);
      expect(records.map((record) => record.params?.value)).toEqual(["gpt-6-sol-low", "max"]);
    } finally {
      await run.cleanup();
    }
  },
  TEST_BUDGET_MS,
);

test(
  "a resumed Devin session loads the stored session instead of creating one",
  async () => {
    const run = await fixture({ sessionId: "devin-fixture-session" });
    try {
      const methods = (await run.records()).map((record) => record.method);
      expect(methods).toContain("session/load");
      expect(methods).not.toContain("session/new");
      expect(run.reports).toEqual([["devin-fixture-session", undefined]]);
      expect(await run.session.readSessionIdentity!()).toEqual({
        sessionId: "devin-fixture-session",
        state: "resumable",
      });
    } finally {
      await run.cleanup();
    }
  },
  TEST_BUDGET_MS,
);

test(
  "a Devin session Devin no longer has starts fresh and reports the replacement",
  async () => {
    const run = await fixture({ sessionId: "missing-session" });
    try {
      expect(run.reports).toEqual([["devin-fixture-session", "missing-session"]]);
    } finally {
      await run.cleanup();
    }
  },
  TEST_BUDGET_MS,
);

test(
  "a Devin session enters the full-access mode before its first turn",
  async () => {
    const run = await fixture();
    try {
      const modes = (await run.records())
        .filter((record) => record.method === "session/set_mode")
        .map((record) => record.params?.modeId);
      expect(modes).toEqual(["bypass"]);
    } finally {
      await run.cleanup();
    }
  },
  TEST_BUDGET_MS,
);

test(
  "a Devin prompt streams its text and tool Activity and completes",
  async () => {
    const run = await fixture();
    try {
      await run.session.sendMessage("tool");
      await run.nextCompleted();
      expect(run.events.filter((event) => event.type === "text-delta")).toEqual([
        { type: "text-delta", text: "working" },
      ]);
      expect(run.events.filter((event) => event.type === "tool-start")).toEqual([
        {
          type: "tool-start",
          id: "shell-1",
          name: "shell_command",
          input: { command: "printf hi" },
        },
      ]);
      expect(run.events.filter((event) => event.type === "tool-output")).toEqual([
        { type: "tool-output", id: "shell-1", text: "hi" },
      ]);
      expect(run.events.filter((event) => event.type === "tool-end")).toEqual([
        { type: "tool-end", id: "shell-1", isError: false },
      ]);
      expect(run.events.at(-1)).toEqual({
        type: "completed",
        status: "completed",
      });
    } finally {
      await run.cleanup();
    }
  },
  TEST_BUDGET_MS,
);

test(
  "a resume failure that is not Devin's session_not_found surfaces and leaves no rule behind",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "anvil-devin-session-load-"));
    try {
      await expect(
        devinProvider(join(cwd, "rpc.jsonl")).createAgentSession({
          agentWorkspaceDirectory: cwd,
          instructions: "Stay brief.",
          sessionId: "unreadable-session",
        }),
      ).rejects.toThrow();
      expect(await ruleNames(cwd)).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  TEST_BUDGET_MS,
);

test(
  "a Devin launch whose model is gone fails and removes its rule",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "anvil-devin-session-model-"));
    try {
      await expect(
        devinProvider(join(cwd, "rpc.jsonl")).createAgentSession({
          agentWorkspaceDirectory: cwd,
          instructions: "Stay brief.",
          runtime: {
            provider: "devin",
            model: "retired-model",
            modelProvider: "",
            reasoning: "",
          },
        }),
      ).rejects.toBeInstanceOf(RuntimeModelNotFoundError);
      expect(await ruleNames(cwd)).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  TEST_BUDGET_MS,
);

test(
  "a Devin process that exits mid-turn reports exit and removes its rule",
  async () => {
    const run = await fixture({ instructions: "Stay brief." });
    try {
      const exited = Promise.withResolvers<void>();
      run.session.onExit(() => exited.resolve());
      expect(await ruleNames(run.cwd)).toHaveLength(1);
      await run.session.sendMessage("crash").catch(() => undefined);
      await exited.promise;
      expect(await ruleNames(run.cwd)).toEqual([]);
      await expect(run.session.sendMessage("again")).rejects.toThrow();
    } finally {
      await run.cleanup();
    }
  },
  TEST_BUDGET_MS,
);
