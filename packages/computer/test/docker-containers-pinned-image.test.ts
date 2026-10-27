import { describe, expect, test } from "bun:test";

import {
  createDockerContainers,
  dockerActivateRuntimeArgs,
  dockerImageTagArgs,
  dockerServiceImageArgs,
  dockerServiceRestartArgs,
  dockerTaskFindArgs,
  stableImageTag,
} from "#src/host/docker-containers";

describe("pinned swarm images", () => {
  test("stableImageTag names a digest in the same repository", () => {
    const digest = `sha256:${"b".repeat(64)}`;
    expect(stableImageTag(`ghcr.io/lrm-lab/coforge-computer:staging@${digest}`, digest)).toBe(
      `ghcr.io/lrm-lab/coforge-computer:pinned-${"b".repeat(12)}`,
    );
  });

  test("a runtime restart tags the recorded image before recreating the task", async () => {
    const digest = `sha256:${"d".repeat(64)}`;
    const calls: string[][] = [];
    const runtime = createDockerContainers(async (args) => {
      calls.push(args);
      if (args[0] === "service" && args[1] === "inspect") {
        return { exitCode: 0, stdout: `coforge-computer:staging@${digest}\n`, stderr: "" };
      }
      if (args[0] === "ps") return { exitCode: 0, stdout: "ctr-1\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await runtime.activateRuntime("computer-1", "0.1.14-dev.4");
    expect(calls).toEqual([
      dockerServiceImageArgs("computer-1"),
      dockerImageTagArgs(digest, stableImageTag(`coforge-computer:staging@${digest}`, digest)),
      dockerTaskFindArgs("computer-1"),
      dockerActivateRuntimeArgs("ctr-1", "0.1.14-dev.4"),
      dockerServiceRestartArgs("computer-1"),
    ]);
  });
});
