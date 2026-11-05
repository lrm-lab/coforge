import { expect, test } from "bun:test";

import { createSetup } from "./setup-fixture";

/** A registration whose Daemon never started leaves a server-side record; setup revokes it
 * with the `dk_` register just minted, best effort, and the hourly sweep is the fallback
 * (task #417). */

const failingLauncher = {
  async ensureStarted(): Promise<never> {
    throw new Error("spawn failed");
  },
};

test("a failed daemon start revokes the fresh registration with its dk_", async () => {
  const revoked: string[] = [];
  const setup = createSetup({
    launcher: failingLauncher,
    revokeRegistration: async (apiKey) => {
      revoked.push(apiKey);
      return true;
    },
  });

  await expect(setup.run({ workspaceSlug: "workspace-a" })).rejects.toMatchObject({
    code: "SETUP_DAEMON_START_FAILED",
  });
  expect(revoked).toEqual(["daemon-secret"]);
});

test("a failed revoke keeps the start error and says the record will be swept", async () => {
  const setup = createSetup({
    launcher: failingLauncher,
    revokeRegistration: async () => false,
  });

  await expect(setup.run({ workspaceSlug: "workspace-a" })).rejects.toMatchObject({
    code: "SETUP_DAEMON_START_FAILED",
    message: expect.stringContaining("removed automatically"),
  });
});

test("a throwing revoke is treated as a failed revoke, never masking the start error", async () => {
  const setup = createSetup({
    launcher: failingLauncher,
    revokeRegistration: async () => {
      throw new Error("network down");
    },
  });

  await expect(setup.run({ workspaceSlug: "workspace-a" })).rejects.toMatchObject({
    code: "SETUP_DAEMON_START_FAILED",
  });
});

test("a started daemon never triggers a revoke", async () => {
  let revoked = 0;
  const setup = createSetup({
    revokeRegistration: async () => {
      revoked++;
      return true;
    },
  });

  await setup.run({ workspaceSlug: "workspace-a" });
  expect(revoked).toBe(0);
});

test("a failed registration never triggers a revoke", async () => {
  let revoked = 0;
  const setup = createSetup({
    registrationFactory: () => ({
      async register() {
        throw new Error("rpc failed");
      },
    }),
    revokeRegistration: async () => {
      revoked++;
      return true;
    },
  });

  await expect(setup.run({ workspaceSlug: "workspace-a" })).rejects.toMatchObject({
    code: "SETUP_COMPUTER_REGISTER_FAILED",
  });
  expect(revoked).toBe(0);
});

test("a failed config write after a started daemon never triggers a revoke", async () => {
  let revoked = 0;
  const setup = createSetup({
    config: {
      async loadCurrentProfile() {
        return { serverUrl: "https://coforge.example" };
      },
      async saveRegistration() {
        throw new Error("disk full");
      },
      async discardRegistration() {},
    },
    revokeRegistration: async () => {
      revoked++;
      return true;
    },
  });

  await expect(setup.run({ workspaceSlug: "workspace-a" })).rejects.toMatchObject({
    code: "SETUP_CONFIG_WRITE_FAILED",
  });
  expect(revoked).toBe(0);
});
