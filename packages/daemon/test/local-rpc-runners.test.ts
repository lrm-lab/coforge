import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDaemonLauncher } from "#src/daemon-host/launcher";
import { startDaemonLocalRpcServer } from "#src/local-rpc";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";

const servers: Array<{ close(): Promise<void> }> = [];
const env = { stateDirectory: tmpdir(), serverUrl: "https://coforge.test" };

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

test("operator runner RPC lists and stops only the requested local Agent", async () => {
  const socketPath = join(tmpdir(), `coforge-${crypto.randomUUID()}.sock`);
  const runners = [
    {
      workspaceId: "workspace-a",
      agentId: "agent-a",
      provider: "pi",
      model: "default",
      state: "running" as const,
      hasLiveTurn: false,
    },
  ];
  const stopped: string[] = [];
  const server = await startDaemonLocalRpcServer({
    socketPath,
    serverUrl: env.serverUrl,
    validateCredential: () => true,
    runtime: {
      runnerIdentities: () => runners,
      stopAgent: async (agentId) => {
        stopped.push(agentId);
        runners.splice(0, runners.length);
      },
    },
    credentials: new InMemoryDaemonCredentialStore(),
  });
  servers.push(server);
  const launcher = new LocalDaemonLauncher({ ...env, executablePath: "/unused", socketPath });

  await expect(launcher.runners!("list", "workspace-a")).resolves.toEqual([
    expect.objectContaining({ agentId: "agent-a", workspaceId: "workspace-a" }),
  ]);
  await expect(launcher.runners!("stop", "workspace-a", "agent-a")).resolves.toEqual([]);
  expect(stopped).toEqual(["agent-a"]);
});
