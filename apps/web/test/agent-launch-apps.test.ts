import { expect, spyOn, test } from "bun:test";
import { BUILT_IN_APPS } from "@lrm/coforge-sdk/internal";
import {
  AGENT_LAUNCH_APP_DESCRIPTION_MAX_LENGTH,
  AGENT_LAUNCH_APPS_MAX_COUNT,
} from "@lrm/coforge-sdk/internal/agent-launch-apps";
import { listAgentLaunchApps } from "#src/server/app-agent-access/agent-launch-apps.server";

type InstalledApp = {
  id: string;
  key: string;
  name: string;
  description: string;
  whenToUse: string;
  homepageUrl: string | null;
  agentManifestUrl: string | null;
  logoUrl: string | null;
  allowedScopes: string[];
  agentAccess: "all" | "selected";
  selectedAgentIds: string[];
};

const app = (key: string, patch: Partial<InstalledApp> = {}): InstalledApp => ({
  id: `id-${key}`,
  key,
  name: `App ${key}`,
  description: `What ${key} is.`,
  whenToUse: `When ${key} helps.`,
  homepageUrl: "https://app.example/",
  agentManifestUrl: "https://app.example/agents.json",
  logoUrl: null,
  allowedScopes: ["openid"],
  agentAccess: "all",
  selectedAgentIds: [],
  ...patch,
});

const storeOf = (apps: InstalledApp[], seen: string[] = []) => ({
  listGrantStates: async () => [],
  listInstalledApps: async (workspaceId: string) => {
    seen.push(workspaceId);
    return apps;
  },
});

test("the launch directory is the Agent's Workspace's apps in the store's order, with only key, name, description and when to use", async () => {
  const seen: string[] = [];
  const directory = await listAgentLaunchApps(
    storeOf([app("acme-notes", { name: "Acme Notes" }), app("zeta-board", { name: "Zeta" })], seen),
    "workspace-1",
    "agent-1",
  );
  expect(seen).toEqual(["workspace-1"]);
  expect(directory).toEqual([
    {
      key: "acme-notes",
      name: "Acme Notes",
      description: "What acme-notes is.",
      whenToUse: "When acme-notes helps.",
    },
    {
      key: "zeta-board",
      name: "Zeta",
      description: "What zeta-board is.",
      whenToUse: "When zeta-board helps.",
    },
  ]);
});

test("the launch directory never carries a URL, an app's Agent manifest included", async () => {
  const directory = await listAgentLaunchApps(
    storeOf([app("acme-notes")]),
    "workspace-1",
    "agent-1",
  );
  expect(JSON.stringify(directory)).not.toContain("https://");
});

test("a built-in Agent App never appears, even if a store returned one", async () => {
  const builtIn = BUILT_IN_APPS[0];
  const directory = await listAgentLaunchApps(
    storeOf([app(builtIn.key, { name: builtIn.name }), app("acme-notes")]),
    "workspace-1",
    "agent-1",
  );
  expect(directory.map((entry) => entry.key)).toEqual(["acme-notes"]);
});

test("the directory is bounded and normalised by the SDK's rule: at most the cap of apps, each text one line within its length", async () => {
  const many = Array.from({ length: AGENT_LAUNCH_APPS_MAX_COUNT + 5 }, (_, index) =>
    app(`app-${String(index).padStart(2, "0")}`),
  );
  expect(await listAgentLaunchApps(storeOf(many), "workspace-1", "agent-1")).toHaveLength(
    AGENT_LAUNCH_APPS_MAX_COUNT,
  );

  const [entry] = await listAgentLaunchApps(
    storeOf([
      app("acme-notes", {
        name: "  Acme\tNotes `v2`\u202e ",
        description: `First line.\n\nSecond line. ${"x".repeat(600)}`,
        whenToUse: "  Read the notes.  ",
      }),
    ]),
    "workspace-1",
    "agent-1",
  );
  expect(entry!.name).toBe("Acme Notes 'v2'");
  expect(entry!.whenToUse).toBe("Read the notes.");
  expect(entry!.description).toStartWith("First line. Second line. xxx");
  expect(entry!.description).not.toContain("\n");
  expect([...entry!.description!]).toHaveLength(AGENT_LAUNCH_APP_DESCRIPTION_MAX_LENGTH);
  expect(entry!.description).toEndWith("…");
});

test("an empty description or when-to-use is omitted, not sent empty", async () => {
  const [entry] = await listAgentLaunchApps(
    storeOf([app("acme-notes", { description: "", whenToUse: "   " })]),
    "workspace-1",
    "agent-1",
  );
  expect(entry).toEqual({ key: "acme-notes", name: "App acme-notes" });
});

test("a failure listing the apps leaves the directory empty instead of failing the launch", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const directory = await listAgentLaunchApps(
      {
        listGrantStates: async () => [],
        listInstalledApps: async () => {
          throw new Error("database unavailable");
        },
      },
      "workspace-1",
      "agent-1",
    );
    expect(directory).toEqual([]);
    expect(String(warn.mock.calls[0]?.[0])).toContain("agent_launch:apps_unavailable");
  } finally {
    warn.mockRestore();
  }
});
