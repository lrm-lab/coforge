import { describe, expect, test } from "bun:test";

import {
  createDockerContainers,
  dockerAttachExecArgs,
  dockerServiceCreateArgs,
  dockerServiceFindArgs,
  dockerServiceRemoveArgs,
  dockerVolumeRemoveArgs,
  swarmAccepting,
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

describe("host process", () => {
  test("one create claim places one service and reports its id", async () => {
    const runs: string[] = [];
    const reports: Array<string | undefined> = [];
    await acceptClaimedJob(job, config, {
      containers: {
        findService: async () => undefined,
        createService: async (input) => {
          runs.push(input.computerId);
          expect(input.image).toBe("coforge-computer:local");
          expect(input.env).toEqual({
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
      },
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
      containers: {
        findService: async (computerId) =>
          computerId === "computer-1" ? "service-existing" : undefined,
        createService: async () => {
          runs += 1;
          return "service-new";
        },
        removeService: async () => undefined,
        attachWorkspace: async () => undefined,
      },
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
      containers: {
        findService: async () => undefined,
        createService: async () => "service-1",
        removeService: async (computerId) => {
          calls.push(`remove:${computerId}`);
        },
        attachWorkspace: async () => undefined,
      },
      report: async (id) => {
        calls.push(`report:${id ?? ""}`);
      },
    });
    await acceptClaimedJob({ ...job, operation: "attach", jobId: "job-2" }, config, {
      containers: {
        findService: async () => "service-1",
        createService: async () => "service-new",
        removeService: async () => undefined,
        attachWorkspace: async (input) => {
          calls.push(`attach:${input.computerId}`);
          expect(input.env.COFORGE_WORKSPACE_ID).toBe("workspace-1");
        },
      },
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
          heartbeat: async (_token, accepting) => {
            calls.push(`heartbeat:${accepting}`);
          },
          claim: async () => {
            calls.push("claim");
            return null;
          },
          report: async () => {
            calls.push("report");
          },
        },
        containers: {
          findService: async () => undefined,
          createService: async () => "service-1",
          removeService: async () => undefined,
          attachWorkspace: async () => undefined,
        },
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
    expect(await cloud.claim("chn_token")).toEqual(job);
    await cloud.report("chn_token", "job-1", "container-1");
    expect(requests).toEqual([
      {
        url: "https://server.example/api/hosts/register",
        authorization: "Bearer chn_token",
        body: { nodeKey: "machine-1", name: "lab-host" },
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
      "--env",
      "COFORGE_SERVER_URL=https://server.example",
      "coforge-computer:local",
    ]);
    expect(dockerServiceRemoveArgs("computer-1")).toEqual(["service", "rm", "coforge-computer-1"]);
    expect(dockerVolumeRemoveArgs("computer-1")).toEqual(["volume", "rm", "coforge-computer-1"]);
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
