import { expect, test } from "bun:test";
import type { ComputerRegisterRequest } from "@lrm/coforge-sdk/internal";
import { createSetup } from "./setup-fixture";

test("setup adopts a matching server candidate when local registration evidence is missing", async () => {
  let registration: ComputerRegisterRequest | undefined;
  const setup = createSetup({
    config: {
      async loadCurrentProfile() {
        return { serverUrl: "https://coforge.example" };
      },
      async loadRegistration() {
        return null;
      },
      async saveRegistration() {
        return "/saved";
      },
      async discardRegistration() {},
    },
    roster: {
      async list() {
        return [
          {
            computerId: "server-computer",
            machineId: "linux:test-machine-id",
            name: "old-host",
            displayName: "Old Host",
            platform: "linux",
            osVersion: "1",
            computerVersion: "1",
            workspaceSlugs: ["workspace-a"],
          },
        ];
      },
    },
    registrationFactory: () => ({
      async register(request) {
        registration = request;
        return {
          protocolMajor: request.protocolMajor,
          requestId: request.requestId,
          computerId: "server-computer",
          workspaceId: "workspace-id-a",
          daemonApiKey: "daemon-secret",
        };
      },
    }),
  });

  const result = await setup.run({ workspaceSlug: "workspace-a" });

  expect(result.mode).toBe("adopted");
  expect(registration).toMatchObject({
    machineId: "linux:test-machine-id",
    adoptComputerId: "server-computer",
  });
});

test("setup refuses to create a duplicate when server evidence does not match", async () => {
  let registered = false;
  const setup = createSetup({
    config: {
      async loadCurrentProfile() {
        return { serverUrl: "https://coforge.example" };
      },
      async loadRegistration() {
        return null;
      },
      async saveRegistration() {
        return "/saved";
      },
      async discardRegistration() {},
    },
    roster: {
      async list() {
        return [
          {
            computerId: "other-computer",
            machineId: "another-machine",
            name: "other",
            displayName: "Other",
            platform: "linux",
            osVersion: "1",
            computerVersion: "1",
            workspaceSlugs: [],
          },
        ];
      },
    },
    registrationFactory: () => ({
      async register() {
        registered = true;
        throw new Error("must not register");
      },
    }),
  });

  await expect(setup.run({ workspaceSlug: "workspace-a" })).rejects.toMatchObject({
    code: "SETUP_MACHINE_NOT_FOUND",
  });
  expect(registered).toBe(false);
});

test("fresh setup requires explicit confirmation when replacing a local binding", async () => {
  const setup = createSetup({
    config: {
      async loadCurrentProfile() {
        return { serverUrl: "https://coforge.example" };
      },
      async loadRegistration() {
        return { id: "workspace-id-a", slug: "workspace-a", computerId: "old-computer" };
      },
      async saveRegistration() {
        return "/saved";
      },
      async discardRegistration() {},
    },
  });

  await expect(setup.run({ workspaceSlug: "workspace-a", fresh: true })).rejects.toMatchObject({
    code: "SETUP_CONFIRMATION_REQUIRED",
  });
  await expect(
    setup.run({ workspaceSlug: "workspace-a", fresh: true, yes: true }),
  ).resolves.toMatchObject({
    mode: "fresh",
  });
});
