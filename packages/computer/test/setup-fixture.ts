import { ComputerSetup, type ComputerSetupOptions } from "#src/setup/computer-setup";
import type { AccessibleWorkspace, Credential } from "#src/login";
import { createWorkspaceLookup } from "#src/workspace/lookup";

/** `setup.test.ts`/`setup-one-shot.test.ts`'s shared `ComputerSetup` seam (task #417). */
const credential: Credential = { accessToken: "access-secret", tokenType: "Bearer" };
const workspaces: AccessibleWorkspace[] = [
  { id: "workspace-id-a", slug: "workspace-a", name: "A" },
  { id: "workspace-id-b", slug: "workspace-b", name: "B" },
];
export { credential, workspaces };
export function createSetup(overrides: Partial<ComputerSetupOptions> = {}): ComputerSetup {
  return new ComputerSetup({
    config: {
      async loadCurrentProfile() {
        return { serverUrl: "https://coforge.example" };
      },
      async saveRegistration() {
        return "/config/workspaces/id/config.json";
      },
      async discardRegistration() {},
    },
    credentials: {
      async load() {
        return credential;
      },
    },
    workspaceLookup: createWorkspaceLookup(
      async () => workspaces,
      async (_serverUrl, _credential, slug) => ({ id: "", slug, name: slug }),
    ),
    registrationFactory: (_serverUrl, _credential) => ({
      async register(request) {
        return {
          protocolMajor: request.protocolMajor,
          requestId: request.requestId,
          computerId: "computer-id",
          workspaceId:
            request.workspaceSlug === "workspace-b" ? "workspace-id-b" : "workspace-id-a",
          daemonApiKey: "daemon-secret",
        };
      },
    }),
    launcher: { ensureStarted: async () => ({}) },
    metadataProvider: {
      async get() {
        return {
          name: "test-computer",
          displayName: "Test Computer",
          platform: "linux",
          osVersion: "bun-test",
          computerVersion: "test",
          machineId: "linux:test-machine-id",
        };
      },
    },
    idempotencyKeyProvider: { create: (_serverUrl, value) => `key:${value}` },
    serverUrl: "https://coforge.example",
    ...overrides,
    workspaceRoot: overrides.workspaceRoot ?? "/home/test-user/coforge-workspaces",
  });
}
