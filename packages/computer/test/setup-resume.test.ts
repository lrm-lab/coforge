import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileDaemonCredentialStore, workspaceStateDirectory } from "@lrm/coforge-daemon";
import { createResumePort } from "#src/cli/login-setup-commands";
import { createSetup } from "./setup-fixture";
import type { SetupResumePort } from "#src/setup/computer-setup";

/** Re-running setup on an attached Workspace resumes it (task #417, Raft's resume). */
const registration = {
  id: "workspace-id-a",
  slug: "workspace-a",
  computerId: "computer-id",
};

function attached(
  state: "live" | "revoked" | "forbidden" | "unsupported" | "unreachable",
  key: string | null = "sk_computer_x",
) {
  const calls = { register: 0, saved: 0, started: [] as string[], oneShot: 0 };
  const resume: SetupResumePort = {
    storedKey: async () => key,
    self: async () => ({ state }),
  };
  const setup = createSetup({
    resume,
    config: {
      async loadCurrentProfile() {
        return { serverUrl: "https://coforge.example" };
      },
      async loadRegistration(selector) {
        return !selector || selector === registration.slug || selector === registration.id
          ? registration
          : null;
      },
      async saveRegistration() {
        calls.saved++;
        return "/config/registration.json";
      },
      async discardRegistration() {},
    },
    registrationFactory: () => ({
      async register() {
        calls.register++;
        throw new Error("must not register");
      },
    }),
    launcher: {
      ensureStarted: async (config) => {
        calls.started.push(config.daemonApiKey);
        return {};
      },
    },
    oneShotAttach: async () => {
      calls.oneShot++;
      return {
        accessToken: "attach-token",
        tokenType: "Bearer",
        workspaceId: registration.id,
        workspaceSlug: registration.slug,
      };
    },
  });
  return { setup, calls };
}

test("an attached workspace with a live key resumes without registering", async () => {
  const { setup, calls } = attached("live");
  const result = await setup.run({ workspaceSlug: "workspace-a" });
  expect(result.resumed).toBe(true);
  expect(calls.register).toBe(0);
  expect(calls.started).toEqual(["sk_computer_x"]);
});

test("a revoked key errors and writes nothing", async () => {
  const { setup, calls } = attached("revoked");
  await expect(setup.run({ workspaceSlug: "workspace-a" })).rejects.toMatchObject({
    code: "SETUP_ALREADY_ATTACHED_INVALID",
  });
  expect(calls).toMatchObject({ register: 0, saved: 0, started: [] });
});

test("a missing stored key errors the same way", async () => {
  const { setup, calls } = attached("live", null);
  await expect(setup.run({ workspaceSlug: "workspace-a" })).rejects.toMatchObject({
    code: "SETUP_ALREADY_ATTACHED_INVALID",
  });
  expect(calls.register).toBe(0);
});

test("a network error errors and writes nothing", async () => {
  const { setup, calls } = attached("unreachable");
  await expect(setup.run({ workspaceSlug: "workspace-a" })).rejects.toMatchObject({
    code: "SETUP_ALREADY_ATTACHED_UNREACHABLE",
  });
  expect(calls).toMatchObject({ register: 0, saved: 0, started: [] });
});

test("one-shot without a slug resumes the bound workspace and does not register", async () => {
  const { setup, calls } = attached("live");
  const result = await setup.run({ oneShot: true });
  expect(calls.oneShot).toBe(1);
  expect(result.resumed).toBe(true);
  expect(calls.register).toBe(0);
});

test("a workspace with no local attachment goes on to register", async () => {
  const { setup, calls } = attached("live");
  await expect(setup.run({ workspaceSlug: "workspace-b" })).rejects.toMatchObject({
    code: "SETUP_COMPUTER_REGISTER_FAILED",
  });
  expect(calls.register).toBe(1);
});

test("a valid dk_ (/self 403) resumes and leaves the key swap to the Daemon", async () => {
  const { setup, calls } = attached("forbidden", "dk_attach");
  const result = await setup.run({ workspaceSlug: "workspace-a" });
  expect(result.resumed).toBe(true);
  expect(calls.started).toEqual(["dk_attach"]);
  expect(calls.register).toBe(0);
});

test("a revoked dk_ (/self 401) errors and writes nothing", async () => {
  const { setup, calls } = attached("revoked", "dk_attach");
  await expect(setup.run({ workspaceSlug: "workspace-a" })).rejects.toMatchObject({
    code: "SETUP_ALREADY_ATTACHED_INVALID",
  });
  expect(calls).toMatchObject({ register: 0, saved: 0, started: [] });
});

test("an sk_computer answered 403 counts as revoked", async () => {
  const { setup } = attached("forbidden");
  await expect(setup.run({ workspaceSlug: "workspace-a" })).rejects.toMatchObject({
    code: "SETUP_ALREADY_ATTACHED_INVALID",
  });
});

test("a server without /self says so instead of 'try later'", async () => {
  const { setup, calls } = attached("unsupported");
  await expect(setup.run({ workspaceSlug: "workspace-a" })).rejects.toMatchObject({
    code: "SETUP_ALREADY_ATTACHED_UNSUPPORTED",
  });
  expect(calls.register).toBe(0);
});

test("an unreadable stored key is a setup error with its own code", async () => {
  const broken = createSetup({
    resume: {
      storedKey: async () => {
        throw new Error("EACCES");
      },
      self: async () => ({ state: "live" }),
    },
    config: {
      async loadCurrentProfile() {
        return { serverUrl: "https://coforge.example" };
      },
      async loadRegistration() {
        return registration;
      },
      async saveRegistration() {
        return "/x";
      },
      async discardRegistration() {},
    },
  });
  await expect(broken.run({ workspaceSlug: "workspace-a" })).rejects.toMatchObject({
    code: "SETUP_ALREADY_ATTACHED_READ_FAILED",
  });
});

test("the resume port reads the key from the Workspace's own state directory", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "resume-port-"));
  await new FileDaemonCredentialStore(
    workspaceStateDirectory(stateDirectory, "workspace-id-a"),
  ).save("workspace-id-a", "computer-id", "sk_computer_real");
  const port = createResumePort(stateDirectory, "https://coforge.example");
  expect(await port.storedKey("workspace-id-a", "computer-id")).toBe("sk_computer_real");
  expect(await port.storedKey("workspace-id-b", "computer-id")).toBeNull();
});
