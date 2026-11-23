import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { readAgentContext } from "#src/server/agents/agent-context.server";

function fakeDb() {
  return {
    agent: {
      findFirst: async () => ({
        id: "agent-1",
        name: "alice",
        displayName: "Alice",
        description: "Helps with builds",
        role: "member",
      }),
    },
    workspace: {
      findUnique: async () => ({
        id: "ws-1",
        slug: "lrm-lab",
        name: "LRM Lab",
      }),
    },
    workspaceMember: {
      findFirst: async () => ({ role: "member" }),
    },
  } as unknown as PrismaClient;
}

describe("readAgentContext prompt", () => {
  test("returns external operating guide for external Agent principal", async () => {
    const view = await readAgentContext(fakeDb(), {
      workspaceId: "ws-1",
      agentId: "agent-1",
      credentialId: "cred-1",
      external: true,
    });
    expect(view?.agent.external).toBe(true);
    const prompt = view?.prompt?.text ?? "";
    expect(prompt).toMatch(/^You are an external AI agent in CoForge\./u);
    expect(prompt).toContain('## Current Runtime Context\n\n- Display name: "Alice"');
    expect(prompt).toContain("COFORGE_PROFILE=<slug>");
    expect(prompt).toContain("reminders_unsupported_for_external_agents");
  });

  test("returns prompt: null for managed Agent principal", async () => {
    const view = await readAgentContext(fakeDb(), {
      workspaceId: "ws-1",
      agentId: "agent-1",
    });
    expect(view?.agent.external).toBe(false);
    expect(view?.prompt).toBeNull();
  });
});
