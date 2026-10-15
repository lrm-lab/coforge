import { expect, test } from "bun:test";
import { knowledgeResource, validateKnowledgeReady } from "../src/knowledge";

test("document ingestion excludes labels and hidden answers", () => {
  expect(
    knowledgeResource("document", {
      docid: "d1",
      text: "Evidence text",
      url: "https://example.org",
      answer: "secret",
      gold: true,
    }),
  ).toEqual({
    uri: "viking://resources/evo-ir/documents/d1.md",
    text: "Source: https://example.org\n\nEvidence text",
  });
});

test("a frozen IR test refuses incomplete or mismatched prepared knowledge", () => {
  const ready = {
    version: 2,
    arm: "warm",
    accountId: "prepared-ir",
    accountCreatedAt: "2026-10-15T00:00:00Z",
    documents: 67707,
    experiences: 89,
    corpusSha256: "a".repeat(64),
    ledgerSha256: "b".repeat(64),
    processingMode: "bm25",
    completed: true,
  };
  expect(validateKnowledgeReady(ready).accountId).toBe("prepared-ir");
  expect(() => validateKnowledgeReady({ ...ready, completed: false })).toThrow();
  expect(() => validateKnowledgeReady({ ...ready, documents: 0 })).toThrow();
  expect(() => validateKnowledgeReady({ ...ready, ledgerSha256: "" })).toThrow();
});

test("cold preparation contains evidence documents and no train experience", () => {
  const ready = {
    version: 2,
    arm: "cold",
    accountId: "cold",
    accountCreatedAt: "2026-10-15T00:00:00Z",
    documents: 67707,
    experiences: 0,
    corpusSha256: "a".repeat(64),
    ledgerSha256: "b".repeat(64),
    processingMode: "bm25",
    completed: true,
  };
  expect(validateKnowledgeReady(ready).experiences).toBe(0);
  expect(() => validateKnowledgeReady({ ...ready, experiences: 1 })).toThrow();
  expect(() =>
    validateKnowledgeReady({ ...ready, processingMode: "semantic_and_vectors" }),
  ).toThrow();
});
