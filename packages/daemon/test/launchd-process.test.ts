import { expect, test } from "bun:test";
import {
  chmod,
  lutimes,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobPlist } from "#src/platform/launchd-job";
import {
  AGENT_STARTUP_TIMEOUT_MS,
  isAgentRelaySocket,
  LaunchdProcessOwner,
  sweepAgentRelayDirectories,
} from "#src/platform/launchd-process";
import { RuntimeExecutableNotFoundError } from "#src/platform/runtime-executable-not-found";
import { captureDaemonLogs } from "./log-capture";

// The real-launchd cases live in launchd-process.integration.ts.

const identity = "1".repeat(24);
const prefix = `cn.coforge.agent.${identity}.`;
/** Older than the owner's startup timeout, so no Agent can still be about to load its job. */
const settled = new Date(Date.now() - AGENT_STARTUP_TIMEOUT_MS - 60_000);

/** A relay root and job directory of the test's own, removed by `finally` whatever happens. */
async function withRelayRoot(
  run: (paths: { relayRoot: string; directory: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "coforge-relay-sweep-"));
  try {
    const paths = { relayRoot: join(root, "tmp"), directory: join(root, "launchd-agents") };
    await mkdir(paths.relayRoot);
    await mkdir(paths.directory);
    await run(paths);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function relayDirectory(relayRoot: string, name: string, time = settled): Promise<string> {
  const path = join(relayRoot, name);
  await mkdir(path);
  await writeFile(join(path, "stdio.sock"), "");
  await utimes(path, time, time);
  return path;
}

test("an executable missing from the Agent's PATH fails as RuntimeExecutableNotFoundError before any job is created", () => {
  const owner = new LaunchdProcessOwner({
    directory: "/nonexistent-coforge-job-directory",
    prefix: "cn.coforge.agent.test.",
    runner: [process.execPath, "__managed-agent"],
  });
  let thrown: unknown;
  try {
    owner.spawn(["coforge-missing-runtime-cli"], "/", { PATH: "/usr/bin:/bin" });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RuntimeExecutableNotFoundError);
  expect(thrown).toMatchObject({
    code: "runtime_not_found",
    executable: "coforge-missing-runtime-cli",
  });
});

test("the Agent runner accepts only a relay socket named for one Workspace", () => {
  const identity = "0123456789abcdef01234567";
  expect(isAgentRelaySocket(`/private/tmp/cf-agent-${identity}-aB3dE9/stdio.sock`)).toBe(true);
  for (const path of [
    // The random-name format of earlier releases: their own binary runs their own plists.
    "/private/tmp/cf-agent-y0MFxU/stdio.sock",
    `/private/tmp/cf-agent-${identity}-../stdio.sock`,
    `/private/tmp/cf-agent-${identity}-aB3dE9/../stdio.sock`,
    `/private/tmp/cf-agent-${identity}-aB3dE9//stdio.sock`,
    `/private/tmp/cf-agent-${identity}-aB3/dE9/stdio.sock`,
    `/private/tmp/cf-agent-${identity}/stdio.sock`,
    `/private/tmp/cf-agent-${identity.toUpperCase()}-aB3dE9/stdio.sock`,
    `/private/tmp/cf-agent-${identity}0-aB3dE9/stdio.sock`,
    `/tmp/cf-agent-${identity}-aB3dE9/stdio.sock`,
    `/private/var/cf-agent-${identity}-aB3dE9/stdio.sock`,
    `/private/tmp/cf-agent-${identity}-aB3dE9/other.sock`,
    `/private/tmp/cf-agent-${identity}-aB3dE9/stdio.sock\n`,
    "",
  ])
    expect(isAgentRelaySocket(path)).toBe(false);
});

test("the relay sweep removes only this Workspace's relay directories that no loaded job references", async () => {
  await withRelayRoot(async ({ relayRoot, directory }) => {
    const stale = [`cf-agent-${identity}-aB3dE9`, `cf-agent-${identity}-Zz0000`];
    const referenced = `cf-agent-${identity}-Live01`;
    const kept = [referenced, `cf-agent-${"2".repeat(24)}-aB3dE9`, "cf-agent-y0MFxU", "unrelated"];
    for (const name of [...stale, ...kept]) await relayDirectory(relayRoot, name);
    const loaded = `${prefix}${crypto.randomUUID()}`;
    await writeFile(
      join(directory, `${loaded}.plist`),
      jobPlist({
        label: loaded,
        directory,
        command: ["/computer", "__managed-agent", `/private/tmp/${referenced}/stdio.sock`],
      }),
    );
    // A loaded Agent job whose plist names no relay (a residual root) protects nothing.
    const residual = `${prefix}${crypto.randomUUID()}`;
    await writeFile(
      join(directory, `${residual}.plist`),
      jobPlist({ label: residual, directory, command: ["/bin/sleep", "300"] }),
    );
    await sweepAgentRelayDirectories(prefix, directory, {
      jobs: new Map([
        [loaded, 0],
        [residual, 0],
      ]),
      root: relayRoot,
    });
    expect((await readdir(relayRoot)).sort()).toEqual([...kept].sort());
  });
});

// An owner creates its relay directory before its job is loaded; until the owner's startup
// timeout has passed, no loaded job can be expected to name it.
test("the relay sweep keeps a relay directory younger than the Agent startup timeout", async () => {
  await withRelayRoot(async ({ relayRoot, directory }) => {
    const fresh = `cf-agent-${identity}-Fresh1`;
    await relayDirectory(relayRoot, fresh, new Date());
    await relayDirectory(relayRoot, `cf-agent-${identity}-Old001`);
    await sweepAgentRelayDirectories(prefix, directory, { jobs: new Map(), root: relayRoot });
    expect(await readdir(relayRoot)).toEqual([fresh]);
  });
});

test("the relay sweep skips what is not its own directory and survives an entry it cannot remove", async () => {
  await withRelayRoot(async ({ relayRoot, directory }) => {
    const target = await relayDirectory(relayRoot, "link-target");
    const link = `cf-agent-${identity}-Link01`;
    await symlink(target, join(relayRoot, link));
    await lutimes(join(relayRoot, link), settled, settled);
    const file = `cf-agent-${identity}-File01`;
    await writeFile(join(relayRoot, file), "");
    await utimes(join(relayRoot, file), settled, settled);
    const lockedNames = [`cf-agent-${identity}-Lock01`, `cf-agent-${identity}-Lock02`];
    const locked: string[] = [];
    for (const name of lockedNames) {
      const path = await relayDirectory(relayRoot, name);
      await mkdir(join(path, "held"));
      await writeFile(join(path, "held", "file"), "");
      locked.push(join(path, "held"));
      await chmod(join(path, "held"), 0o500);
      await utimes(path, settled, settled);
    }
    await relayDirectory(relayRoot, `cf-agent-${identity}-Gone01`);
    try {
      const { records } = await captureDaemonLogs(() =>
        sweepAgentRelayDirectories(prefix, directory, { jobs: new Map(), root: relayRoot }),
      );
      expect((await readdir(relayRoot)).sort()).toEqual(
        [file, link, "link-target", ...lockedNames].sort(),
      );
      expect(await readdir(target)).toEqual(["stdio.sock"]);
      expect(
        records.filter((record) => record.properties.event === "launchd:relay_sweep_failed"),
      ).toHaveLength(1);
    } finally {
      for (const path of locked) await chmod(path, 0o700);
    }
  });
});

test("the relay sweep removes nothing when a loaded job's plist cannot be read", async () => {
  await withRelayRoot(async ({ relayRoot, directory }) => {
    const stale = `cf-agent-${identity}-aB3dE9`;
    await relayDirectory(relayRoot, stale);
    const { records } = await captureDaemonLogs(() =>
      sweepAgentRelayDirectories(prefix, directory, {
        jobs: new Map([[`${prefix}${crypto.randomUUID()}`, 0]]),
        root: relayRoot,
      }),
    );
    expect(await readdir(relayRoot)).toEqual([stale]);
    expect(records.map((record) => record.properties.event)).toContain(
      "launchd:relay_sweep_skipped",
    );
  });
});

test("the relay sweep refuses a prefix that is not one Workspace's Agent scope", async () => {
  for (const scope of ["cn.coforge.agent.", "cn.coforge.agent.test.", "cn.coforge.agent.../"])
    await expect(
      sweepAgentRelayDirectories(scope, "/nonexistent", { jobs: new Map(), root: "/nonexistent" }),
    ).rejects.toThrow("invalid Agent job scope");
});
