import { expect, test } from "bun:test";
import { fuseRetrievalRanks, summarizeRetrieval } from "../scripts/team-memory-retrieval-ranking";

test("combines overlapping results and prefers the keyword match when scores tie", () => {
  expect(
    fuseRetrievalRanks(["task-code", "decision", "nearby"], ["paraphrase", "decision", "other"]),
  ).toEqual(["decision", "task-code", "paraphrase", "nearby", "other"]);
});

test("calculates recall and obsolete exposure per query within the first five results", () => {
  expect(
    summarizeRetrieval([
      { relevant: ["one", "two"], obsolete: ["old"], ranked: ["one", "old"], ms: 25 },
      {
        relevant: ["three"],
        obsolete: ["old"],
        ranked: ["three", "four", "five", "six", "seven", "old"],
        ms: 430,
      },
    ]),
  ).toEqual({
    queries: 2,
    recallAt5: 0.75,
    obsoleteAt5: 0.5,
    overBudget: 1,
    p50Ms: 25,
    p95Ms: 430,
  });
});

test("a semantic-only hit can enter a full keyword ranking", () => {
  expect(
    fuseRetrievalRanks(["lex-a", "lex-b", "lex-c", "lex-d", "lex-e"], ["relevant", "sem-a"]),
  ).toEqual(["lex-a", "relevant", "lex-b", "sem-a", "lex-c"]);
});
