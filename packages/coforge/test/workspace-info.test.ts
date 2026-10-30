import { expect, test } from "bun:test";
import { parseArgs, run } from "../index";
import { formatWorkspaceInfo } from "#src/workspace-info-format";
import type { WorkspaceInfoResponse } from "@lrm/coforge-sdk/internal";

// The Agent running this suite has this variable set; the runtime block must not depend on it.
delete Bun.env.COFORGE_CURRENT_AGENT_WORKSPACE_PATH;

const NOW = Date.parse("2026-09-07T12:00:00Z");

const BASE: WorkspaceInfoResponse = {
  idempotencyKey: "r",
  workspace: { id: "w", name: "Acme", slug: "acme" },
  humans: [],
  agents: [],
  projects: [],
};

const agent = (name: string, extra: Partial<WorkspaceInfoResponse["agents"][number]> = {}) =>
  ({
    id: name,
    name,
    displayName: name,
    role: "member",
    status: "online",
    activity: "",
    activityDetail: "",
    runtime: "",
    model: "",
    computerName: "",
    daemonVersion: "",
    ...extra,
  }) satisfies WorkspaceInfoResponse["agents"][number];

const human = (name: string, role = "member", description?: string) => ({
  id: name,
  name,
  displayName: name,
  role,
  ...(description ? { description } : {}),
});

const channel = (name: string, extra = {}) => ({
  name,
  description: "",
  joined: false,
  muted: false,
  archived: false,
  lastPostAt: null,
  ...extra,
});

const RICH: WorkspaceInfoResponse = {
  ...BASE,
  serverRole: "admin",
  channels: [
    channel("#general", {
      description: "Everyone.",
      joined: true,
      channelRole: "admin",
      channelAdminBasis: "channel_role",
      lastPostAt: "2026-09-07T11:30:00Z",
    }),
    channel("#old", { archived: true, muted: true }),
    channel("#ops"),
  ],
  agents: [
    agent("scout", { role: "admin", description: "Reviews pull requests." }),
    agent("helper", { status: "unknown" }),
  ],
  humans: [human("ada", "owner", "Founder"), human("bob")],
  projects: [
    { id: "p", name: "Core", slug: "core", githubFullName: "acme/core", githubHtmlUrl: "" },
  ],
  computers: [
    {
      name: "mac-1",
      displayName: "Mac 1",
      status: "online",
      platform: "darwin",
      osVersion: "15.6",
      computerVersion: "1.2.3",
    },
  ],
};

const info = (args: string[], result: WorkspaceInfoResponse = RICH) => {
  const invocation = parseArgs(["workspace", "info", ...args]);
  if (invocation.command !== "workspace.info") throw new Error("not workspace info");
  return formatWorkspaceInfo(result, invocation, NOW);
};

test("parses the sections, paging and filters of workspace info", () => {
  expect(
    parseArgs([
      "workspace",
      "info",
      "--channels",
      "--joined",
      "--query",
      "gen",
      "--limit",
      "5",
      "--offset",
      "10",
    ]),
  ).toEqual({
    command: "workspace.info",
    channels: true,
    joined: true,
    query: "gen",
    limit: 5,
    offset: 10,
  });
  expect(parseArgs(["workspace", "info", "--computers"])).toEqual({
    command: "workspace.info",
    computers: true,
  });
  expect(parseArgs(["workspace", "info", "--json"])).toEqual({
    command: "workspace.info",
    json: true,
  });
});

test("refuses conflicting or unusable workspace info options with Raft's messages", () => {
  const refuse = (args: string[], message: string) =>
    expect(() => parseArgs(["workspace", "info", ...args])).toThrow(message);
  refuse(
    ["--full", "--agents"],
    "--full cannot be combined with --channels, --agents, --humans, --projects, or --computers",
  );
  refuse(
    ["--limit", "5"],
    "--query, --limit, --offset, and --joined require --channels, --agents, --humans, --projects, or --computers",
  );
  refuse(["--joined"], "--query, --limit, --offset, and --joined require");
  refuse(["--agents", "--joined"], "--joined can only be used with --channels");
  refuse(["--agents", "--limit", "0"], "--limit must be greater than 0");
  refuse(["--agents", "--limit", "x"], "--limit must be a non-negative integer");
  refuse(["--agents", "--offset", "-1"], "--offset must be a non-negative integer");
  refuse(["--json", "--agents"], "--json prints the whole inventory");
  refuse(["--agents", "--query"], "Usage: coforge workspace info");
  refuse(["--nope"], "Usage: coforge workspace info");
});

test("the summary counts what is visible and points at the narrower queries", () => {
  expect(info([])).toBe(
    [
      "## Workspace",
      "",
      "Channels: 3 visible (1 joined)",
      "Agents: 2",
      "Humans: 2",
      "Projects: 1",
      "Computers: 1",
      "Your role: admin",
      "",
      "Narrow queries:",
      "- coforge workspace info --channels",
      "- coforge workspace info --agents",
      "- coforge workspace info --humans",
      "- coforge workspace info --projects",
      "- coforge workspace info --computers",
      "- coforge channel info <name>",
      "- coforge user info <name>",
      "",
      "Full dump: coforge workspace info --full",
      "",
    ].join("\n"),
  );
});

test("the summary leaves the runtime block to --full", () => {
  const withRuntime = { ...BASE, runtimeContext: { agentName: "scout", runtime: "codex" } };
  expect(info([], withRuntime)).not.toContain("Current Runtime");
  expect(info(["--full"], withRuntime)).toContain("### Current Runtime");
});

test("lists channels with membership, authority, mute, archive and last post", () => {
  expect(info(["--channels"])).toBe(
    [
      "## Workspace Channels",
      "",
      "You see the public channels and the private ones you are in. Do not disclose what a private channel or a private conversation says outside it.",
      "#general [public, joined, channel role=admin, admin via=channel_role, not muted, not archived, last post 2026-09-07 11:30Z (30m ago)] — Everyone.",
      "#old [public, not joined, muted, archived, no posts yet]",
      "#ops [public, not joined, not muted, not archived, no posts yet]",
      "Showing 1-3 of 3.",
      "",
    ].join("\n"),
  );
  expect(info(["--channels", "--joined"])).toContain("Showing 1-1 of 1.");
});

test("a private channel's line says so; one from an older server reads as public", () => {
  const result = {
    ...BASE,
    channels: [
      channel("#secret", { visibility: "private", joined: true }),
      channel("#ops", { visibility: "public" }),
      channel("#old"),
    ],
  };
  const text = info(["--channels"], result);
  expect(text).toContain("#secret [private, joined, not muted, not archived, no posts yet]");
  expect(text).toContain("#ops [public, not joined, not muted, not archived, no posts yet]");
  expect(text).toContain("#old [public, not joined, not muted, not archived, no posts yet]");
});

test("lists agents and humans with role labels, status and descriptions", () => {
  expect(info(["--agents"])).toContain(
    "@scout (online) (admin) — Reviews pull requests.\n@helper (unknown)\n",
  );
  expect(info(["--humans"])).toContain("@ada (owner) — Founder\n@bob\n");
  expect(info(["--projects"])).toContain("Core (core) github=acme/core\n");
  expect(info(["--computers"])).toContain("mac-1 [online, darwin 15.6, v1.2.3] — Mac 1\n");
});

test("says (none) and Showing 0-0 when nothing matches", () => {
  expect(info(["--agents", "--query", "zzz"])).toBe(
    [
      "## Workspace Agents",
      "",
      "Role labels show server-level owner/admin authority; no role label means ordinary member.",
      "(none)",
      "Showing 0-0 of 0.",
      "",
    ].join("\n"),
  );
});

test("pages with --limit and --offset and prints the command for the next page", () => {
  const output = info(["--channels", "--limit", "2", "--query", "o", "--joined"]);
  expect(output).toContain("Showing 1-1 of 1.");
  const many = {
    ...BASE,
    channels: ["#a", "#b", "#c", "#d", "#e"].map((name) => channel(name, { joined: true })),
  };
  expect(info(["--channels", "--limit", "2", "--offset", "2", "--joined"], many)).toBe(
    [
      "## Workspace Channels",
      "",
      "You see the public channels and the private ones you are in. Do not disclose what a private channel or a private conversation says outside it.",
      "#c [public, joined, not muted, not archived, no posts yet]",
      "#d [public, joined, not muted, not archived, no posts yet]",
      "Showing 3-4 of 5.",
      "More: coforge workspace info --channels --offset 4 --limit 2 --joined",
      "",
    ].join("\n"),
  );
  expect(info(["--agents", "--limit", "1", "--query", "e"])).toContain(
    "More: coforge workspace info --agents --offset 1 --limit 1 --query 'e'",
  );
});

test("the query matches the text a row is shown as, ignoring case", () => {
  expect(info(["--humans", "--query", "FOUNDER"])).toContain("@ada");
  expect(info(["--projects", "--query", "github=acme"])).toContain("Core");
  expect(info(["--projects", "--query", "p"])).toContain("Showing 0-0 of 0.");
  expect(info(["--agents", "--query", "member"])).toContain("Showing 0-0 of 0.");
});

test("a page past the last row says nothing was shown, and the More command quotes the query", () => {
  expect(info(["--agents", "--offset", "10"])).toContain("(none)\nShowing 0-0 of 2.\n");
  expect(
    info(["--agents", "--limit", "1", "--query", "it's $x"], {
      ...RICH,
      agents: [agent("it's $x-a"), agent("it's $x-b")],
    }),
  ).toContain("More: coforge workspace info --agents --offset 1 --limit 1 --query 'it'\\''s $x'");
});

test("several sections print one after another", () => {
  const output = info(["--agents", "--humans"]);
  expect(output.indexOf("## Workspace Agents")).toBeLessThan(output.indexOf("## Workspace Humans"));
});

test("--full lists every channel, agent, human, project and Computer", () => {
  const output = info(["--full"]);
  expect(output).toContain("### Current Agent\n- Role: admin");
  expect(output).toContain("### Channels\n");
  expect(output).toContain(
    "  - #general [public, joined, channel role=admin, admin via=channel_role, not muted, last post 2026-09-07 11:30Z (30m ago)] — Everyone.",
  );
  expect(output).toContain("### Agents\nOther AI agents in this Workspace.");
  expect(output).toContain("  - @scout (online) (admin) — Reviews pull requests.");
  expect(output).toContain("### Humans\n");
  expect(output).toContain("  - @ada (owner) — Founder");
  expect(output).toContain("### Projects\n  - Core (core) github=acme/core");
  expect(output).toContain("### Computers\n  - mac-1 [online, darwin 15.6, v1.2.3] — Mac 1");
  expect(info(["--full"], BASE)).toContain("### Computers\n  (none)");
});

test("--json prints the whole response, and adds the runtime context only when it is known", () => {
  expect(JSON.parse(info(["--json"])).channels).toHaveLength(3);
  expect(JSON.parse(info(["--json"], BASE)).runtimeContext).toBeUndefined();
});

test("a server that sends no channels or Computers still renders", () => {
  expect(info(["--channels"], BASE)).toContain("(none)");
  expect(info([], BASE)).toContain("Channels: 0 visible (0 joined)");
});

test("runs end to end through the CLI", async () => {
  const output = await run(["workspace", "info", "--projects", "--query", "core"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
    workspaceInfo: async () => RICH,
  });
  expect(output).toContain("## Workspace Projects");
  expect(output).toContain("Core (core) github=acme/core");
});

test("fills the Agent workspace path from the environment into the runtime block and --json", async () => {
  const previous = Bun.env.COFORGE_CURRENT_AGENT_WORKSPACE_PATH;
  Bun.env.COFORGE_CURRENT_AGENT_WORKSPACE_PATH = "/home/agent/workspaces/w/agents/agent-1";
  try {
    const withId = { ...BASE, runtimeContext: { agentId: "agent-1" } };
    expect(info(["--full"], withId)).toContain(
      "- Agent workspace: /home/agent/workspaces/w/agents/agent-1",
    );
    expect(JSON.parse(info(["--json"], withId)).runtimeContext).toEqual({
      agentId: "agent-1",
      agentWorkspacePath: "/home/agent/workspaces/w/agents/agent-1",
    });
  } finally {
    if (previous === undefined) delete Bun.env.COFORGE_CURRENT_AGENT_WORKSPACE_PATH;
    else Bun.env.COFORGE_CURRENT_AGENT_WORKSPACE_PATH = previous;
  }
});
