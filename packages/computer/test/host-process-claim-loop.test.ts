import { describe, expect, test } from "bun:test";

import { type ContainerRuntime } from "#src/host/docker-containers";
import { runHost, type ClaimedContainerJob } from "#src/host/run-host";

const daemonKey = `dk_${"b".repeat(43)}`;

const job: ClaimedContainerJob = {
  jobId: "job-1",
  operation: "create",
  computerId: "computer-1",
  workspaceId: "workspace-1",
  workspaceSlug: "alpha",
  name: "lab",
  daemonApiKey: daemonKey,
};

const config = {
  serverUrl: "https://server.example",
  token: "chn_token",
  nodeKey: "machine-1",
  name: "lab-host",
  image: "coforge-computer:local",
  pollIntervalMs: 5000,
};

function containers(overrides: Partial<ContainerRuntime> = {}): ContainerRuntime {
  return {
    findService: async () => undefined,
    createService: async () => "service-1",
    removeService: async () => undefined,
    attachWorkspace: async () => undefined,
    updateServiceImage: async () => undefined,
    activateRuntime: async () => undefined,
    inspectPlacement: async () => ({
      image: { id: "sha256:img", version: "1.0.0" },
      computers: [],
    }),
    desktopEndpoint: async () => undefined,
    ...overrides,
  };
}

describe("host process claim loop", () => {
  test("a failed job does not stop the claim loop", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    let claims = 0;
    await runHost(
      config,
      {
        cloud: {
          register: async () => {
            calls.push("register");
          },
          heartbeat: async () => {
            calls.push("heartbeat");
          },
          claim: async () => {
            claims += 1;
            calls.push("claim");
            return claims === 1 ? job : null;
          },
          report: async () => {
            calls.push("report");
          },
        },
        containers: containers({
          createService: async () => {
            throw new Error("cloud computer task is not running");
          },
        }),
        canPlace: async () => false,
        wait: async () => {
          calls.push("wait");
          if (claims >= 2) controller.abort();
        },
      },
      controller.signal,
    );
    expect(calls).toEqual(["register", "heartbeat", "claim", "wait", "heartbeat", "claim", "wait"]);
  });
});
