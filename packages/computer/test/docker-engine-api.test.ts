import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDockerContainers,
  swarmAccepting,
  type ContainerRuntime,
} from "#src/host/docker-containers";
import {
  createUnixDockerApiClient,
  DEFAULT_DOCKER_SOCKET_PATH,
  resolveDockerUnixSocketPath,
  type DockerApiClient,
} from "#src/host/docker-engine-api";
import { runHost } from "#src/host/run-host";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("resolveDockerUnixSocketPath", () => {
  test("returns default socket on linux when DOCKER_HOST is unset", () => {
    expect(resolveDockerUnixSocketPath({}, "linux")).toBe(DEFAULT_DOCKER_SOCKET_PATH);
    expect(resolveDockerUnixSocketPath({ DOCKER_CONTEXT: "default" }, "linux")).toBe(
      DEFAULT_DOCKER_SOCKET_PATH,
    );
    expect(resolveDockerUnixSocketPath({ DOCKER_TLS_VERIFY: "" }, "linux")).toBe(
      DEFAULT_DOCKER_SOCKET_PATH,
    );
  });

  test("extracts socket path from unix:// DOCKER_HOST", () => {
    expect(
      resolveDockerUnixSocketPath({ DOCKER_HOST: "unix:///run/user/1000/docker.sock" }, "linux"),
    ).toBe("/run/user/1000/docker.sock");
  });

  test("returns undefined for non-unix hosts, tls, custom contexts, or windows", () => {
    expect(
      resolveDockerUnixSocketPath({ DOCKER_HOST: "tcp://127.0.0.1:2375" }, "linux"),
    ).toBeUndefined();
    expect(resolveDockerUnixSocketPath({ DOCKER_HOST: "ssh://swarm" }, "linux")).toBeUndefined();
    expect(resolveDockerUnixSocketPath({ DOCKER_HOST: "unix://" }, "linux")).toBeUndefined();
    expect(resolveDockerUnixSocketPath({ DOCKER_TLS_VERIFY: "1" }, "linux")).toBeUndefined();
    expect(resolveDockerUnixSocketPath({ DOCKER_TLS_VERIFY: "0" }, "linux")).toBeUndefined();
    expect(resolveDockerUnixSocketPath({ DOCKER_TLS_VERIFY: "false" }, "linux")).toBeUndefined();
    expect(resolveDockerUnixSocketPath({ DOCKER_CONTEXT: "remote" }, "linux")).toBeUndefined();
    expect(resolveDockerUnixSocketPath({}, "win32")).toBeUndefined();
  });
});

describe("Docker Engine Unix socket client", () => {
  test("queries swarm readiness, placement, and desktop endpoint over a real unix socket with zero spawns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coforge-docker-sock-"));
    const socketPath = join(dir, "docker.sock");
    const requests: string[] = [];
    const imageDigest = `sha256:${"a".repeat(64)}`;
    const oldDigest = `sha256:${"b".repeat(64)}`;
    const olderDigest = `sha256:${"c".repeat(64)}`;

    let nodeState = "ready";
    let swarmError = false;
    let includeTokenInEnv = true;

    const server = Bun.serve({
      unix: socketPath,
      fetch(req) {
        const url = new URL(req.url);
        const pathWithQuery = `${url.pathname}${url.search}`;
        requests.push(pathWithQuery);

        if (url.pathname === "/nodes") {
          if (swarmError) {
            return Response.json({ message: "This node is not a swarm manager." }, { status: 503 });
          }
          return Response.json([{ Status: { State: "down" } }, { Status: { State: nodeState } }]);
        }

        if (url.pathname.startsWith("/images/") && url.pathname.endsWith("/json")) {
          const encodedName = url.pathname.slice("/images/".length, -"/json".length);
          expect(decodeURIComponent(encodedName)).toBe("ghcr.io/lrm-lab/coforge-computer:staging");
          return Response.json({
            Id: imageDigest,
            Config: {
              Labels: {
                "org.coforge.computer.version": "0.2.0-dev.5",
              },
            },
          });
        }

        if (url.pathname === "/containers/json") {
          const filtersRaw = url.searchParams.get("filters");
          const filters = filtersRaw ? (JSON.parse(filtersRaw) as { label?: string[] }) : {};
          const labelFilter = filters.label?.[0];
          if (labelFilter === "com.docker.swarm.service.name=coforge-computer-1") {
            return Response.json([{ Id: "ctr-1" }]);
          }
          if (labelFilter === "com.docker.swarm.service.name=coforge-missing") {
            return Response.json([]);
          }
          return Response.json([
            {
              Id: "ctr-1",
              Image: "ghcr.io/lrm-lab/coforge-computer:staging",
              ImageID: oldDigest,
              Labels: { "com.docker.swarm.service.name": "coforge-computer-1" },
            },
            {
              Id: "ctr-2",
              Image: `ghcr.io/lrm-lab/coforge-computer:staging@${olderDigest}`,
              ImageID: "",
              Labels: { "com.docker.swarm.service.name": "coforge-computer-2" },
            },
            {
              Id: "ctr-3",
              ImageID: oldDigest,
              Labels: { "com.docker.swarm.service.name": "other-stack" },
            },
          ]);
        }

        if (url.pathname === "/containers/ctr-1/json") {
          return Response.json({
            Config: {
              Env: includeTokenInEnv
                ? ["FOO=bar", "VNC_WS_TOKEN=first-tok", "VNC_WS_TOKEN=final-tok"]
                : ["FOO=bar"],
            },
            NetworkSettings: {
              Networks: {
                empty: { IPAddress: "" },
                ingress: { IPAddress: "10.0.0.12" },
              },
            },
          });
        }

        return Response.json({ message: "not found" }, { status: 404 });
      },
    });

    try {
      const api = createUnixDockerApiClient(socketPath);
      const spawnCalls: string[][] = [];
      const spawn = async (args: string[]) => {
        spawnCalls.push(args);
        if (args[0] === "exec") return { exitCode: 0, stdout: "fallback-file-tok\n", stderr: "" };
        return { exitCode: 1, stdout: "", stderr: "unexpected spawn" };
      };

      expect(await swarmAccepting(spawn, { api })).toBe(true);
      nodeState = "down";
      expect(await swarmAccepting(spawn, { api })).toBe(false);
      swarmError = true;
      expect(await swarmAccepting(spawn, { api })).toBe(false);
      expect(spawnCalls).toEqual([]);

      const runtime = createDockerContainers(spawn, { api });
      const placement = await runtime.inspectPlacement("ghcr.io/lrm-lab/coforge-computer:staging");
      expect(placement).toEqual({
        image: { id: imageDigest, version: "0.2.0-dev.5" },
        computers: [
          { computerId: "computer-1", imageId: oldDigest },
          { computerId: "computer-2", imageId: olderDigest },
        ],
      });
      expect(spawnCalls).toEqual([]);

      expect(await runtime.desktopEndpoint("computer-1")).toEqual({
        host: "10.0.0.12",
        port: 6080,
        token: "final-tok",
      });
      expect(await runtime.desktopEndpoint("missing")).toBeUndefined();
      expect(spawnCalls).toEqual([]);

      includeTokenInEnv = false;
      expect(await runtime.desktopEndpoint("computer-1")).toEqual({
        host: "10.0.0.12",
        port: 6080,
        token: "fallback-file-tok",
      });
      expect(spawnCalls).toEqual([["exec", "ctr-1", "cat", "/root/.vnc/ws-token.txt"]]);
      expect(requests.some((r) => r.startsWith("/nodes"))).toBe(true);
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("inspectPlacement fetches image and containers concurrently", async () => {
    const imageGate = deferred<void>();
    const containersGate = deferred<void>();
    let imageStarted = false;
    let containersStarted = false;
    const digest = `sha256:${"d".repeat(64)}`;

    const api: DockerApiClient = {
      async getJson(path) {
        if (path.startsWith("/images/")) {
          imageStarted = true;
          if (containersStarted) {
            imageGate.resolve();
            containersGate.resolve();
          }
          await imageGate.promise;
          return { status: 200, body: { Id: digest, Config: { Labels: {} } } };
        }
        if (path.startsWith("/containers/json")) {
          containersStarted = true;
          if (imageStarted) {
            imageGate.resolve();
            containersGate.resolve();
          }
          await containersGate.promise;
          return { status: 200, body: [] };
        }
        return { status: 404, body: { message: "not found" }, message: "not found" };
      },
    };

    const runtime = createDockerContainers(
      async () => ({ exitCode: 1, stdout: "", stderr: "should not spawn" }),
      { api },
    );
    const result = await runtime.inspectPlacement("coforge-computer:local");
    expect(result).toEqual({
      image: { id: digest, version: "" },
      computers: [],
    });
  });

  test("falls back to CLI spawn when the unix socket is unavailable", async () => {
    const missingSocket = join(tmpdir(), `coforge-missing-${Date.now()}.sock`);
    const api = createUnixDockerApiClient(missingSocket);
    const spawnCalls: string[][] = [];
    const digest = `sha256:${"e".repeat(64)}`;
    const spawn = async (args: string[]) => {
      spawnCalls.push(args);
      if (args[0] === "node") return { exitCode: 0, stdout: "Ready\n", stderr: "" };
      if (args[0] === "image") return { exitCode: 0, stdout: `${digest} 1.0.0\n`, stderr: "" };
      if (args[0] === "ps") return { exitCode: 0, stdout: "ctr-9\n", stderr: "" };
      if (args[0] === "inspect" && args[2]?.includes(".Config.Env")) {
        return { exitCode: 0, stdout: "VNC_WS_TOKEN=cli-tok\n---\n172.18.0.5\n", stderr: "" };
      }
      if (args[0] === "inspect") {
        return { exitCode: 0, stdout: `coforge-computer-9 ${digest}\n`, stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected" };
    };

    expect(await swarmAccepting(spawn, { api })).toBe(true);
    const runtime = createDockerContainers(spawn, { api });
    expect(await runtime.inspectPlacement("coforge-computer:local")).toEqual({
      image: { id: digest, version: "1.0.0" },
      computers: [{ computerId: "computer-9", imageId: digest }],
    });
    expect(await runtime.desktopEndpoint("computer-9")).toEqual({
      host: "172.18.0.5",
      port: 6080,
      token: "cli-tok",
    });
    expect(spawnCalls.length).toBeGreaterThanOrEqual(4);
  });

  test("runHost runs canPlace and inspectPlacement concurrently on each tick", async () => {
    const canPlaceGate = deferred<void>();
    const placementGate = deferred<void>();
    let canPlaceStarted = false;
    let placementStarted = false;
    const controller = new AbortController();

    const runtime: ContainerRuntime = {
      findService: async () => undefined,
      createService: async () => "svc-1",
      removeService: async () => undefined,
      attachWorkspace: async () => undefined,
      updateServiceImage: async () => undefined,
      activateRuntime: async () => undefined,
      inspectPlacement: async () => {
        placementStarted = true;
        if (canPlaceStarted) {
          canPlaceGate.resolve();
          placementGate.resolve();
        }
        await placementGate.promise;
        return { image: { id: "sha256:img", version: "1.0.0" }, computers: [] };
      },
      desktopEndpoint: async () => undefined,
    };

    let reportedAccepting: boolean | undefined;
    await runHost(
      {
        serverUrl: "https://server.example",
        token: "chn_tok",
        nodeKey: "node-1",
        name: "host-1",
        image: "coforge-computer:local",
        pollIntervalMs: 5000,
      },
      {
        cloud: {
          register: async () => undefined,
          heartbeat: async (_token, report) => {
            reportedAccepting = report.accepting;
          },
          claim: async () => null,
          report: async () => undefined,
        },
        containers: runtime,
        canPlace: async () => {
          canPlaceStarted = true;
          if (placementStarted) {
            canPlaceGate.resolve();
            placementGate.resolve();
          }
          await canPlaceGate.promise;
          return true;
        },
        wait: async () => {
          controller.abort();
        },
      },
      controller.signal,
    );

    expect(reportedAccepting).toBe(true);
  });

  test("does not fall back to CLI spawn on HTTP errors or timeouts", async () => {
    const spawnCalls: string[][] = [];
    const spawn = async (args: string[]) => {
      spawnCalls.push(args);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const errorApi: DockerApiClient = {
      async getJson() {
        return { status: 404, body: { message: "no such image" }, message: "no such image" };
      },
    };
    const errorRuntime = createDockerContainers(spawn, { api: errorApi });
    await expect(errorRuntime.inspectPlacement("missing:tag")).rejects.toThrow("no such image");
    await expect(errorRuntime.desktopEndpoint("computer-1")).rejects.toThrow("no such image");

    const timeoutApi: DockerApiClient = {
      async getJson() {
        throw new DOMException("timed out", "TimeoutError");
      },
    };
    expect(await swarmAccepting(spawn, { api: timeoutApi })).toBe(false);
    const timeoutRuntime = createDockerContainers(spawn, { api: timeoutApi });
    await expect(timeoutRuntime.inspectPlacement("coforge-computer:local")).rejects.toThrow(
      "timed out",
    );
    await expect(timeoutRuntime.desktopEndpoint("computer-1")).rejects.toThrow("timed out");
    expect(spawnCalls).toEqual([]);
  });

  test("api: null opts out of unix socket queries and uses CLI spawn", async () => {
    const spawnCalls: string[][] = [];
    const spawn = async (args: string[]) => {
      spawnCalls.push(args);
      if (args[0] === "node") return { exitCode: 0, stdout: "Ready\n", stderr: "" };
      if (args[0] === "ps") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    expect(await swarmAccepting(spawn, { api: null })).toBe(true);
    const runtime = createDockerContainers(spawn, { api: null });
    expect(await runtime.desktopEndpoint("computer-1")).toBeUndefined();
    expect(spawnCalls).toEqual([
      ["node", "ls", "--format", "{{.Status}}"],
      ["ps", "-q", "--filter", "label=com.docker.swarm.service.name=coforge-computer-1"],
    ]);
  });
});
