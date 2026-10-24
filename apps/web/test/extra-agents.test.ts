import { describe, expect, test } from "bun:test";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
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

function fakes(rows: Row[]) {
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
  const displays = {
    snapshotMany: async (scopes: readonly Scope[]) => {
      scopeCalls.push(scopes);
      return scopes.map((scope) => display(scope.agentId));
    },
  };
  return { db, displays, findManyCalls, scopeCalls };
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

  test("reads the display of every Agent with a Computer in one batch, in the rows' order", async () => {
    const { db, displays, scopeCalls } = fakes([
      row("a"),
      row("none", { computerId: null }),
      row("c"),
    ]);
    await listExtraAgents(db, displays, WORKSPACE_ID, member);
    expect(scopeCalls).toEqual([
      [
        { workspaceId: WORKSPACE_ID, computerId: "computer-a", agentId: "a" },
        { workspaceId: WORKSPACE_ID, computerId: "computer-c", agentId: "c" },
      ],
    ]);
  });

  test("makes no display read when no Agent has a Computer", async () => {
    const { db, displays, scopeCalls } = fakes([row("a", { computerId: null })]);
    await listExtraAgents(db, displays, WORKSPACE_ID, member);
    expect(scopeCalls).toHaveLength(0);
  });

  test("returns every row with what the Agent store needs, the display only where there is one", async () => {
    const { db, displays } = fakes([
      row("work", { avatarMascot: "pink", displayName: "Worker" }),
      row("bare", { computerId: null, visibility: "private" }),
    ]);
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
    const { db } = fakes([row("a"), row("b")]);
    const displays = {
      snapshotMany: async () => {
        throw new Error("redis down");
      },
    };
    const agents = await listExtraAgents(db, displays, WORKSPACE_ID, member);
    expect(agents.map((agent) => agent.id)).toEqual(["a", "b"]);
    expect(agents.some((agent) => "display" in agent)).toBe(false);
  });
});
