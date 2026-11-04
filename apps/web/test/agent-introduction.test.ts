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
import { WORKSPACE_ASSISTANT_KIND } from "#src/features/agents/agent-system-kind";
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

test("a platform assistant with no introductionDueAt still owes its welcome", () => {
  const prompt = promptFor({
    systemKind: WORKSPACE_ASSISTANT_KIND,
    introductionDueAt: null,
  });
  expect(prompt).toContain("CoForge platform assistant");
});

test("a platform assistant owes no introduction while its owner's setup wizard is pending", () => {
  const assistant = { systemKind: WORKSPACE_ASSISTANT_KIND, introductionDueAt: null };
  expect(promptFor({ ...assistant, onboardingPending: true })).toBeUndefined();
  expect(promptFor({ ...assistant, onboardingPending: false })).toContain("platform assistant");
  expect(promptFor(assistant)).toContain("platform assistant");
  // The wizard belongs to the platform assistant; an ordinary Agent's introduction is unaffected.
  expect(promptFor({ onboardingPending: true })).toContain("introduce yourself to @ada");
});

test("the platform assistant's welcome says Agents are teammates and offers a starter team for a known role", () => {
  const prompt = promptFor({
    systemKind: WORKSPACE_ASSISTANT_KIND,
    introductionDueAt: null,
    ownerRole: "designer",
  });
  expect(prompt).toContain("Agents are teammates");
  expect(prompt).toContain("designer");
  expect(prompt).toContain("starter team of Agents");
  expect(prompt).toContain("only after");
  expect(prompt).not.toContain("what they are working on");
  // The existing starter choices and their rules stay.
  expect(prompt).toContain("five clickable starter choices");
});

test("without a known role the welcome asks what the member is working on and never asks their role", () => {
  for (const ownerRole of [undefined, null, "astronaut"]) {
    const prompt = promptFor({
      systemKind: WORKSPACE_ASSISTANT_KIND,
      introductionDueAt: null,
      ownerRole,
    });
    expect(prompt).toContain("Agents are teammates");
    expect(prompt).toContain("what they are working on");
    expect(prompt).not.toContain("starter team of Agents");
    expect(prompt).toContain("never ask");
  }
});

test("a platform assistant owes no welcome to a member someone else welcomed when they joined", () => {
  const facts = { systemKind: WORKSPACE_ASSISTANT_KIND, introductionDueAt: null };
  expect(promptFor({ ...facts, assistantWelcome: false })).toBeUndefined();
  expect(promptFor({ ...facts, assistantWelcome: true })).toContain("platform assistant");
  expect(promptFor(facts)).toContain("platform assistant");
});

test("an Agent also introduces itself in #general only when its Workspace asks and it can post there", () => {
  const off = promptFor();
  expect(off).toContain("Never post this introduction in a channel.");
  expect(off).not.toContain("#general");

  const on = promptFor({ greetGeneral: true })!;
  expect(on).toContain("introduce yourself to @ada, who created you, in a direct message");
  expect(on).toContain("coforge message send --target '#general'");
  expect(on).toContain("two-to-three sentence self-introduction");
  expect(on).not.toContain("Never post this introduction in a channel.");
  expect(on).toContain("only as a direct message");
  // The greeting adds to the introduction an Agent owes; it never creates one.
  expect(promptFor({ greetGeneral: true, introductionDueAt: null })).toBeUndefined();
  expect(
    promptFor({
      greetGeneral: true,
      systemKind: WORKSPACE_ASSISTANT_KIND,
      introductionDueAt: null,
    }),
  ).not.toContain("#general");
});

test("a platform assistant's own DM reply settles an unset introductionDueAt", async () => {
  const scopes: { since: Date }[] = [];
  const introductions = new AgentIntroduction({
    setupFacts: async () => ({ onboardingPending: false, ownerRole: null }),
    hasAgentMessage: async ({ since }) => {
      scopes.push({ since });
      return true;
    },
    settle: async () => {},
    workspaceFacts: async () => ({}),
  });
  const prompt = await introductions.promptFor(
    {
      id: "agent-a",
      workspaceId: "workspace-a",
      ownerId: "owner-a",
      systemKind: WORKSPACE_ASSISTANT_KIND,
      introductionDueAt: null,
      ownerUsername: "ada",
    },
    NOW,
  );
  expect(prompt).toBeUndefined();
  expect(scopes).toEqual([{ since: new Date(0) }]);
});

test("an Agent with no description asks its creator what they want help with instead of naming a role", () => {
  const prompt = promptFor({ description: "   " });
  expect(prompt).toContain("introduce yourself to @ada, who created you, in a direct message");
  expect(prompt).toContain("ask what they want your help with");
  expect(prompt).not.toContain("role");
});

test("a new Agent sends its greeting without running a startup audit", () => {
  const prompt = promptFor({ description: "" });
  expect(prompt).toContain(
    "Do not read memory, list tasks, or scan channels merely to prepare this greeting.",
  );
  expect(prompt).toContain("A local final answer is not a delivered message");
  expect(prompt).toContain(
    "After sending a greeting with no request to act on, end this turn and wait.",
  );
  expect(prompt).toContain(
    "If the creator has already sent a request, use the tools needed for that request.",
  );
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
    fail?: "read" | "settle" | "setup";
    /** The owner's setup facts, which only a platform assistant's Start reads. */
    setup?: { onboardingPending: boolean; ownerRole: string | null };
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
  const reads = { setup: 0, messages: 0 };
  const store: AgentIntroductionStore = {
    setupFacts: async () => {
      reads.setup++;
      if (options.fail === "setup") throw new Error("database unavailable");
      return options.setup ?? { onboardingPending: false, ownerRole: null };
    },
    hasAgentMessage: async ({ agentId, directKey, since }) => {
      reads.messages++;
      if (options.fail === "read") throw new Error("database unavailable");
      return (
        agentId === "agent-a" &&
        (options.messages ?? []).some(
          (message) => message.directKey === directKey && message.createdAt >= since,
        )
      );
    },
    workspaceFacts: async () => ({}),
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
  return { control, starts, intent, settled, reads };
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

const assistantFacts = { systemKind: WORKSPACE_ASSISTANT_KIND, introductionDueAt: null } as const;

test("a platform assistant's Start carries no welcome while its owner's wizard is pending, and does not look for one", async () => {
  const { control, starts, intent, reads } = controlFixture({
    facts: assistantFacts,
    setup: { onboardingPending: true, ownerRole: "designer" },
  });
  await control.publishStart({ ...intent, requestId: "wizard" }, "owner-a");
  expect(starts).toHaveLength(1);
  expect(starts[0]!.introductionPrompt).toBeUndefined();
  expect(reads).toEqual({ setup: 1, messages: 0 });
});

test("the welcome reads the owner's saved role when it is made", async () => {
  const { control, starts, intent } = controlFixture({
    facts: assistantFacts,
    setup: { onboardingPending: false, ownerRole: "designer" },
  });
  await control.publishStart({ ...intent, requestId: "done" }, "owner-a");
  expect(starts[0]!.introductionPrompt).toContain("they work as: designer");
});

test("only a platform assistant that owes a welcome reads the owner's setup facts", async () => {
  // An ordinary Agent, whether or not it owes an introduction, never does.
  for (const options of [{ facts: { introductionDueAt: null } }, {}]) {
    const { control, intent, reads } = controlFixture(options);
    await control.publishStart({ ...intent, requestId: "other" }, "owner-a");
    expect(reads.setup).toBe(0);
  }
  // Nor does an assistant with no creator to welcome.
  let read = 0;
  const introductions = new AgentIntroduction({
    setupFacts: async () => {
      read++;
      return { onboardingPending: false, ownerRole: null };
    },
    hasAgentMessage: async () => false,
    settle: async () => {},
    workspaceFacts: async () => ({}),
  });
  await introductions.promptFor(
    {
      id: "agent-a",
      workspaceId: "workspace-a",
      ownerId: "owner-a",
      ...assistantFacts,
      deletedAt: NOW,
      ownerUsername: "ada",
    },
    NOW,
  );
  expect(read).toBe(0);
});

test("a platform assistant whose setup facts cannot be read stays silent rather than welcoming early", async () => {
  const warn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (line: string) => void warnings.push(JSON.parse(line));
  try {
    const { control, starts, intent } = controlFixture({ facts: assistantFacts, fail: "setup" });
    await control.publishStart({ ...intent, requestId: "setup-failed" }, "owner-a");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.introductionPrompt).toBeUndefined();
    expect(warnings).toEqual([
      expect.objectContaining({
        event: "agent_introduction:setup_unreadable",
        agent_id: "agent-a",
      }),
    ]);
  } finally {
    console.warn = warn;
  }
});

test("a Daemon coming ready does not start a platform assistant whose owner's wizard is pending", async () => {
  const held = controlFixture({
    facts: assistantFacts,
    setup: { onboardingPending: true, ownerRole: null },
  });
  await held.control.recover({ ...held.intent, requestId: "ready" }, "owner-a");
  expect(held.starts).toHaveLength(0);

  const done = controlFixture({
    facts: assistantFacts,
    setup: { onboardingPending: false, ownerRole: null },
  });
  await done.control.recover({ ...done.intent, requestId: "ready" }, "owner-a");
  expect(done.starts).toHaveLength(1);

  // An unreadable mark holds the Start as well, and an ordinary Agent is never held.
  const warn = console.warn;
  console.warn = () => {};
  try {
    const unreadable = controlFixture({ facts: assistantFacts, fail: "setup" });
    await unreadable.control.recover({ ...unreadable.intent, requestId: "ready" }, "owner-a");
    expect(unreadable.starts).toHaveLength(0);
  } finally {
    console.warn = warn;
  }
  const ordinary = controlFixture();
  await ordinary.control.recover({ ...ordinary.intent, requestId: "ready" }, "owner-a");
  expect(ordinary.starts).toHaveLength(1);
  expect(ordinary.reads.setup).toBe(0);
});

test("a Start reads the Workspace's onboarding only for an Agent that may owe an introduction", async () => {
  let reads = 0;
  const introductions = (facts: () => Promise<{ assistantWelcome?: boolean }>) =>
    new AgentIntroduction({
      hasAgentMessage: async () => false,
      settle: async () => {},
      // The owner finished the setup wizard (main's check before an assistant welcomes).
      setupFacts: async () => ({ onboardingPending: false, ownerRole: null }),
      workspaceFacts: async () => {
        reads += 1;
        return facts();
      },
    });
  const assistant = {
    id: "assistant-a",
    workspaceId: "workspace-a",
    ownerId: "user-a",
    ownerUsername: "ada",
    systemKind: WORKSPACE_ASSISTANT_KIND,
  };
  const now = new Date("2026-11-02T08:00:00Z");

  // Someone else welcomed the member when they joined, or nobody did: the assistant does not.
  expect(
    await introductions(async () => ({ assistantWelcome: false })).promptFor(assistant, now),
  ).toBeUndefined();
  expect(
    await introductions(async () => ({ assistantWelcome: true })).promptFor(assistant, now),
  ).toContain("@ada");
  // A failed read keeps the welcome as it was before these settings.
  expect(
    await introductions(async () => {
      throw new Error("database unavailable");
    }).promptFor(assistant, now),
  ).toContain("@ada");

  // An Agent that owes nothing is not read for it.
  reads = 0;
  await introductions(async () => ({})).promptFor(
    { id: "agent-b", workspaceId: "workspace-a", ownerId: "user-a", ownerUsername: "ada" },
    now,
  );
  expect(reads).toBe(0);
});
