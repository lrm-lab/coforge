import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CatalogDiscoveryError, PROCESS_TREE_EXIT_GRACE_MS, within } from "@lrm/coforge-anvil";
import { withJsonlProcess } from "@lrm/coforge-anvil/execution";
import { jsonlCatalogHost } from "#src/code-agent/catalog-host";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

const fixture = new URL("../../anvil/test/fixtures/catalog-process.ts", import.meta.url).pathname;
const WAIT_MS = 1_500;
const BUDGET_MS = WAIT_MS + 2 * PROCESS_TREE_EXIT_GRACE_MS;

for (const outcome of ["success", "request-failure", "decode-failure", "spawn-failure"] as const) {
  test(
    "JSONL catalog preserves " + outcome,
    async () => {
      const cwd = await realpath(await mkdtemp(join(tmpdir(), "catalog-process-")));
      try {
        const environment = {
          CATALOG_FIXTURE_VALUE: "declared",
          CODEX_HOME: join(cwd, "codex-home"),
          FORCE_COLOR: "1",
          NO_COLOR: "original",
          COFORGE_DAEMON_HOME: "/must-not-inherit",
        };
        const discovered = withJsonlProcess(
          RUNTIME_PROVIDER.CODEX,
          outcome === "spawn-failure" ? [join(cwd, "missing-cli")] : [process.execPath, fixture],
          cwd,
          async (process, progress) => {
            expect(progress.stage).toBe("spawn");
            progress.stage = "model/list";
            if (outcome === "decode-failure") throw new CatalogDiscoveryError("fixture decode");
            const response = await within(
              process.request({ method: outcome === "request-failure" ? "fail" : "read" }),
              WAIT_MS,
            );
            return response.result;
          },
          environment,
          jsonlCatalogHost,
        );
        if (outcome === "spawn-failure") await expect(discovered).rejects.toThrow();
        else if (outcome === "success")
          expect(await discovered).toEqual({
            cwd,
            value: "declared",
            codexHome: environment.CODEX_HOME,
            color: "0",
            noColor: "original",
            daemonHome: null,
          });
        else expect(await discovered).toBeUndefined();
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
    BUDGET_MS,
  );
}
