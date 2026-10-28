import { VERSION_PROBE_TIMEOUT_MS, PROCESS_TREE_EXIT_GRACE_MS } from "@lrm/coforge-anvil";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRuntimeEvent } from "@coforge/agent";
import type { OwnedProcessTree } from "#src/process-tree";
import { DshProvider } from "#src/dsh/provider";
import { createDshLaunchContents } from "#src/dsh/launch-contents";
import { fixturePerTurnHost, fixtureVersionReader } from "./fixtures/runtime-host";

const TEST_ACP_TIMEOUT_MS = 10_000;
// Version probe, initialize/new/cancel (catalog: initialize/new/close), then TERM and KILL waits.
const TEST_BUDGET_MS =
  VERSION_PROBE_TIMEOUT_MS + 3 * TEST_ACP_TIMEOUT_MS + 2 * PROCESS_TREE_EXIT_GRACE_MS;

async function fixture(
  sessionId?: string,
  invalidInstructions = false,
  afterCleanup?: (files: string[]) => Promise<void>,
) {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-dsh-session-"));
  const log = join(cwd, "rpc.jsonl");
  let tree: OwnedProcessTree | undefined;
  let cleaned = false;
  const promptWritten = Promise.withResolvers<void>();
  const provider = new DshProvider({
    acpTimeoutMs: TEST_ACP_TIMEOUT_MS,
    command: [process.execPath, new URL("./fixtures/dsh-acp.ts", import.meta.url).pathname],
    host: {
      clientInfo: { name: "dsh-fixture", version: "1" },
      versionReader: fixtureVersionReader,
      processTreeSpawner: {
        spawn: (...args) => {
          tree = fixturePerTurnHost.processTreeSpawner.spawn(...args);
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
      buildEnvironment: () => ({ DSH_FIXTURE_LOG: log }),
      prepareLaunch: async (instructions: string) => {
        const plugin = join(cwd, "instructions.mjs");
        const patchPath = join(cwd, "patch.json");
        const contents = createDshLaunchContents(instructions, plugin);
        if (invalidInstructions) {
          const patch = JSON.parse(contents.patch);
          patch.find(
            (entry: { insert?: unknown[] }) => entry.insert,
          ).insert[0].config.instructions = 42;
          contents.patch = JSON.stringify(patch);
        }
        await writeFile(plugin, contents.plugin, { mode: 0o600 });
        await writeFile(patchPath, contents.patch, { mode: 0o600 });
        return {
          patchPath,
          cleanup: async () => {
            cleaned = true;
            await Promise.all([rm(plugin, { force: true }), rm(patchPath, { force: true })]);
            await afterCleanup?.([plugin, patchPath]);
          },
        };
      },
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
      instructions: "{{x}}",
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
      cleaned: () => cleaned,
      waitForPrompt: () => promptWritten.promise,
      filesDeleted: async () =>
        !(await Bun.file(join(cwd, "instructions.mjs")).exists()) &&
        !(await Bun.file(join(cwd, "patch.json")).exists()),
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
  "DSH keeps a persistent ACP process and drains queued messages only after turn settlement",
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
      expect(await f.session.readSessionIdentity!()).toEqual({
        sessionId: "dsh-fixture-session",
        state: "resumable",
      });
    } finally {
      await f.close();
    }
  },
  TEST_BUDGET_MS,
);

test(
  "DSH cancellation rejects local queued input and settles the native prompt as interrupted",
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
        message: "DSH queued input cancelled before submission",
      });
      expect(f.events).toContainEqual({ type: "completed", status: "interrupted" });
      expect(await f.filesDeleted()).toBe(true);
      expect((await f.records()).filter((r) => r.method === "session/prompt")).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
  TEST_BUDGET_MS,
);

test(
  "DSH successful silent completion is acceptance evidence and resume uses session/resume",
  async () => {
    const f = await fixture("dsh-fixture-session");
    try {
      let accepted = false;
      const sent = f.session.notify!("silent-hold").then(() => {
        accepted = true;
      });
      // The fixture release follows the prompt on the same stream; no timer is the admission boundary.
      await f.release();
      await sent;
      expect(accepted).toBe(true);
      expect((await f.records()).some((r) => r.method === "session/resume")).toBe(true);
    } finally {
      await f.close();
    }
  },
  TEST_BUDGET_MS,
);

test(
  "DSH grants a native allow_once permission request",
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

test(
  "DSH reports a missing provider key as an unset API key, without its own text",
  async () => {
    const f = await fixture();
    try {
      const failed = f.nextCompleted();
      await f.session.notify!("no-key");
      await failed;
      const errors = f.events.filter((event) => event.type === "error");
      expect(errors).toEqual([{ type: "error", message: "DeepSeek API key is not set" }]);
    } finally {
      await f.close();
    }
  },
  TEST_BUDGET_MS,
);

for (const input of ["refuse", "model-failed"]) {
  test(
    `DSH submitted RPC error (${input}) fails the turn without rejecting or re-sending input`,
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
  "DSH exit after submission rejects an unknown outcome without re-sending it",
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
      expect(f.cleaned()).toBe(true);
      expect(await f.filesDeleted()).toBe(true);
    } finally {
      await f.close();
    }
  },
  TEST_BUDGET_MS,
);

test(
  "DSH disposal rejects input that has never been submitted",
  async () => {
    const f = await fixture();
    try {
      await f.session.dispose();
      await expect(f.session.notify!("retry elsewhere")).rejects.toThrow("before submission");
      expect((await f.records()).some((r) => r.method === "session/prompt")).toBe(false);
      expect(f.cleaned()).toBe(true);
    } finally {
      await f.close();
    }
  },
  TEST_BUDGET_MS,
);

test(
  "DSH startup fails explicitly for invalid instruction configuration and removes both files",
  async () => {
    let cleaned = false;
    await expect(
      fixture(undefined, true, async (files) => {
        for (const path of files) expect(await Bun.file(path).exists()).toBe(false);
        cleaned = true;
      }),
    ).rejects.toThrow("DSH startup failed: required CoForge instructions must be a string");
    expect(cleaned).toBe(true);
  },
  TEST_BUDGET_MS,
);

test(
  "DSH terminal disposal settles pending input and removes live-session launch files",
  async () => {
    const f = await fixture();
    try {
      await f.session.notify!("hold");
      const queued = f.session.notify!("not submitted").catch((error: unknown) => error);
      await f.session.dispose();
      expect(await queued).toMatchObject({
        message: "DSH queued input cancelled before submission",
      });
      expect(await f.filesDeleted()).toBe(true);
    } finally {
      await f.close();
    }
  },
  TEST_BUDGET_MS,
);

test(
  "DSH purging pending notices settles an undecided submitted admission as unknown",
  async () => {
    const f = await fixture();
    try {
      const pending = f.session.notify!("silent-hold").catch((error: unknown) => error);
      await f.waitForPrompt();
      f.session.cancelPendingNotices!();
      expect(await pending).toMatchObject({
        message: "DSH input cancelled; delivery outcome is unknown",
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
  "DSH non-cancelled terminal responses confirm admission even when the turn is truncated",
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
  "DSH reports a cleanup failure once when protocol failure and process exit converge",
  async () => {
    const f = await fixture(undefined, false, async () => {
      throw new Error("fixture cleanup failure");
    });
    try {
      const exited = Promise.withResolvers<void>();
      f.session.onExit(exited.resolve);
      await expect(f.session.notify!("invalid-json")).rejects.toThrow(
        "delivery outcome is unknown",
      );
      await exited.promise;
      expect(
        f.events.filter(
          (event) => event.type === "error" && event.message === "DSH process cleanup failed",
        ),
      ).toHaveLength(1);
    } finally {
      await expect(f.close()).rejects.toThrow("fixture cleanup failure");
    }
  },
  TEST_BUDGET_MS,
);

test(
  "DSH autonomous cancellation without acceptance evidence reports an unknown outcome",
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
