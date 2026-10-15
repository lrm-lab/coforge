import { expect, test } from "bun:test";
import { reminderForEpisode } from "../src/benchmarks";
import { runEpisode, episodePrompt, createEpisodeRuntimeDiagnostics } from "../src/eval-qa";
import type { EvalWorkspace } from "../src/workspace";
import type { EvalEnv } from "../src/env";
import type { ManifestEpisode } from "../src/types";

const episode: ManifestEpisode = {
  benchmark: "evoagentbench",
  episodeId: "1",
  taskId: "1",
  familyId: "ir",
  domain: "information_retrieval",
  split: "test",
  role: "qa",
  order: 1,
  prompt:
    "Question: find the bird.\n\n## How to call search in this environment\npython3 /raw/ir_search.py query 10",
  grader: { kind: "browsecomp.judge", answer: "hidden-answer" },
  stageFiles: [{ src: "ir_search.py", dst: "ir_search.py" }],
};
function fixture(
  messages: {
    id: string;
    body: string;
    createdAt: Date;
    mentions: { kind: string; actorId: string }[];
  }[],
  memoryMessages: { id: string; createdAt: Date }[] = [],
  offers: { messageId: string; citations: { citationId: string }[] }[] = [],
) {
  const start = new Date(Date.now() - 1000);
  const workspace = {
    workspaceId: "workspace",
    channelId: "channel",
    evalUserId: "owner",
    taskAgentId: "task",
    memoryAgentId: "memory",
    db: {
      async $queryRaw() {
        return [{ count: 0 }];
      },
      conversationMember: {
        async findFirst() {
          return { id: "member" };
        },
      },
      message: {
        async findFirst() {
          return null;
        },
        async create() {
          return { id: "trigger", createdAt: start };
        },
        async findMany(input: { where: { sender: { agentId: string } } }) {
          return input.where.sender.agentId === "task" ? messages : memoryMessages;
        },
      },
      memoryOfferRecord: {
        async findFirst() {
          return null;
        },
        async findMany() {
          return offers;
        },
      },
      memoryHintRecord: {
        async findMany() {
          return [];
        },
      },
    },
  } as unknown as EvalWorkspace;
  const env = { redisUrl: "", abortQuietMs: 0, pollMs: 1, envNote: null } as EvalEnv;
  return {
    workspace,
    env,
    episode,
    reminder: "Post final answer",
    episodeTimeoutMs: 20,
    settleMs: 0,
  };
}
test("a Task answer may finish without an unsolicited memory preflight", async () => {
  const result = await runEpisode(
    fixture([{ id: "answer", body: "Exact Answer: bird", createdAt: new Date(), mentions: [] }]),
  );
  expect(result.finalOutput).toBe("Exact Answer: bird");
  expect(result.terminationReason).toBe("final_settled");
  expect(result.timedOut).toBe(false);
});
test("an @memory request is never treated as a final task answer", async () => {
  const result = await runEpisode(
    fixture([
      {
        id: "request",
        body: "@memory find the bird",
        createdAt: new Date(),
        mentions: [{ kind: "agent", actorId: "memory" }],
      },
    ]),
  );
  expect(result.finalOutput).toBeNull();
  expect(result.memoryRequestCount).toBe(1);
  expect(result.memoryRequestMessageIds).toEqual(["request"]);
});
test("the production prompt has no raw search command or grader answer", () => {
  const text = episodePrompt(episode, "Post final answer");
  expect(text.startsWith("@task @memory Question: find the bird.")).toBe(true);
  expect(text).not.toContain("ir_search.py");
  expect(text).not.toContain("hidden-answer");
});

test("IR retains the answer format and asks Memory for both evidence and experience", () => {
  const reminder = reminderForEpisode("evoagentbench", "information_retrieval");
  expect(reminder).toContain("Exact Answer:");
  expect(reminder).toContain("@memory");
  expect(reminder).not.toContain("complete final code");
});

test("multiple offers and ordinary Memory clarification are recorded without false leaks", async () => {
  const now = new Date();
  const result = await runEpisode(
    fixture(
      [
        {
          id: "request-1",
          body: "@memory experience",
          createdAt: now,
          mentions: [{ kind: "agent", actorId: "memory" }],
        },
        {
          id: "request-2",
          body: "@memory documents",
          createdAt: now,
          mentions: [{ kind: "agent", actorId: "memory" }],
        },
        { id: "answer", body: "Exact Answer: 2041", createdAt: now, mentions: [] },
      ],
      [
        { id: "offer-1", createdAt: now },
        { id: "clarification", createdAt: now },
        { id: "offer-2", createdAt: now },
      ],
      [
        { messageId: "offer-2", citations: [{ citationId: "source-2" }] },
        { messageId: "offer-1", citations: [{ citationId: "source-1" }] },
      ],
    ),
  );
  expect(result.memoryRequestCount).toBe(2);
  expect(result.offerMessageIds).toEqual(["offer-2", "offer-1"]);
  expect(result.citationCount).toBe(2);
  expect(result.memoryLeakMessageIds).toEqual([]);
  expect(result.memoryReplyMessageIds).toEqual(["clarification"]);
  expect(result.finalOutput).toBe("Exact Answer: 2041");
});

test("the human task explicitly wakes both agents, with one Memory mention", () => {
  const prompt = episodePrompt(
    { ...episode, prompt: "Find a bird. Ask @memory for evidence." },
    "Ask @memory for documents.",
  );
  expect(prompt.startsWith("@task @memory Find a bird.")).toBe(true);
  expect(prompt.match(/@memory\b/g)).toHaveLength(1);
  expect(prompt).toContain("Ask Memory Agent for evidence.");
});

test("an IR final answer can mention Memory in its explanation", async () => {
  const result = await runEpisode(
    fixture([
      {
        id: "answer",
        body: "Evidence came from @memory.\nExact Answer: 2041\nConfidence: High",
        createdAt: new Date(),
        mentions: [{ kind: "agent", actorId: "memory" }],
      },
    ]),
  );
  expect(result.terminationReason).toBe("final_settled");
  expect(result.memoryRequestCount).toBe(0);
});

test("a Task answer cannot settle while the initially mentioned Memory is running", async () => {
  const input = fixture([
    { id: "answer", body: "Exact Answer: bird", createdAt: new Date(), mentions: [] },
  ]);
  const diagnostics = createEpisodeRuntimeDiagnostics();
  const result = await runEpisode({ ...input, runtimeDiagnostics: diagnostics });
  expect(result.terminationReason).not.toBe("final_settled");
  expect(result.finalOutput).toBe("Exact Answer: bird");
});

test("a late Memory reply gives Task another settlement window", async () => {
  const now = Date.now();
  const input = fixture(
    [{ id: "answer", body: "Exact Answer: bird", createdAt: new Date(now - 1000), mentions: [] }],
    [{ id: "late-offer", createdAt: new Date(now) }],
  );
  const result = await runEpisode({ ...input, settleMs: 1000 });
  expect(result.terminationReason).not.toBe("final_settled");
});

test("a settled Task answer waits for Memory's batched but unread channel updates", async () => {
  const input = fixture([
    { id: "answer", body: "Exact Answer: bird", createdAt: new Date(), mentions: [] },
  ]);
  input.workspace.db.$queryRaw = (async () => [
    { count: 1 },
  ]) as typeof input.workspace.db.$queryRaw;
  const result = await runEpisode(input);
  expect(result.terminationReason).not.toBe("final_settled");
  expect(result.finalOutput).toBe("Exact Answer: bird");
});
