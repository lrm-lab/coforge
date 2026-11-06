import { describe, expect, test } from "bun:test";

import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE, ROSTER_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { statusAgentScopes } from "#src/server/agents/agent-roster.server";

// Task #587: the status floor on the shared status channel may answer for every live Agent in
// the Workspace, so the page needs the set of Agents that may report one — ids and Computers
// only, with no visibility rule and no profile fields.
describe("statusAgentScopes", () => {
  test("reads every live roster Agent's id and Computer, whatever the viewer may see", async () => {
    const calls: Prisma.AgentFindManyArgs[] = [];
    const rows = [
      { id: "agent-a", computerId: "computer-a" },
      { id: "agent-b", computerId: null },
    ];
    const db = {
      agent: {
        findMany: async (args: Prisma.AgentFindManyArgs) => {
          calls.push(args);
          return rows;
        },
      },
    } as unknown as Pick<PrismaClient, "agent">;

    expect(await statusAgentScopes(db, "workspace-1")).toEqual(rows);
    expect(calls).toHaveLength(1);
    const query = calls[0]!;
    expect(query.where).toEqual({
      workspaceId: "workspace-1",
      ...ACTIVE_AGENT_WHERE,
      ...ROSTER_AGENT_WHERE,
    });
    // No visibility, ownership or system-kind filter beyond the roster rule, and no cap.
    expect(Object.keys(query.where!)).not.toContain("visibility");
    expect(Object.keys(query.where!)).not.toContain("ownerId");
    expect(query.take).toBeUndefined();
    expect(query.select).toEqual({ id: true, computerId: true });
  });
});
