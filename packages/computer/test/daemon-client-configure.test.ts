import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DaemonCommandRejectedError,
  InMemoryDaemonCredentialStore,
  LocalDaemonLauncher,
  startDaemonLocalRpcServer,
} from "@lrm/coforge-daemon";
import { ensureDaemonConfigured } from "#src/daemon-client/index";
import { ComputerSetupError } from "#src/errors";
import { formatHumanFailure } from "#src/cli/failure-output";
import { createSetup } from "./setup-fixture";

const servers: Array<{ close(): Promise<void> }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("ensureDaemonConfigured surfaces structured CONFIGURE error and errorCode and redacts secrets", async () => {
  const error = await ensureDaemonConfigured(
    {
      async ensureStarted() {
        throw new DaemonCommandRejectedError(
          "configure",
          "coforge-daemon did not accept configuration: Workspace directory is read-only token=secret-value",
          "workspace_root_unwritable",
          "workspace-id-a",
        );
      },
    },
    {
      workspaceId: "workspace-id-a",
      computerId: "computer-id",
      workspaceRoot: "/readonly/workspaces",
      daemonApiKey: "daemon-secret",
    },
  ).catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(ComputerSetupError);
  expect(error).toMatchObject({
    code: "SETUP_DAEMON_START_FAILED",
    stage: "daemon-start",
  });
  expect((error as Error).message).toContain("Workspace directory is read-only");
  expect((error as Error).message).toContain("(workspace_root_unwritable)");
  expect((error as Error).message).not.toContain("secret-value");
  expect((error as Error).message).not.toContain("local daemon socket closed");
});

test("coforge-computer setup reports the actual daemon CONFIGURE refusal reason over a real Unix socket", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-setup-ipc-"));
  tempDirs.push(stateDirectory);
  const socketPath = join(stateDirectory, "daemon.sock");
  const serverUrl = "https://coforge.example";
  const daemonCredentials = new InMemoryDaemonCredentialStore();
  let savedRegistrations = 0;

  const server = await startDaemonLocalRpcServer({
    socketPath,
    serverUrl,
    validateCredential: () => true,
    runtime: {
      configure: async () => {
        throw Object.assign(new Error("Workspace binding lock is held by another supervisor"), {
          code: "workspace_lock_busy",
        });
      },
    },
    credentials: daemonCredentials,
  });
  servers.push(server);

  const launcher = new LocalDaemonLauncher({
    stateDirectory,
    serverUrl,
    executablePath: "/unused",
    socketPath,
    timeoutMilliseconds: 0,
  });

  const setup = createSetup({
    launcher,
    config: {
      async loadCurrentProfile() {
        return { serverUrl };
      },
      async saveRegistration() {
        savedRegistrations += 1;
        return "/config/workspaces/id/config.json";
      },
      async discardRegistration() {},
    },
  });

  const failure = await setup
    .run({ workspaceSlug: "workspace-a" })
    .catch((reason: unknown) => reason);

  expect(failure).toBeInstanceOf(ComputerSetupError);
  const setupFailure = failure as ComputerSetupError;
  expect(setupFailure.code).toBe("SETUP_DAEMON_START_FAILED");
  expect(setupFailure.message).toContain("Workspace binding lock is held by another supervisor");
  expect(setupFailure.message).toContain("(workspace_lock_busy)");
  expect(setupFailure.message).not.toContain("local daemon socket closed");
  expect(formatHumanFailure(setupFailure.code, setupFailure.message, setupFailure.hint)).toContain(
    "Workspace binding lock is held by another supervisor (workspace_lock_busy)",
  );
  expect(savedRegistrations).toBe(0);
  expect(await daemonCredentials.load("workspace-id-a", "computer-id")).toBeNull();
});

test("resumeAttached surfaces structured daemon CONFIGURE refusal during setup resume", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-resume-ipc-"));
  tempDirs.push(stateDirectory);
  const socketPath = join(stateDirectory, "daemon.sock");
  const serverUrl = "https://coforge.example";
  const storedKey = `sk_computer_${"r".repeat(43)}`;
  const daemonCredentials = new InMemoryDaemonCredentialStore();
  await daemonCredentials.save("workspace-id-a", "computer-id", storedKey);

  const server = await startDaemonLocalRpcServer({
    socketPath,
    serverUrl,
    validateCredential: () => true,
    runtime: {
      configure: async () => {
        throw Object.assign(new Error("Coordinator rejected workspace start"), {
          code: "coordinator_refused",
        });
      },
    },
    credentials: daemonCredentials,
  });
  servers.push(server);

  const setup = createSetup({
    launcher: new LocalDaemonLauncher({
      stateDirectory,
      serverUrl,
      executablePath: "/unused",
      socketPath,
      timeoutMilliseconds: 0,
    }),
    config: {
      async loadCurrentProfile() {
        return { serverUrl };
      },
      async loadRegistration() {
        return { id: "workspace-id-a", slug: "workspace-a", computerId: "computer-id" };
      },
      async saveRegistration() {
        return "/config/workspaces/id/config.json";
      },
      async discardRegistration() {},
    },
    resume: {
      storedKey: async () => storedKey,
      self: async () => ({ state: "live" }),
    },
  });

  const failure = await setup
    .run({ workspaceSlug: "workspace-a" })
    .catch((reason: unknown) => reason);

  expect(failure).toBeInstanceOf(ComputerSetupError);
  expect((failure as ComputerSetupError).message).toContain(
    "Coordinator rejected workspace start (coordinator_refused)",
  );
});
