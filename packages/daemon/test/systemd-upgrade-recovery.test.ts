import { afterEach, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DaemonConfigStore } from "#src/persistence/daemon-config";
import {
  readUpgradeProgressFile,
  snapshotUpgradeBindings,
  writeUpgradeProgressFile,
} from "#src/platform/computer-upgrade-progress";
import { SystemdWorkspaceInstance } from "#src/supervisor/systemd-workspace-instance";
import { workspaceUpgradeRecovery } from "#src/supervisor/workspace-upgrade-recovery";
import type { WorkspaceInstance } from "#src/supervisor/workspace-instance";
import {
  cleanupFixtures,
  fixture,
  spawnWorkspaceActivation,
  workspaceActivationResult,
  workspaceIdentity,
} from "./computer-upgrade-progress-fixture";

afterEach(cleanupFixtures);

const recoveryCases = [
  "none",
  "same-name refusal",
  "unknown result",
  "replacement",
  "no persisted grant",
] as const;

test.each(recoveryCases)(
  "systemd recovery after Installer settlement with a native race: %s",
  async (race) => {
    const { installRoot, stateDirectory, directory, requestId, context, version } = await fixture();
    const bindings = ["alpha", "beta"].map((workspaceId) => ({
      workspaceId,
      computerId: "computer",
      workspaceRoot: stateDirectory,
      enabled: true,
      serverHttpUrl: "https://fixture.example",
    }));
    const activation = {
      observedUpgradeRequestId: requestId,
      upgradeActivationGeneration: context.generation,
    };
    await mkdir(stateDirectory);
    const activatedAt = Date.now() - 10_000;
    const evidence = { generation: context.generation, version, at: activatedAt };
    await writeUpgradeProgressFile(installRoot, "installer-transaction.json", {
      request_id: requestId,
      to: version,
    });
    await writeUpgradeProgressFile(directory, "activated.json", { ...evidence, kind: "activated" });
    await snapshotUpgradeBindings(installRoot, requestId, async () =>
      bindings.map((binding) => ({ ...binding, processId: 1, instanceId: "previous", version })),
    );
    const recovery = await workspaceUpgradeRecovery(installRoot, version, activatedAt + 1000);
    const settled = { ...evidence, at: Date.now() };
    await writeUpgradeProgressFile(directory, "healthy.json", { ...settled, kind: "healthy" });
    await writeUpgradeProgressFile(directory, "receipt.json", {
      ...settled,
      kind: "receipt",
      outcome: "promoted",
    });
    await rm(join(installRoot, "installer-transaction.json"));

    for (const binding of bindings) {
      const state = join(stateDirectory, binding.workspaceId);
      await new DaemonConfigStore(state).save(binding);
      const record = join(
        directory,
        `workspace-recovery-${Buffer.from(binding.workspaceId).toString("base64url")}.json`,
      );
      const invocationId = crypto.randomUUID().replaceAll("-", "");
      let child: ReturnType<typeof spawnWorkspaceActivation> | undefined;
      let hasUnitFile = false;
      const raced = race !== "none" && binding.workspaceId === "beta";
      const grantWriteFails = raced && race === "no persisted grant";
      if (grantWriteFails) await mkdir(record);
      let transientStarts = 0;
      let ordinaryStarts = 0;
      let description = "";
      const instance: WorkspaceInstance = new SystemdWorkspaceInstance(
        {
          stateRoot: stateDirectory,
          workspaceId: binding.workspaceId,
          executablePath: process.execPath,
          socketPath: join(state, "daemon.sock"),
          stateDirectory: state,
          unitDirectory: stateDirectory,
        },
        async ([command]) => {
          if (command === "start" && !child) {
            ordinaryStarts += 1;
            child = spawnWorkspaceActivation(installRoot, version, state);
          }
          return 0;
        },
        async () => {
          hasUnitFile = true;
        },
        async () =>
          child || hasUnitFile
            ? {
                code: 0,
                stdout: `LoadState=loaded\nActiveState=${child ? "active" : "inactive"}\nMainPID=${child?.pid ?? 0}\nInvocationID=${invocationId}\nDescription=${description}\nTransient=${description ? "yes" : "no"}\n`,
              }
            : { code: 4, stdout: "LoadState=not-found\n" },
        async ([, descriptionArg]) => {
          transientStarts += 1;
          if (grantWriteFails) return 1;
          expect(hasUnitFile).toBe(false);
          expect(await readUpgradeProgressFile(record)).toMatchObject({ state: "armed" });
          child = spawnWorkspaceActivation(installRoot, version, state);
          if (!raced) description = descriptionArg!.slice("--description=".length);
          if (raced && race === "replacement") description = "another transient service";
          if (raced && race === "unknown result") throw new Error("systemd result unavailable");
          return raced && race === "same-name refusal" ? 1 : 0;
        },
      );
      try {
        await recovery.start(binding, true, state, async (grant) => {
          const processId = await instance.ensureStarted(grant?.beforeLaunch, grant);
          const observed = await instance.identity();
          expect(observed).toEqual({ mainPid: processId, invocationId, active: true });
          await grant?.observeLaunch(observed!);
          const handshake = await workspaceIdentity(state, processId);
          return { processId, invocationId, daemonId: handshake.daemonId };
        });
        expect(await workspaceActivationResult(child!)).toEqual(raced ? null : activation);
        expect(transientStarts).toBe(grantWriteFails ? 0 : 1);
        expect(ordinaryStarts).toBe(grantWriteFails ? 1 : 0);
        if (grantWriteFails) continue;
        expect(await readUpgradeProgressFile(record)).toMatchObject({
          state: raced ? "failed" : "confirmed",
          binding: { workspaceId: binding.workspaceId, computerId: binding.computerId },
          activation,
        });
      } finally {
        if (child?.exitCode === null) child.kill();
        await child?.exited;
      }
    }
  },
);
