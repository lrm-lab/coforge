import { VERSION_PROBE_TIMEOUT_MS, PROCESS_TREE_EXIT_GRACE_MS } from "@lrm/coforge-anvil";
import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DshProvider } from "@lrm/coforge-anvil/dsh";
import { dshRuntimeHost } from "#src/code-agent/dsh/host";
import type { AgentSession } from "@coforge/agent";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";

const TEST_ACP_TIMEOUT_MS = 10_000;
// Version probe, initialize/new/cancel, then TERM and KILL waits.
const TEST_BUDGET_MS =
  VERSION_PROBE_TIMEOUT_MS + 3 * TEST_ACP_TIMEOUT_MS + 2 * PROCESS_TREE_EXIT_GRACE_MS;

test("DSH host preserves the selected home and credentials and supplies the reviewed permission policy", () => {
  const environment = dshRuntimeHost.buildEnvironment({
    agentWorkspaceDirectory: "/agent",
    instructions: "instructions",
    runtime: {
      provider: "dsh",
      model: "",
      reasoning: "",
      envVars: { COFORGE_DAEMON_HOME: "/stale-host-scope" },
    },
    environment: { DEEPSEEK_API_KEY: "dummy-test-key", DSH_HOME: "/custom-dsh-home" },
  });
  expect(environment.DEEPSEEK_API_KEY).toBe("dummy-test-key");
  expect(environment.DSH_HOME).toBe("/custom-dsh-home");
  expect(environment.DSH_PERMISSION_MODE).toBe("danger-full-access");
  expect(environment.COFORGE_DAEMON_HOME).toBeUndefined();
});

for (const mode of ["exit", "cancel", "dispose", "startup-failure"] as const) {
  test(
    `DSH host deletes its private directory on ${mode}`,
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "dsh-host-lifecycle-"));
      let patchPath: string | undefined;
      let session: AgentSession | undefined;
      const provider = new DshProvider({
        acpTimeoutMs: TEST_ACP_TIMEOUT_MS,
        command: [process.execPath, anvilRuntimeFixtures.dsh],
        host: {
          ...dshRuntimeHost,
          buildEnvironment: () => ({ DSH_FIXTURE_LOG: join(cwd, "rpc.jsonl") }),
          prepareLaunch: async (instructions) => {
            const files = await dshRuntimeHost.prepareLaunch(instructions);
            patchPath = files.patchPath;
            return files;
          },
          ...(mode === "startup-failure"
            ? {
                processTreeSpawner: {
                  spawn() {
                    throw new Error("fixture spawn failed");
                  },
                },
              }
            : {}),
        },
      });
      try {
        const open = provider.createAgentSession({
          agentWorkspaceDirectory: cwd,
          instructions: "{{x}} 中文",
        });
        if (mode === "startup-failure") await expect(open).rejects.toThrow("fixture spawn failed");
        else {
          session = await open;
          const exited = Promise.withResolvers<void>();
          session.onExit(exited.resolve);
          if (mode === "exit") {
            await expect(session.notify!("exit-before-evidence")).rejects.toThrow(
              "delivery outcome is unknown",
            );
            await exited.promise;
          } else {
            await session.notify!("hold");
            if (mode === "cancel") await session.interrupt();
            else await session.dispose();
          }
        }
        expect(patchPath).toBeDefined();
        await expect(stat(dirname(patchPath!))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await session?.dispose();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    TEST_BUDGET_MS,
  );
}
