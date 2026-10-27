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
  const absent = (await ports.readServiceDefinition())!;

  expect(absent.path).toBe(
    join(home, "Library", "LaunchAgents", "cn.coforge.computer.daemon.plist"),
  );
  expect(absent.expected).toContain("cn.coforge.computer.daemon");
  expect(absent.onDisk).toBeNull();

  await mkdir(dirname(absent.path), { recursive: true });
  await writeFile(absent.path, absent.expected);
  expect((await ports.readServiceDefinition())!.onDisk).toBe(absent.expected);
});

test("the systemd user unit is expected under the home's config directory", async () => {
  const { home, ports } = await portsFor("linux");
  const definition = (await ports.readServiceDefinition())!;

  expect(definition.path).toBe(join(home, ".config", "systemd", "user", "coforge-daemon.service"));
  expect(definition.expected).toContain("ExecStart=");
});

test("the Windows Scheduled Task keeps no service file to compare", async () => {
  const { ports } = await portsFor("win32");

  expect(await ports.readServiceDefinition()).toBeNull();
});
