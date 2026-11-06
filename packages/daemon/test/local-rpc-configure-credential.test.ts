import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDaemonLauncher } from "#src/daemon-host/launcher";
import { startDaemonLocalRpcServer } from "#src/local-rpc";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";

const servers: Array<{ close(): Promise<void> }> = [];
const config = {
  workspaceId: "workspace-a",
  computerId: "computer-a",
  workspaceRoot: "/workspaces/workspace-a",
  daemonApiKey: "daemon-secret",
};
const launcherEnvironment = { stateDirectory: tmpdir(), serverUrl: "https://coforge.test" };

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function launchWith(
  stored: string,
  requestKey: string,
): Promise<InMemoryDaemonCredentialStore> {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(config.workspaceId, config.computerId, stored);
  const socketPath = join(tmpdir(), `coforge-${crypto.randomUUID()}.sock`);
  const server = await startDaemonLocalRpcServer({
    socketPath,
    serverUrl: launcherEnvironment.serverUrl,
    validateCredential: () => true,
    runtime: { configure: async () => {} },
    credentials,
  });
  servers.push(server);
  const launcher = new LocalDaemonLauncher({
    ...launcherEnvironment,
    executablePath: "/unused",
    socketPath,
    spawn: () => {},
    timeoutMilliseconds: 0,
  });
  await launcher.ensureStarted({ ...config, daemonApiKey: requestKey });
  return credentials;
}

test("a configure carrying a dk_ never overwrites a stored sk_computer", async () => {
  const stored = `sk_computer_${"s".repeat(43)}`;
  const credentials = await launchWith(stored, `dk_${"d".repeat(43)}`);

  // The attach env's dk_ lost to the stored sk_computer: writing it back would persist a key
  // confirm-key may already have revoked and park the Workspace on credential_revoked (#572).
  expect(await credentials.load(config.workspaceId, config.computerId)).toBe(stored);
});

test("a configure carrying an sk_computer still replaces a stored dk_", async () => {
  const requestKey = `sk_computer_${"n".repeat(43)}`;
  const credentials = await launchWith(`dk_${"a".repeat(43)}`, requestKey);

  expect(await credentials.load(config.workspaceId, config.computerId)).toBe(requestKey);
});
