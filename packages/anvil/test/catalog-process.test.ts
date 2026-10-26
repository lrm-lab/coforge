import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { PROCESS_TREE_EXIT_GRACE_MS, within, type OwnedProcessTree } from "@lrm/coforge-anvil";
import { withJsonlProcess, type JsonlCatalogHost } from "@lrm/coforge-anvil/execution";
import { fixturePerTurnHost } from "./fixtures/runtime-host";

const fixture = new URL("./fixtures/catalog-process.ts", import.meta.url).pathname;
const WAIT_MS = 1_500;
const BUDGET_MS = 2 * WAIT_MS + 2 * PROCESS_TREE_EXIT_GRACE_MS;

for (const cleanupFails of [false, true]) {
  test(
    "catalog uses only its required host and retains its result when cleanup fails: " +
      cleanupFails,
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "anvil-catalog-process-"));
      const input = { CATALOG_FIXTURE_VALUE: "uncomposed" };
      const calls: string[] = [];
      let tree: OwnedProcessTree | undefined;
      const host: JsonlCatalogHost = {
        buildCatalogEnvironment(environment) {
          calls.push("environment");
          expect(environment).toBe(input);
          return { CATALOG_FIXTURE_VALUE: "from-host" };
        },
        processTreeSpawner: {
          spawn(command, directory, environment) {
            calls.push("spawn");
            tree = fixturePerTurnHost.processTreeSpawner.spawn(command, directory, environment);
            return cleanupFails
              ? {
                  ...tree,
                  waitForExit: async () => {
                    throw new Error("fixture process-table failure");
                  },
                }
              : tree;
          },
        },
      };
      try {
        const result = await withJsonlProcess(
          RUNTIME_PROVIDER.CODEX,
          [process.execPath, fixture],
          cwd,
          async (process, progress) => {
            expect(progress.stage).toBe("spawn");
            progress.stage = "model/list";
            calls.push("discover");
            return (await within(process.request({ method: "read" }), WAIT_MS)).result;
          },
          input,
          host,
        );
        expect(result).toMatchObject({ value: "from-host" });
        expect(calls).toEqual(["environment", "spawn", "discover"]);
      } finally {
        if (tree) {
          await tree.terminate(true);
          expect(await tree.waitForExit(WAIT_MS)).toBe(true);
        }
        await rm(cwd, { recursive: true, force: true });
      }
    },
    BUDGET_MS,
  );
}

for (const failure of ["environment", "spawn"] as const)
  test("catalog propagates a host " + failure + " failure before establishment", async () => {
    const expected = new Error("fixture " + failure);
    const calls: string[] = [];
    const run = withJsonlProcess(
      RUNTIME_PROVIDER.CODEX,
      ["unused"],
      "/unused",
      async () => {
        throw new Error("must not discover without a process");
      },
      {},
      {
        buildCatalogEnvironment() {
          calls.push("environment");
          if (failure === "environment") throw expected;
          return {};
        },
        processTreeSpawner: {
          spawn() {
            calls.push("spawn");
            throw expected;
          },
        },
      },
    );
    await expect(run).rejects.toBe(expected);
    expect(calls).toEqual(failure === "environment" ? ["environment"] : ["environment", "spawn"]);
  });
