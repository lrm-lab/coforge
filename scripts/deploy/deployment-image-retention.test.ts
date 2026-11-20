import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { parseRemoteOutputs } from "./deployment";
import { registryImage, requiredSecretNames } from "./deploy-test-support";

// remote-deploy.sh exits early when the requested image is already the healthy
// one; image retention still runs there. These cases pin that the report keeps
// its key=value shape under `set -euo pipefail` whether pruning is quiet or
// warns — a `deploy_warning` read before initialization used to kill the
// script with an unbound-variable error instead of reporting healthy.
describe("same-image deploy runs image retention and still reports", () => {
  async function deployNoop(fixture: { psFails?: boolean }) {
    const root = await mkdtemp(join(tmpdir(), "coforge-deploy-retention-"));
    try {
      await mkdir(join(root, "bin"));
      await mkdir(join(root, "secrets"));
      for (const name of requiredSecretNames) {
        await writeFile(join(root, "secrets", name), "fixture-private-value");
      }
      // The requested image is already the recorded healthy one: the script
      // takes the no-op branch before touching Compose or the registry.
      await writeFile(
        join(root, "state.env"),
        `CURRENT_WEB_IMAGE=${registryImage}\nPREVIOUS_WEB_IMAGE=\n`,
      );
      await writeFile(join(root, "docker-compose.yml"), "services: {}\n");
      // One local web image, far below the retention count: nothing is stale.
      await writeFile(
        join(root, "images.txt"),
        "sha256:img-aaa|ghcr.io/lrm-lab/coforge/coforge-web|2026-11-16 10:00:00 +0000 UTC\n",
      );
      await writeFile(
        join(root, "bin/docker"),
        `#!/bin/bash
echo "$*" >> "$FIXTURE_ROOT/calls"
case "$1" in
  images) cat "$FIXTURE_ROOT/images.txt" ;;
  ps) [[ "$*" = *service=artifact-checker* ]] && exit 0; [ -n "$PS_FAILS" ] && exit 1; printf 'c1\\n' ;;
  inspect) printf 'sha256:img-fff\\n' ;;
  image) printf 'sha256:img-fff\\n' ;;
  rmi) exit 0 ;;
esac
exit 0
`,
        { mode: 0o700 },
      );
      const proc = Bun.spawn(
        [
          "bash",
          new URL("./remote-deploy.sh", import.meta.url).pathname,
          "--image",
          registryImage,
          "--compose-file",
          join(root, "docker-compose.yml"),
          "--secrets-dir",
          join(root, "secrets"),
          "--state-file",
          join(root, "state.env"),
          "--web-health-url",
          "http://127.0.0.1/health",
          "--public-health-url",
          "https://example.test/health",
        ],
        {
          env: {
            ...Bun.env,
            PATH: `${join(root, "bin")}:${Bun.env.PATH}`,
            FIXTURE_ROOT: root,
            PS_FAILS: fixture.psFails ? "1" : "",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, code };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test("quiet retention reports healthy with no warning line", async () => {
    const result = await deployNoop({});
    expect(result.code).toBe(0);
    const report = parseRemoteOutputs(result.stdout);
    expect(report.outcome).toBe("healthy");
    expect(result.stdout).not.toContain("warning=");
  });

  test("a retention warning still reports healthy and carries warning=", async () => {
    const result = await deployNoop({ psFails: true });
    expect(result.code).toBe(0);
    const report = parseRemoteOutputs(result.stdout);
    expect(report.outcome).toBe("healthy");
    expect(result.stdout).toContain("warning=web image retention skipped");
    expect(result.stderr).toContain("could not enumerate containers");
  });
});
