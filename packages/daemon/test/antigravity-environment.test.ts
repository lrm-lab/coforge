import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { antigravityProvider } from "./fixtures/antigravity-host";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";

test("Antigravity usage reads the current host environment per call and strips inherited SSH markers", async () => {
  const provider = antigravityProvider({
    command: [process.execPath, anvilRuntimeFixtures.antigravityModels],
  });
  const keys = [
    "COFORGE_ANTIGRAVITY_USAGE_OUTPUT",
    "SSH_CLIENT",
    "SSH_CONNECTION",
    "SSH_TTY",
  ] as const;
  const before = Object.fromEntries(keys.map((key) => [key, Bun.env[key]]));
  try {
    for (const marker of ["late-one", "late-two"]) {
      Bun.env.SSH_CLIENT = "fixture-client";
      Bun.env.SSH_CONNECTION = "fixture-connection";
      Bun.env.SSH_TTY = "fixture-tty";
      Bun.env.COFORGE_ANTIGRAVITY_USAGE_OUTPUT = JSON.stringify({
        status: "SUCCESS",
        command: {
          data: {
            description: marker,
            groups: [
              { name: "fixture", buckets: [{ id: "five", window: "5h", remaining_fraction: 0.5 }] },
            ],
          },
        },
      });
      const usage = await provider.readUsage({ workingDirectory: tmpdir() });
      expect(usage.officialDescription).toBe(marker);
      expect(usage.primary?.usedPercent).toBe(50);
    }
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete Bun.env[key];
      else Bun.env[key] = before[key];
    }
  }
});
