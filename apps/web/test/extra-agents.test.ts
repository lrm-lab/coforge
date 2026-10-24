import { describe, expect, test } from "bun:test";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { HELD_AGENT_IDS_LIMIT } from "#src/features/agents/extra-agent";
import { ROSTER_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { listExtraAgents } from "#src/server/agents/extra-agents.server";
import {
  visibleAgentWhere,
  type AgentVisibilityViewer,
} from "#src/server/agents/agent-visibility.server";

const WORKSPACE_ID = "workspace-1";
const member: AgentVisibilityViewer = { kind: "user", userId: "user-member", role: "member" };
const admin: AgentVisibilityViewer = { kind: "user", userId: "user-admin", role: "admin" };
const siblingAgent: AgentVisibilityViewer = {
  kind: "agent",
  agentId: "agent-sibling",
  ownerId: "user-member",
  role: "member",
};

type Row = {
  id: string;
  name: string;
  displayName: string;
  avatarMascot: string | null;
  visibility: string;
  computerId: string | null;
};

const row = (id: string, overrides: Partial<Row> = {}): Row => ({
  id,
  name: id,
  displayName: id.toUpperCase(),
  avatarMascot: null,
  visibility: "public",
  computerId: `computer-${id}`,
  ...overrides,
});

const display = (agentId: string): AgentDisplaySnapshot => ({
  protocolMajor: 1,
  workspaceId: WORKSPACE_ID,
  computerId: `computer-${agentId}`,
  agentId,
  revision: 3,
  activityKind: "online",
  detailKind: "tool_start",
  detail: "",
  entries: [],
  expiresAt: 99_000,
});

type Scope = { workspaceId: string; computerId: string; agentId: string };

function fakes(rows: Row[], busy: string[] = []) {
  const findManyCalls: Prisma.AgentFindManyArgs[] = [];
  const scopeCalls: Array<readonly Scope[]> = [];
  const db = {
    agent: {
      findMany: async (args: Prisma.AgentFindManyArgs) => {
        findManyCalls.push(args);
        return rows;
      },
    },
  } as unknown as Pick<PrismaClient, "agent">;
  const busyCalls: Array<{ workspaceId: string; now: number }> = [];
  const displays = {
    // The busy leases of the Workspace, as `AgentDisplay.busyScopes` answers.
    busyScopes: async (workspaceId: string, now: number) => {
      busyCalls.push({ workspaceId, now });
      return busy.map((agentId) => ({ workspaceId, computerId: `computer-${agentId}`, agentId }));
    },
    snapshotMany: async (scopes: readonly Scope[]) => {
      scopeCalls.push(scopes);
      return scopes.map((scope) => display(scope.agentId));
    },
  };
  return { db, displays, findManyCalls, scopeCalls, busyCalls };
}

describe("listExtraAgents", () => {
  test("reads the Agents the Members directory lists for the viewer, except the viewer's own", async () => {
    const { db, displays, findManyCalls } = fakes([]);
    await listExtraAgents(db, displays, WORKSPACE_ID, member);
    // `visibleAgentWhere` carries its own OR/AND, so it is composed with the roster rule through
    // AND, as `WorkspaceMembers` does.
    expect(findManyCalls[0]!.where).toEqual({
      AND: [
        {
          workspaceId: WORKSPACE_ID,
          deletedAt: null,
          ownerId: { not: "user-member" },
          ...visibleAgentWhere(member),
        },
        ROSTER_AGENT_WHERE,
      ],
    });
  });

  test("asks nothing about whether an Agent is busy, stopped, or has a Computer, and does not cap", async () => {
    const { db, displays, findManyCalls } = fakes([]);
    await listExtraAgents(db, displays, WORKSPACE_ID, member);
    expect(Object.keys(findManyCalls[0]!.where!)).toEqual(["AND"]);
    expect(findManyCalls[0]!.take).toBeUndefined();
  });

  test("an owner or admin is asked for the wider rule than a member", async () => {
    const memberCall = fakes([]);
    const adminCall = fakes([]);
    await listExtraAgents(memberCall.db, memberCall.displays, WORKSPACE_ID, member);
    await listExtraAgents(adminCall.db, adminCall.displays, WORKSPACE_ID, admin);
    expect(adminCall.findManyCalls[0]!.where).toEqual({
      AND: [
        {
          workspaceId: WORKSPACE_ID,
          deletedAt: null,
          ownerId: { not: "user-admin" },
          ...visibleAgentWhere(admin),
        },
        ROSTER_AGENT_WHERE,
      ],
    });
    expect(adminCall.findManyCalls[0]!.where).not.toEqual(memberCall.findManyCalls[0]!.where);
  });

  test("an Agent viewer's own Agents are the ones its creator owns", async () => {
    const { db, displays, findManyCalls } = fakes([]);
    await listExtraAgents(db, displays, WORKSPACE_ID, siblingAgent);
    expect(findManyCalls[0]!.where).toMatchObject({
      AND: [{ ownerId: { not: "user-member" } }, ROSTER_AGENT_WHERE],
    });
  });

  test("snapshots only the busy Agents, in one batch in the rows' order, from each row's own Computer", async () => {
    const { db, displays, scopeCalls, busyCalls } = fakes(
      [row("a"), row("idle"), row("c", { computerId: "computer-moved" })],
      // "gone" is busy but not among the viewer's visible rows: its lease is ignored.
      ["c", "a", "gone"],
    );
    const agents = await listExtraAgents(db, displays, WORKSPACE_ID, member, [], 5_000);
    expect(busyCalls).toEqual([{ workspaceId: WORKSPACE_ID, now: 5_000 }]);
    expect(scopeCalls).toEqual([
      [
        { workspaceId: WORKSPACE_ID, computerId: "computer-a", agentId: "a" },
        { workspaceId: WORKSPACE_ID, computerId: "computer-moved", agentId: "c" },
      ],
    ]);
    expect(agents.map((agent) => "display" in agent)).toEqual([true, false, true]);
  });

  test("makes no display read when nothing is busy or held", async () => {
    const { db, displays, scopeCalls } = fakes([row("a"), row("b")], []);
    const agents = await listExtraAgents(db, displays, WORKSPACE_ID, member);
    expect(scopeCalls).toHaveLength(0);
    expect(agents.some((agent) => "display" in agent)).toBe(false);
  });

  test("makes no display read for a busy Agent with no Computer", async () => {
    const { db, displays, scopeCalls } = fakes([row("a", { computerId: null })], ["a"]);
    await listExtraAgents(db, displays, WORKSPACE_ID, member);
    expect(scopeCalls).toHaveLength(0);
  });

  test("a held Agent that is not busy is snapshotted too, so the browser's stale busy display clears", async () => {
    const { db, displays, scopeCalls } = fakes([row("a"), row("b"), row("c")], ["a"]);
    const agents = await listExtraAgents(db, displays, WORKSPACE_ID, member, ["b"]);
    expect(scopeCalls[0]!.map((scope) => scope.agentId)).toEqual(["a", "b"]);
    expect(agents.map((agent) => "display" in agent)).toEqual([true, true, false]);
  });

  test("a held id outside the visible rows reads nothing", async () => {
    const { db, displays, scopeCalls } = fakes([row("a")], []);
    const agents = await listExtraAgents(db, displays, WORKSPACE_ID, member, ["hidden"]);
    expect(scopeCalls).toHaveLength(0);
    expect(agents.map((agent) => agent.id)).toEqual(["a"]);
  });

  test("dedupes the held ids and ignores those past the limit instead of failing the read", async () => {
    const { db, displays, scopeCalls } = fakes([row("a"), row("late")], []);
    const held = [
      "a",
      "a",
      ...Array.from({ length: HELD_AGENT_IDS_LIMIT }, (_, i) => `filler-${i}`),
      "late",
    ];
    const agents = await listExtraAgents(db, displays, WORKSPACE_ID, member, held);
    expect(scopeCalls[0]!.map((scope) => scope.agentId)).toEqual(["a"]);
    expect(agents.map((agent) => "display" in agent)).toEqual([true, false]);
  });

  test("a failed busy read still answers the held Agents", async () => {
    const { db, displays, scopeCalls } = fakes([row("a"), row("b")], ["a"]);
    const failing = {
      ...displays,
      busyScopes: async () => {
        throw new Error("redis down");
      },
    };
    const agents = await listExtraAgents(db, failing, WORKSPACE_ID, member, ["b"]);
    expect(scopeCalls[0]!.map((scope) => scope.agentId)).toEqual(["b"]);
    expect(agents.map((agent) => "display" in agent)).toEqual([false, true]);
  });

  test("returns every row with what the Agent store needs, the display only where there is one", async () => {
    const { db, displays } = fakes(
      [
        row("work", { avatarMascot: "pink", displayName: "Worker" }),
        row("bare", { computerId: null, visibility: "private" }),
      ],
      ["work"],
    );
    const [work, bare] = await listExtraAgents(db, displays, WORKSPACE_ID, member);
    expect(work).toMatchObject({
      id: "work",
      name: "work",
      displayName: "Worker",
      mascot: "pink",
      avatarUrl: expect.stringContaining("pink"),
      visibility: "public",
      display: { agentId: "work" },
    });
    expect(bare).toMatchObject({ id: "bare", visibility: "private" });
    expect("display" in bare!).toBe(false);
  });

  test("an Agent with no chosen mascot gets the one its id picks", async () => {
    const { db, displays } = fakes([row("a")]);
    const [agent] = await listExtraAgents(db, displays, WORKSPACE_ID, member);
    expect(agent!.mascot).toBeTruthy();
    expect(agent!.avatarUrl).toBeTruthy();
  });

  test("anything but exactly public is private", async () => {
    const { db, displays } = fakes([row("a", { visibility: "hidden" })]);
    const [agent] = await listExtraAgents(db, displays, WORKSPACE_ID, member);
    expect(agent!.visibility).toBe("private");
  });

  test("a failed display read leaves the rows without a display, not the read failed", async () => {
    const { db } = fakes([row("a"), row("b")], ["a", "b"]);
    const displays = {
      busyScopes: async (workspaceId: string) => [
        { workspaceId, computerId: "computer-a", agentId: "a" },
      ],
      snapshotMany: async () => {
        throw new Error("redis down");
      },
    };
    const agents = await listExtraAgents(db, displays, WORKSPACE_ID, member);
    expect(agents.map((agent) => agent.id)).toEqual(["a", "b"]);
    expect(agents.some((agent) => "display" in agent)).toBe(false);
  });
});
