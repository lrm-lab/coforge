import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createStatusPorts } from "#src/status/create-status-ports";
import type { SupportedStatusPlatform } from "#src/status/types";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function portsFor(platform: SupportedStatusPlatform) {
  const home = await mkdtemp(join(tmpdir(), "coforge-status-service-"));
  homes.push(home);
  return {
    home,
    ports: createStatusPorts({
      platform,
      installDirectory: join(home, ".coforge", "computer", "install"),
      stateDirectory: join(home, ".coforge", "computer", "state"),
      releaseFeedUrl: "https://releases.coforge.test/",
      serverUrl: "https://coforge.test",
      registrations: { listRegistrations: async () => [] },
      environment: {},
      machine: { homeDirectory: home, uid: 501, environment: {} },
    }),
  };
}

test("the launchd plist is expected under the home's LaunchAgents and read back as written", async () => {
  const { home, ports } = await portsFor("darwin");
  const expected = ports.expectedServiceDefinition()!;

  expect(expected.path).toBe(
    join(home, "Library", "LaunchAgents", "cn.coforge.computer.daemon.plist"),
  );
  expect(expected.contents).toContain("cn.coforge.computer.daemon");
  expect(await ports.readServiceDefinitionFile(expected.path)).toBeNull();

  await mkdir(dirname(expected.path), { recursive: true });
  await writeFile(expected.path, expected.contents);
  expect(await ports.readServiceDefinitionFile(expected.path)).toBe(expected.contents);
});

test("the systemd user unit is expected under the home's config directory", async () => {
  const { home, ports } = await portsFor("linux");
  const expected = ports.expectedServiceDefinition()!;

  expect(expected.path).toBe(join(home, ".config", "systemd", "user", "coforge-daemon.service"));
  expect(expected.contents).toContain("ExecStart=");
});

test("the Windows Scheduled Task keeps no service file to compare", async () => {
  const { ports } = await portsFor("win32");

  expect(ports.expectedServiceDefinition()).toBeNull();
});
