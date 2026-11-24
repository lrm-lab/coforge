import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DaemonCommandRejectedError,
  FileBindingStore,
  WorkspaceHealthJournal,
  workspaceHealthJournalPath,
  workspaceStateDirectory,
} from "@lrm/coforge-daemon";
import { runCli } from "#src/cli";
import { createCommand as createDaemonCommand } from "#src/cli/daemon-commands";
import { FileComputerConfig } from "#src/local-config";
import { createStatusPorts } from "#src/status/create-status-ports";
import { createStatusCommand } from "#src/status/status-command";

const computerId = "01a20f2d-e70c-7668-871e-cf77f284b1fc";
const workspace = { id: "ws-a", slug: "acme", computerId };
const serverUrl = "https://coforge.cn";
const parkedAt = new Date("2026-01-01T00:00:00.000Z");
const recoveryCommand = `coforge-computer setup --workspace acme --machine ${computerId}`;

async function withParkedBinding(
  run: (directory: string, config: FileComputerConfig) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "parked-computer-"));
  try {
    const config = new FileComputerConfig(join(directory, "computer"));
    await config.saveRegistration(workspace);
    await new FileBindingStore(directory, serverUrl).save([
      {
        workspaceId: workspace.id,
        computerId,
        workspaceRoot: join(directory, "workspace"),
        serverHttpUrl: serverUrl,
        enabled: true,
      },
    ]);
    await new WorkspaceHealthJournal(
      workspaceHealthJournalPath(workspaceStateDirectory(directory, workspace.id)),
      () => parkedAt.getTime(),
    ).markParked("credential_revoked");
    await run(directory, config);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function statusForParkedBinding(
  directory: string,
  config: FileComputerConfig,
  { json = false, missingId = false } = {},
): Promise<string> {
  const lines: string[] = [];
  const write = (line: string) => lines.push(line);
  const io = { stdout: write, stderr: write };
  const ports = createStatusPorts({
    platform: "linux",
    installDirectory: join(directory, "install"),
    stateDirectory: directory,
    registrations: config,
    releaseFeedUrl: "https://releases.coforge.cn/",
    serverUrl,
  });
  const code = await runCli(
    ["status", ...(json ? ["--json"] : [])],
    {
      login: { async run() {} },
      setup: { async run() {} },
      status: createStatusCommand(io, {
        ...ports,
        now: () => parkedAt,
        probeCoordinator: async () => ({ loaded: false, pid: null }),
        readServiceDefinition: async () => null,
        probeDaemonSnapshot: async () => ({ reachable: true, runtimes: [] }),
        ...(missingId
          ? {
              async loadBindings() {
                const loaded = await ports.loadBindings();
                if (!loaded.ok) return loaded;
                return {
                  ok: true,
                  bindings: loaded.bindings.map((binding) => ({
                    ...binding,
                    computerId: undefined,
                  })),
                };
              },
            }
          : {}),
      }),
    },
    io,
  );
  expect(code).toBe(0);
  return lines.join("\n");
}

test("status uses the parked binding's Computer ID in text and preserves JSON", () =>
  withParkedBinding(async (directory, config) => {
    const knownJson = await statusForParkedBinding(directory, config, { json: true });
    expect(knownJson).toBe(
      await statusForParkedBinding(directory, config, { json: true, missingId: true }),
    );
    expect(knownJson).not.toContain(computerId);
    expect(JSON.parse(knownJson).workspaces.workspaces[0].health).toEqual({
      status: "parked",
      reason: "credential_revoked",
      since: parkedAt.toISOString(),
    });
    const human = await statusForParkedBinding(directory, config);
    expect(human).toContain("This Computer's credential for Workspace acme was revoked");
    expect(human).toContain(recoveryCommand);
    expect(human).not.toContain("detach");
  }));

test("status says where to find the original Computer ID when it is absent locally", () =>
  withParkedBinding(async (directory, config) => {
    const human = await statusForParkedBinding(directory, config, { missingId: true });
    expect(human).toContain("Open the original device on the Computers page");
    expect(human).toContain("copy the ID after /computer/ in its URL");
    expect(human).toContain(
      "coforge-computer setup --workspace acme --machine <original-computer-id>",
    );
  }));

test.each(["start", "restart"] as const)(
  "CLI %s retains the Computer ID from the registration after revocation",
  (operation) =>
    withParkedBinding(async (directory, config) => {
      const lines: string[] = [];
      const write = (line: string) => lines.push(line);
      const io = { stdout: write, stderr: write };
      const daemon = createDaemonCommand(
        "darwin",
        directory,
        directory,
        serverUrl,
        config,
        undefined,
        io,
        {
          launcher: {
            ensureRunning: async () => {},
            isRunning: async () => true,
            assertRestartable: async () => {},
            stop: async () => {},
            command: async () => {
              throw new DaemonCommandRejectedError(
                operation,
                "Credential revoked",
                "credential_revoked",
                workspace.id,
              );
            },
          },
        },
      );
      const exitCode = await runCli(
        [operation, "--workspace", workspace.slug],
        { login: { async run() {} }, setup: { async run() {} }, daemon },
        io,
      );
      expect(exitCode).toBe(1);
      const output = lines.join("\n");
      expect(output).toContain("CREDENTIAL_REVOKED");
      expect(output).toContain("original Computer owner");
      expect(output).toContain(recoveryCommand);
    }),
);
