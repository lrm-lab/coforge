import { describe, expect, test } from "bun:test";

import {
  createDockerContainers,
  dockerAttachExecArgs,
  dockerCloudContainerListArgs,
  dockerCloudPlacementInspectArgs,
  dockerImageDigestArgs,
  dockerImageInspectArgs,
  dockerServiceCreateArgs,
  dockerServiceFindArgs,
  dockerServiceRemoveArgs,
  dockerServiceUpdateArgs,
  dockerVolumeRemoveArgs,
  pinnedImageReference,
  swarmAccepting,
  type ContainerRuntime,
} from "#src/host/docker-containers";
import { HttpHostCloud } from "#src/host/host-cloud";
import { acceptClaimedJob, runHost, type ClaimedContainerJob } from "#src/host/run-host";

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
    inspectPlacement: async () => ({
      image: { id: "sha256:img", version: "1.0.0" },
      computers: [],
    }),
    desktopEndpoint: async () => undefined,
    ...overrides,
  };
}

describe("host process", () => {
  test("one create claim places one service and reports its id", async () => {
    const runs: string[] = [];
    const reports: Array<string | undefined> = [];
    await acceptClaimedJob(job, config, {
      containers: containers({
        findService: async () => undefined,
        createService: async (input) => {
          runs.push(input.computerId);
          expect(input.image).toBe("coforge-computer:local");
          const { VNC_WS_TOKEN: desktopToken, ...env } = input.env;
          expect(desktopToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
          expect(env).toEqual({
            COFORGE_DAEMON_API_KEY: daemonKey,
            COFORGE_WORKSPACE_ID: "workspace-1",
            COFORGE_WORKSPACE_SLUG: "alpha",
            COFORGE_COMPUTER_ID: "computer-1",
            COFORGE_COMPUTER_NAME: "lab",
            COFORGE_SERVER_URL: "https://server.example",
          });
          expect(JSON.stringify(input.env)).not.toContain("refresh");
          return "service-1";
        },
        removeService: async () => {
          throw new Error("unexpected remove");
        },
        attachWorkspace: async () => {
          throw new Error("unexpected attach");
        },
        updateServiceImage: async () => {
          throw new Error("unexpected update");
        },
      }),
      report: async (containerId) => {
        reports.push(containerId);
      },
    });
    expect(runs).toEqual(["computer-1"]);
    expect(reports).toEqual(["service-1"]);
  });

  test("an existing service is reported without creating another", async () => {
    let runs = 0;
    const reports: Array<string | undefined> = [];
    await acceptClaimedJob(job, config, {
      containers: containers({
        findService: async (computerId) =>
          computerId === "computer-1" ? "service-existing" : undefined,
        createService: async () => {
          runs += 1;
          return "service-new";
        },
      }),
      report: async (id) => {
        reports.push(id);
      },
    });
    expect(reports).toEqual(["service-existing"]);
    expect(runs).toBe(0);
  });

  test("delete removes the service and attach writes the workspace into the running task", async () => {
    const calls: string[] = [];
    await acceptClaimedJob({ ...job, operation: "delete", daemonApiKey: null }, config, {
      containers: containers({
        removeService: async (computerId) => {
          calls.push(`remove:${computerId}`);
        },
      }),
      report: async (id) => {
        calls.push(`report:${id ?? ""}`);
      },
    });
    await acceptClaimedJob({ ...job, operation: "attach", jobId: "job-2" }, config, {
      containers: containers({
        findService: async () => "service-1",
        attachWorkspace: async (input) => {
          calls.push(`attach:${input.computerId}`);
          expect(input.env.COFORGE_WORKSPACE_ID).toBe("workspace-1");
        },
      }),
      report: async (id) => {
        calls.push(`report:${id ?? ""}`);
      },
    });
    expect(calls).toEqual([
      "remove:computer-1",
      "report:",
      "attach:computer-1",
      "report:computer-1",
    ]);
  });

  test("update replaces the service image and does not remove the volume", async () => {
    const calls: string[] = [];
    await acceptClaimedJob({ ...job, operation: "update", daemonApiKey: null }, config, {
      containers: containers({
        updateServiceImage: async (computerId, image) => {
          calls.push(`update:${computerId}:${image}`);
        },
        removeService: async () => {
          throw new Error("unexpected remove");
        },
      }),
      report: async (id) => {
        calls.push(`report:${id ?? ""}`);
      },
    });
    expect(calls).toEqual(["update:computer-1:coforge-computer:local", "report:computer-1"]);
  });

  test("a tick registers, heartbeats, claims, and stops when the signal aborts", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    await runHost(
      config,
      {
        cloud: {
          register: async () => {
            calls.push("register");
          },
          heartbeat: async (_token, report) => {
            calls.push(`heartbeat:${report.accepting}`);
          },
          claim: async () => {
            calls.push("claim");
            return null;
          },
          report: async () => {
            calls.push("report");
          },
        },
        containers: containers(),
        canPlace: async () => false,
        wait: async () => {
          calls.push("wait");
          controller.abort();
        },
      },
      controller.signal,
    );
    expect(calls).toEqual(["register", "heartbeat:false", "claim", "wait"]);
  });
});

describe("host cloud HTTP", () => {
  test("register, claim, and report use the host token and the host routes", async () => {
    const requests: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      const url = String(input);
      if (url.endsWith("/jobs/claim")) {
        return Response.json({ job });
      }
      return Response.json({ ok: true });
    };
    const cloud = new HttpHostCloud(fetchImpl, "https://server.example/");
    await cloud.register({ token: "chn_token", nodeKey: "machine-1", name: "lab-host" });
    await cloud.heartbeat("chn_token", {
      accepting: true,
      image: { id: "sha256:new", version: "0.1.3-dev.2" },
      computers: [{ computerId: "computer-1", imageId: "sha256:old" }],
    });
    expect(await cloud.claim("chn_token")).toEqual(job);
    await cloud.report("chn_token", "job-1", "container-1");
    expect(requests).toEqual([
      {
        url: "https://server.example/api/hosts/register",
        authorization: "Bearer chn_token",
        body: { nodeKey: "machine-1", name: "lab-host" },
      },
      {
        url: "https://server.example/api/hosts/heartbeat",
        authorization: "Bearer chn_token",
        body: {
          accepting: true,
          image: { id: "sha256:new", version: "0.1.3-dev.2" },
          computers: [{ computerId: "computer-1", imageId: "sha256:old" }],
        },
      },
      {
        url: "https://server.example/api/hosts/jobs/claim",
        authorization: "Bearer chn_token",
        body: null,
      },
      {
        url: "https://server.example/api/hosts/jobs/job-1/report",
        authorization: "Bearer chn_token",
        body: { containerId: "container-1" },
      },
    ]);
  });
});

describe("swarm service arguments", () => {
  test("find, create, remove, and attach address one computer service", () => {
    expect(dockerServiceFindArgs("computer-1")).toEqual([
      "service",
      "ls",
      "-q",
      "--filter",
      "label=coforge.computer_id=computer-1",
    ]);
    expect(
      dockerServiceCreateArgs({
        computerId: "computer-1",
        image: "coforge-computer:local",
        env: { COFORGE_SERVER_URL: "https://server.example" },
      }),
    ).toEqual([
      "service",
      "create",
      "--no-resolve-image",
      "--name",
      "coforge-computer-1",
      "--replicas",
      "1",
      "--restart-condition",
      "any",
      "--label",
      "coforge.computer_id=computer-1",
      "--mount",
      "type=volume,src=coforge-computer-1,dst=/root/.coforge",
      "--mount",
      "type=volume,src=coforge-computer-1-opt,dst=/opt",
      "--env",
      "COFORGE_SERVER_URL=https://server.example",
      "coforge-computer:local",
    ]);
    expect(dockerServiceRemoveArgs("computer-1")).toEqual(["service", "rm", "coforge-computer-1"]);
    expect(dockerVolumeRemoveArgs("computer-1")).toEqual(["volume", "rm", "coforge-computer-1"]);
    expect(dockerServiceUpdateArgs("computer-1", "coforge-computer:staging")).toEqual([
      "service",
      "update",
      "--no-resolve-image",
      "--image",
      "coforge-computer:staging",
      "--force",
      "coforge-computer-1",
    ]);
    expect(dockerImageInspectArgs("coforge-computer:staging")).toEqual([
      "image",
      "inspect",
      "-f",
      '{{.Id}} {{index .Config.Labels "org.coforge.computer.version"}}',
      "coforge-computer:staging",
    ]);
    expect(dockerCloudContainerListArgs()).toEqual([
      "ps",
      "-q",
      "--filter",
      "label=com.docker.swarm.service.name",
    ]);
    expect(dockerCloudPlacementInspectArgs(["abc"])).toEqual([
      "inspect",
      "-f",
      '{{index .Config.Labels "com.docker.swarm.service.name"}} {{.Image}}',
      "abc",
    ]);
    expect(dockerAttachExecArgs("task-1", { COFORGE_WORKSPACE_ID: "workspace-2" })).toEqual([
      "exec",
      "--env",
      "COFORGE_WORKSPACE_ID=workspace-2",
      "task-1",
      "coforge-computer",
      "__attach-workspace",
    ]);
  });

  test("attach runs inside the existing task and does not replace the service", async () => {
    const calls: string[][] = [];
    const containers = createDockerContainers(async (args) => {
      calls.push(args);
      if (args[0] === "ps") return { exitCode: 0, stdout: "task-1\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await containers.attachWorkspace({
      computerId: "computer-1",
      env: { COFORGE_WORKSPACE_ID: "workspace-2" },
    });
    expect(calls).toEqual([
      ["ps", "-q", "--filter", "label=com.docker.swarm.service.name=coforge-computer-1"],
      [
        "exec",
        "--env",
        "COFORGE_WORKSPACE_ID=workspace-2",
        "task-1",
        "coforge-computer",
        "__attach-workspace",
      ],
    ]);
  });

  test("creating or updating a service pins the local image digest", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const calls: string[][] = [];
    const runtime = createDockerContainers(async (args) => {
      calls.push(args);
      if (args[0] === "image") {
        return { exitCode: 0, stdout: `coforge-computer@${digest}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "service-1\n", stderr: "" };
    });
    await runtime.createService({
      computerId: "computer-1",
      image: "coforge-computer:staging",
      env: {},
    });
    await runtime.updateServiceImage("computer-1", "coforge-computer:staging");
    const pinned = `coforge-computer:staging@${digest}`;
    expect(calls).toEqual([
      dockerImageDigestArgs("coforge-computer:staging"),
      dockerServiceCreateArgs({
        computerId: "computer-1",
        image: pinned,
        env: {},
      }),
      dockerImageDigestArgs("coforge-computer:staging"),
      dockerServiceUpdateArgs("computer-1", pinned),
    ]);
    expect(calls.some((args) => args[0] === "volume")).toBe(false);
  });

  test("an image reference that already has a digest is not inspected again", async () => {
    const digest = `sha256:${"b".repeat(64)}`;
    const pinned = `coforge-computer:staging@${digest}`;
    const calls: string[][] = [];
    const runtime = createDockerContainers(async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: "service-1\n", stderr: "" };
    });
    await runtime.createService({ computerId: "computer-1", image: pinned, env: {} });
    expect(calls).toEqual([
      dockerServiceCreateArgs({ computerId: "computer-1", image: pinned, env: {} }),
    ]);
    expect(pinnedImageReference("coforge-computer:staging", `sha256:${"c".repeat(64)}`)).toBe(
      `coforge-computer:staging@sha256:${"c".repeat(64)}`,
    );
    expect(() => pinnedImageReference("coforge-computer:staging", "not-a-digest")).toThrow(
      /unusable image id/,
    );
  });

  test("placement reports the node image and each running computer's image id", async () => {
    const runtime = createDockerContainers(async (args) => {
      if (args[0] === "image")
        return {
          exitCode: 0,
          stdout: "sha256:new 0.1.3-dev.2\n",
          stderr: "",
        };
      if (args[0] === "ps") return { exitCode: 0, stdout: "ctr-1\n", stderr: "" };
      if (args[0] === "inspect")
        return {
          exitCode: 0,
          stdout:
            "coforge-computer-1 sha256:old\nother-stack sha256:ignored\ncoforge-0ca18953-635c-4f7f-ba04-1a20e09bac03 sha256:older\n",
          stderr: "",
        };
      return { exitCode: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
    });
    expect(await runtime.inspectPlacement("coforge-computer:staging")).toEqual({
      image: { id: "sha256:new", version: "0.1.3-dev.2" },
      computers: [
        { computerId: "computer-1", imageId: "sha256:old" },
        {
          computerId: "0ca18953-635c-4f7f-ba04-1a20e09bac03",
          imageId: "sha256:older",
        },
      ],
    });
  });

  test("placement reports image ids without probing the runtime version", async () => {
    const calls: string[][] = [];
    const digest = `sha256:${"cd".repeat(32)}`;
    const runtime = createDockerContainers(async (args) => {
      calls.push(args);
      if (args[0] === "image") return { exitCode: 0, stdout: `${digest}\n`, stderr: "" };
      if (args[0] === "ps") return { exitCode: 0, stdout: "ctr-1\n", stderr: "" };
      if (args[0] === "inspect")
        return {
          exitCode: 0,
          stdout: `coforge-computer-1 coforge-computer:staging@${digest}\n`,
          stderr: "",
        };
      return { exitCode: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
    });
    expect(await runtime.inspectPlacement("coforge-computer:staging")).toEqual({
      image: { id: digest, version: "" },
      computers: [{ computerId: "computer-1", imageId: digest }],
    });
    expect(calls.some((args) => args[0] === "run")).toBe(false);
  });

  test("removing a service also removes its disk volume", async () => {
    const calls: string[][] = [];
    const containers = createDockerContainers(async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await containers.removeService("computer-1");
    expect(calls).toEqual([
      ["service", "rm", "coforge-computer-1"],
      ["volume", "rm", "coforge-computer-1"],
      ["volume", "rm", "coforge-computer-1-opt"],
    ]);
  });

  test("a service or volume Docker already reports missing is already removed", async () => {
    const calls: string[][] = [];
    const containers = createDockerContainers(async (args) => {
      calls.push(args);
      const name = args[2] ?? "";
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Error response from daemon: ${args[0]} ${name} not found\n`,
      };
    });
    await containers.removeService("computer-1");
    expect(calls).toEqual([
      ["service", "rm", "coforge-computer-1"],
      ["volume", "rm", "coforge-computer-1"],
      ["volume", "rm", "coforge-computer-1-opt"],
    ]);
  });

  test("containers still holding the disk are removed before the volume", async () => {
    const calls: string[][] = [];
    const containers = createDockerContainers(async (args) => {
      calls.push(args);
      if (args[0] === "volume" && calls.filter((call) => call[0] === "volume").length === 1) {
        return {
          exitCode: 1,
          stdout: "",
          stderr:
            "Error response from daemon: remove coforge-computer-1: volume is in use - [abc123, def456]\n",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await containers.removeService("computer-1");
    expect(calls).toEqual([
      ["service", "rm", "coforge-computer-1"],
      ["volume", "rm", "coforge-computer-1"],
      ["rm", "-f", "abc123", "def456"],
      ["volume", "rm", "coforge-computer-1"],
      ["volume", "rm", "coforge-computer-1-opt"],
    ]);
  });

  test("accepting is true only when a swarm node is Ready", async () => {
    expect(
      await swarmAccepting(async () => ({ exitCode: 0, stdout: "Ready\nDown\n", stderr: "" })),
    ).toBe(true);
    expect(await swarmAccepting(async () => ({ exitCode: 0, stdout: "Down\n", stderr: "" }))).toBe(
      false,
    );
    expect(
      await swarmAccepting(async () => ({ exitCode: 1, stdout: "", stderr: "not a swarm" })),
    ).toBe(false);
  });
});
