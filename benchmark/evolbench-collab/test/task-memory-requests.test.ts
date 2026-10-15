import { expect, test } from "bun:test";
import { reminderForEpisode } from "../src/benchmarks";
import { runEpisode, episodePrompt } from "../src/eval-qa";
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
) {
  const start = new Date(Date.now() - 1000);
  const workspace = {
    workspaceId: "workspace",
    channelId: "channel",
    evalUserId: "owner",
    taskAgentId: "task",
    memoryAgentId: "memory",
    db: {
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
          return input.where.sender.agentId === "task" ? messages : [];
        },
      },
      memoryOfferRecord: {
        async findFirst() {
          return null;
        },
        async findMany() {
          return [];
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
  expect(text.startsWith("@task Question: find the bird.")).toBe(true);
  expect(text).not.toContain("ir_search.py");
  expect(text).not.toContain("hidden-answer");
});

test("IR retains the answer format and asks Memory for both evidence and experience", () => {
  const reminder = reminderForEpisode("evoagentbench", "information_retrieval");
  expect(reminder).toContain("Exact Answer:");
  expect(reminder).toContain("@memory");
  expect(reminder).not.toContain("complete final code");
});
