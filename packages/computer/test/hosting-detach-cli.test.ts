import { expect } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryDaemonCredentialStore, startDaemonLocalRpcServer } from "@lrm/coforge-daemon";
import { detachManagedBinding } from "@lrm/coforge-daemon/src/supervisor/machine-supervisor-detach";
import type { ManagedBinding } from "@lrm/coforge-daemon/src/supervisor/machine-supervisor";
import { FileComputerConfig } from "#src/local-config";
import {
  resolveComputerConfigDirectory,
  resolveComputerStateDirectory,
  resolveDaemonSocketPath,
} from "#src/paths";
import { subprocessTest } from "./subprocess-test";

const registration = { id: "workspace-one", slug: "alpha", computerId: "computer-one" };
const agentEnvironment = {
  COFORGE_AGENT_LAUNCH_TAG: "fixture-agent-launch",
  COFORGE_CURRENT_WORKSPACE_ID: registration.id,
  COFORGE_CURRENT_COMPUTER_ID: registration.computerId,
};

const cases = [
  { name: "the implicit hosting binding", args: ["--json"], environment: agentEnvironment },
  {
    name: "the hosting binding by slug",
    args: ["--workspace", registration.slug],
    environment: agentEnvironment,
  },
  {
    name: "the hosting binding by ID",
    args: ["--workspace", registration.id, "--json"],
    environment: agentEnvironment,
  },
  {
    name: "the operator terminal",
    args: ["--json"],
    environment: { ...agentEnvironment, COFORGE_AGENT_LAUNCH_TAG: undefined },
    allowed: true,
  },
  {
    name: "the hosting binding with a stale Computer registration",
    args: ["--workspace", registration.slug, "--json"],
    environment: { ...agentEnvironment, COFORGE_CURRENT_COMPUTER_ID: "computer-two" },
    activeComputerId: "computer-two",
  },
  {
    name: "a different Workspace binding",
    args: ["--workspace", registration.slug, "--json"],
    environment: { ...agentEnvironment, COFORGE_CURRENT_WORKSPACE_ID: "workspace-two" },
    allowed: true,
  },
];

for (const { name, args, environment, allowed, activeComputerId } of cases) {
  subprocessTest(`detach handles ${name}`, async () => {
    const fixtureRoot = process.platform === "darwin" ? "/tmp" : tmpdir();
    const home = await mkdtemp(join(await realpath(fixtureRoot), "cf-detach-"));
    const paths = { platform: process.platform, homeDirectory: home, environment: {} };
    const config = new FileComputerConfig(resolveComputerConfigDirectory(paths));
    const commands: Array<{ method: string; workspaceId?: string }> = [];
    const stoppedComputers: string[] = [];
    const runningComputerId = activeComputerId ?? registration.computerId;
    let bindings: ManagedBinding[] = [
      {
        workspaceId: registration.id,
        computerId: runningComputerId,
        workspaceRoot: home,
        enabled: true,
        serverHttpUrl: "https://coforge.cn",
      },
    ];
    try {
      const savedRegistration = await config.saveRegistration(registration);
      const server = await startDaemonLocalRpcServer({
        socketPath: resolveDaemonSocketPath({
          platform: process.platform,
          stateDirectory: resolveComputerStateDirectory(paths),
        }),
        validateCredential: () => true,
        credentials: new InMemoryDaemonCredentialStore(),
        runtime: {
          command: async (method, request) => {
            commands.push({ method, workspaceId: request.workspaceId });
            if (!request.workspaceId) throw new Error("Expected an explicit Workspace ID");
            const result = await detachManagedBinding({
              workspaceId: request.workspaceId,
              bindings,
              stop: async (binding) => void stoppedComputers.push(binding.computerId),
              store: async (next) => {
                bindings = next;
              },
              credentials: { load: async () => "fixture-key", delete: async () => {} },
              makeSelfClient: () => ({
                detach: async () => ({ ok: true, value: "detached" }),
              }),
            });
            if (!result.detached) throw new Error(`Fixture detach failed: ${result.reason}`);
            return [];
          },
        },
      });
      try {
        const child = Bun.spawn(
          [
            process.execPath,
            new URL("../src/main.ts", import.meta.url).pathname,
            "detach",
            ...args,
          ],
          {
            env: { PATH: Bun.env.PATH, HOME: home, USERPROFILE: home, ...environment },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            timeout: 10_000,
          },
        );
        const [out, err, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);

        if (allowed) {
          expect(exitCode).toBe(0);
          expect(JSON.parse(out)).toEqual({
            ok: true,
            detached: true,
            kind: "detached",
            workspaceSlug: registration.slug,
          });
          expect(commands).toEqual([{ method: "daemon:detach", workspaceId: registration.id }]);
          expect(stoppedComputers).toEqual([runningComputerId]);
          expect(bindings).toEqual([]);
          expect(await Bun.file(savedRegistration).exists()).toBe(false);
        } else {
          expect(stoppedComputers).toEqual([]);
          expect(exitCode).toBe(1);
          if (args.includes("--json")) {
            expect(JSON.parse(out)).toMatchObject({
              ok: false,
              error: {
                code: "DETACH_HOSTING_AGENT_SESSION",
                hint: expect.stringContaining("terminal"),
              },
            });
          } else {
            expect(err).toContain("DETACH_HOSTING_AGENT_SESSION");
            expect(err).toContain("terminal");
          }
          expect(commands).toEqual([]);
          expect(bindings.map((binding) => binding.computerId)).toEqual([runningComputerId]);
          expect(await config.loadRegistration(registration.id)).toEqual(registration);
        }
      } finally {
        await server.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}
