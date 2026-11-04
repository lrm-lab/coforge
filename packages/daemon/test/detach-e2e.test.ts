import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalDaemonLauncher } from "#src/daemon-host/launcher";
import { startDaemonLocalRpcServer } from "#src/local-rpc";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { createComputerSelfClient } from "#src/connection/computer-self-client";
import { detachManagedBinding } from "#src/supervisor/machine-supervisor-detach";
import type { ManagedBinding, MachineSupervisor } from "#src/supervisor/machine-supervisor";
import { runWorkspaceLifecycleCommand } from "#src/supervisor/run-supervisor-workspace-lifecycle";
import type { ManagedRuntimeIdentity } from "@lrm/coforge-sdk/internal";
import { FileDaemonCredentialStore } from "#src/credentials/credential-store";
import { mkdtemp } from "node:fs/promises";

/** `coforge-computer detach` end to end (task #417): the launcher encodes the target into the
 * DaemonCommandRequest, the socket decode carries it to the workspace runtime, and the detach
 * reaches a real server with the locally stored sk_computer — every middle layer, not just
 * the two ends. */
test("a workspace detach reaches a real server with the stored key and reports key_revoked", async () => {
  const serverHits: { authorization: string; path: string }[] = [];
  const fake = Bun.serve({
    port: 0,
    fetch: async (request) => {
      serverHits.push({
        authorization: request.headers.get("authorization") ?? "",
        path: new URL(request.url).pathname,
      });
      return Response.json({ error: "computer_key_revoked" }, { status: 410 });
    },
  });
  const serverHttpUrl = `http://127.0.0.1:${fake.port}`;
  const socketPath = join(tmpdir(), `coforge-${crypto.randomUUID()}.sock`);
  const bindings: ManagedBinding[] = [
    {
      workspaceId: "ws",
      computerId: "computer-a",
      serverHttpUrl,
      workspaceRoot: "/workspaces/ws",
      enabled: true,
      processId: 0,
      instanceId: "",
      version: "",
      detachConfirmed: false,
    } as ManagedBinding,
  ];
  const daemonHome = await mkdtemp(join(tmpdir(), "detach-e2e-"));
  await new FileDaemonCredentialStore(daemonHome).save("ws", "computer-a", "sk_computer_stored");
  const supervisor = {
    detach: (workspaceId: string, options: Parameters<MachineSupervisor["detach"]>[1]) =>
      detachManagedBinding({
        workspaceId,
        bindings,
        store: async () => {},
        stop: async () => {},
        credentials: options.credentials,
        makeSelfClient: options.makeSelfClient,
        target: options.target,
      }),
  } as Pick<MachineSupervisor, "detach">;
  const server = await startDaemonLocalRpcServer({
    socketPath,
    serverUrl: "https://coforge.test",
    validateCredential: () => true,
    runtime: {
      configure: async () => {},
      command: async (method, request) => {
        if (method !== "daemon:detach") return { accepted: true, runtimes: [] };
        // The real lifecycle seam: the origin check drops a foreign target, and a revoked key's
        // answer becomes detachKeyRevoked on the way back (task #417).
        const outcome = await runWorkspaceLifecycleCommand({
          method,
          request,
          supervisor: supervisor as MachineSupervisor,
          view: async () => [],
          stateDirectory: daemonHome,
          refreshChildUpgradeConfig: async () => {},
          completeUpgrade: async () => {},
          watchPendingUpgrade: async () => {},
          launchComputerUpgrade: async () => {},
          makeSelfClient: createComputerSelfClient,
          ownServerUrl: serverHttpUrl,
          workspaceDirectory: () => daemonHome,
        });
        const detach = outcome as {
          runtimes: ManagedRuntimeIdentity[];
          detachKeyRevoked?: boolean;
        };
        return {
          runtimes: detach.runtimes,
          ...(detach.detachKeyRevoked ? { detachKeyRevoked: true } : {}),
        };
      },
    },
    credentials: new InMemoryDaemonCredentialStore(),
  });
  const launcher = new LocalDaemonLauncher({
    stateDirectory: tmpdir(),
    serverUrl: "https://coforge.test",
    executablePath: "/unused",
    socketPath,
  });

  const answer = await launcher.command("detach", "ws", {
    computerId: "computer-a",
    serverHttpUrl,
  });
  // The revoked-key marker rides the runtimes view as a keyed property, as the CLI reads it.
  expect((answer as typeof answer & { detachKeyRevoked?: boolean }).detachKeyRevoked).toBe(true);
  expect(serverHits).toEqual([
    { authorization: "Bearer sk_computer_stored", path: "/api/computer/detach" },
  ]);
  await server.close();
  fake.stop();
});

test("a login-style setup's loginSetup reaches the workspace runtime's configure", async () => {
  // Only a login-style setup retires the login it replaced — the flag survives the socket so a
  // one-shot attach's configure leaves the user's login alone (task #417).
  const socketPath = join(tmpdir(), `coforge-${crypto.randomUUID()}.sock`);
  let loginSetupSeen: boolean | undefined;
  const server = await startDaemonLocalRpcServer({
    socketPath,
    serverUrl: "https://coforge.test",
    validateCredential: () => true,
    runtime: {
      configure: async (_connection, options) => {
        loginSetupSeen = options?.loginSetup;
      },
    },
    credentials: new InMemoryDaemonCredentialStore(),
  });
  const launcher = new LocalDaemonLauncher({
    stateDirectory: tmpdir(),
    serverUrl: "https://coforge.test",
    executablePath: "/unused",
    socketPath,
  });
  await launcher.ensureStarted({
    workspaceId: "workspace-a",
    computerId: "computer-a",
    workspaceRoot: "/workspaces/workspace-a",
    daemonApiKey: "daemon-secret",
    loginSetup: true,
  });
  expect(loginSetupSeen).toBe(true);
  await launcher.ensureStarted({
    workspaceId: "workspace-a",
    computerId: "computer-a",
    workspaceRoot: "/workspaces/workspace-a",
    daemonApiKey: "daemon-secret",
  });
  expect(loginSetupSeen).toBeUndefined();
  await server.close();
});

test("a workspace detach's target reaches the workspace runtime's command handler", async () => {
  // `coforge-computer detach` sends computerId + serverHttpUrl so the daemon can tell the
  // server which key to revoke (task #417): the fields survive the socket, not just the CLI.
  const socketPath = join(tmpdir(), `coforge-${crypto.randomUUID()}.sock`);
  let seen: { method?: string; computerId?: string; serverHttpUrl?: string; workspaceId?: string } =
    {};
  const server = await startDaemonLocalRpcServer({
    socketPath,
    serverUrl: "https://coforge.test",
    validateCredential: () => true,
    runtime: {
      configure: async () => {},
      command: async (method, request) => {
        seen = {
          method,
          computerId: request.computerId,
          serverHttpUrl: request.serverHttpUrl,
          workspaceId: request.workspaceId,
        };
        return { accepted: true, runtimes: [] };
      },
    },
    credentials: new InMemoryDaemonCredentialStore(),
  });
  const launcher = new LocalDaemonLauncher({
    stateDirectory: tmpdir(),
    serverUrl: "https://coforge.test",
    executablePath: "/unused",
    socketPath,
  });
  await launcher.command("detach", "workspace-a", {
    computerId: "computer-a",
    serverHttpUrl: "https://coforge.test",
  });
  expect(seen).toEqual({
    method: "daemon:detach",
    computerId: "computer-a",
    serverHttpUrl: "https://coforge.test",
    workspaceId: "workspace-a",
  });
  await server.close();
});
