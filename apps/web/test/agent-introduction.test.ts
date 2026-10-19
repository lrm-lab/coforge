import { expect, test } from "bun:test";
import { decodeAgentStartIntent } from "@lrm/coforge-sdk/internal";
import { AgentControl, type AgentControlAgent } from "#src/server/agents/agent-control.server";
import { AGENT_PROFILE_DESCRIPTION_MAX_LENGTH } from "#src/features/agents/agent.schemas";
import {
  AgentIntroduction,
  introductionPromptFor,
  type AgentIntroductionFacts,
  type AgentIntroductionStore,
} from "#src/server/agents/agent-introduction.server";
import { agentDirectKey } from "#src/features/conversations/direct-key";
import { pendingOpStore } from "./helpers/agent-control-store";

const NOW = new Date("2026-10-19T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** The prompt for an Agent @ada created a day ago, still owing its introduction, with `facts` over it. */
function promptFor(facts: Partial<AgentIntroductionFacts> = {}) {
  return introductionPromptFor(
    {
      introductionDueAt: new Date(NOW.getTime() - DAY_MS),
      deletedAt: null,
      description: "Keeps the release notes for the web app.",
      ownerUsername: "ada",
      ...facts,
    },
    NOW,
  );
}

test("an Agent that owes its introduction is asked to introduce itself to its creator by DM, with its role", () => {
  const prompt = promptFor();
  expect(prompt).toContain("introduce yourself to @ada, who created you, in a direct message");
  expect(prompt).toContain("coforge message send --target '@ada'");
  expect(prompt).toContain("your role: Keeps the release notes for the web app.");
  expect(prompt).toContain("or else the language of your role description.");
  expect(prompt).toContain("Never post this introduction in a channel.");
});

test.each([
  ["owes none", { introductionDueAt: null }, false],
  [
    "was due more than seven days ago",
    { introductionDueAt: new Date(NOW.getTime() - 7 * DAY_MS - 1) },
    false,
  ],
  ["is deleted", { deletedAt: new Date(NOW.getTime() - 1) }, false],
  [
    "was due exactly seven days ago",
    { introductionDueAt: new Date(NOW.getTime() - 7 * DAY_MS) },
    true,
  ],
] as const)("an Agent that %s gets a prompt: %p", (_case, facts, prompted) => {
  expect(promptFor(facts) !== undefined).toBe(prompted);
});

test("an Agent with no description asks its creator what they want help with instead of naming a role", () => {
  const prompt = promptFor({ description: "   " });
  expect(prompt).toContain("introduce yourself to @ada, who created you, in a direct message");
  expect(prompt).toContain("ask what they want your help with");
  expect(prompt).not.toContain("role");
});

test("a description longer than an Agent profile allows is cut to that length", () => {
  const prompt = promptFor({
    description: `${"a".repeat(AGENT_PROFILE_DESCRIPTION_MAX_LENGTH)}TAIL`,
  });
  expect(prompt).toContain(`your role: ${"a".repeat(AGENT_PROFILE_DESCRIPTION_MAX_LENGTH)} —`);
  expect(prompt).not.toContain("TAIL");
});

/** A message Agent "agent-a" sent, in the conversation with this `directKey` (null: a channel). */
type AgentMessage = { directKey: string | null; createdAt: Date };

/** AgentControl over Agent "agent-a", created by @ada ("owner-a") a day ago, with `facts` over it
 * and `messages` it has sent; its Starts are decoded as the Daemon reads them. */
function controlFixture(
  options: {
    facts?: Partial<AgentIntroductionFacts>;
    messages?: AgentMessage[];
    fail?: "read" | "settle";
  } = {},
) {
  const agent: AgentControlAgent = {
    id: "agent-a",
    workspaceId: "workspace-a",
    computerId: "computer-a",
    ownerId: "owner-a",
    visibility: "public",
    runtimeConfig: {
      runtime: "pi",
      provider: { kind: "default" },
      model: "",
      modelProvider: "",
      reasoning: "",
    },
    state: null,
    introductionDueAt: new Date(NOW.getTime() - DAY_MS),
    description: "Keeps the release notes for the web app.",
    ownerUsername: "ada",
    ...options.facts,
  };
  const settled: Parameters<AgentIntroductionStore["settle"]>[0][] = [];
  const store: AgentIntroductionStore = {
    hasAgentMessage: async ({ agentId, directKey, since }) => {
      if (options.fail === "read") throw new Error("database unavailable");
      return (
        agentId === "agent-a" &&
        (options.messages ?? []).some(
          (message) => message.directKey === directKey && message.createdAt >= since,
        )
      );
    },
    settle: async (input) => {
      if (options.fail === "settle") throw new Error("database unavailable");
      settled.push(input);
    },
  };
  const starts: ReturnType<typeof decodeAgentStartIntent>[] = [];
  const control = new AgentControl(
    pendingOpStore(agent).store,
    { publish: async (_channel, bytes) => void starts.push(decodeAgentStartIntent(bytes)) },
    { run: async (_id, work) => work() },
    { timeoutMs: 0, fallbackMs: 0, now: () => NOW.getTime() },
    undefined,
    undefined,
    undefined,
    undefined,
    new AgentIntroduction(store),
  );
  const intent = {
    protocolMajor: 1,
    workspaceId: "workspace-a",
    computerId: "computer-a",
    agentId: "agent-a",
    provider: "pi" as const,
    model: "",
    reasoning: "",
  };
  return { control, starts, intent, settled };
}

test("the Start that follows an Agent's creation carries its introduction prompt", async () => {
  const { control, starts, intent } = controlFixture();
  await control.publishStart({ ...intent, requestId: "create" }, "owner-a");
  expect(starts).toHaveLength(1);
  expect(starts[0]!.introductionPrompt).toContain("introduce yourself to @ada, who created you");
});

test("a ready-recovery Start carries the introduction prompt beside its message recovery", async () => {
  const { control, starts, intent } = controlFixture();
  await control.recover({ ...intent, requestId: "ready", unreadSummary: { "@ada": 1 } }, "owner-a");
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({ requestId: "ready", unreadSummary: { "@ada": 1 } });
  expect(starts[0]!.introductionPrompt).toContain("introduce yourself to @ada");
});

test("a channel's Resume all Start carries the introduction prompt beside its resume prompt", async () => {
  const { control, starts } = controlFixture();
  await control.startMany({
    userId: "owner-a",
    workspaceId: "workspace-a",
    agentIds: ["agent-a"],
    resumePrompt: "Catch up on #general.",
  });
  expect(starts).toHaveLength(1);
  expect(starts[0]!.resumePrompt).toBe("Catch up on #general.");
  expect(starts[0]!.introductionPrompt).toContain("introduce yourself to @ada");
});

test("the Starts of an Agent that owes no introduction carry no prompt", async () => {
  const { control, starts, intent } = controlFixture({ facts: { introductionDueAt: null } });
  await control.publishStart({ ...intent, requestId: "config-restart" }, "owner-a");
  expect(starts).toHaveLength(1);
  expect(starts[0]!.introductionPrompt).toBeUndefined();
});

test("an Agent that already wrote in its creator's DM is settled at its next Start, which carries no prompt", async () => {
  const { control, starts, intent, settled } = controlFixture({
    messages: [{ directKey: agentDirectKey("owner-a", "agent-a"), createdAt: NOW }],
  });
  await control.publishStart({ ...intent, requestId: "restart" }, "owner-a");
  expect(starts).toHaveLength(1);
  expect(starts[0]!.introductionPrompt).toBeUndefined();
  expect(settled).toEqual([{ workspaceId: "workspace-a", agentId: "agent-a", ownerId: "owner-a" }]);
});

test.each([
  ["another person's DM", agentDirectKey("someone-else", "agent-a")],
  ["a channel", null],
] as const)(
  "an Agent whose only message is in %s still owes its introduction",
  async (_case, directKey) => {
    const { control, starts, intent, settled } = controlFixture({
      messages: [{ directKey, createdAt: NOW }],
    });
    await control.publishStart({ ...intent, requestId: "restart" }, "owner-a");
    expect(starts[0]!.introductionPrompt).toContain("introduce yourself to @ada");
    expect(settled).toEqual([]);
  },
);

test.each(["read", "settle"] as const)(
  "a Start whose introduction %s fails is logged and still carries the prompt",
  async (fail) => {
    const warn = console.warn;
    const warnings: unknown[] = [];
    console.warn = (line: string) => void warnings.push(JSON.parse(line));
    try {
      const { control, starts, intent } = controlFixture({
        fail,
        messages: [{ directKey: agentDirectKey("owner-a", "agent-a"), createdAt: NOW }],
      });
      await control.publishStart({ ...intent, requestId: "restart" }, "owner-a");
      expect(starts).toHaveLength(1);
      expect(starts[0]!.introductionPrompt).toContain("introduce yourself to @ada");
      expect(warnings).toEqual([
        expect.objectContaining({ event: "agent_introduction:check_failed", agent_id: "agent-a" }),
      ]);
    } finally {
      console.warn = warn;
    }
  },
);
