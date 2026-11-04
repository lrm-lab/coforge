import { expect, test } from "bun:test";
import {
  resolveMentionTargets,
  taskReferenceToken,
  type MentionTarget,
} from "@lrm/coforge-sdk/internal";
import { readMessageReferences, type MessageReferenceLookup } from "#src/lib/message-references";

/** What a body could mean, read the way a send reads it. */
const messageReferenceCandidates = (body: string) => readMessageReferences(body).candidates;
/** The stored body once `lookup` answers the candidates. */
const resolveMessageReferences = (body: string, lookup: MessageReferenceLookup) =>
  readMessageReferences(body).resolve(lookup).body;

const ADA = {
  key: "member-ada",
  type: "user" as const,
  id: "11111111-1111-4111-8111-111111111111",
  handle: "ada",
};
const HELPER = {
  key: "member-helper",
  type: "agent" as const,
  id: "22222222-2222-4222-8222-222222222222",
  handle: "helper",
};

/** The send path's shape: resolve the mention targets from the candidates, then tokenize once. */
function storedBody(
  body: string,
  targets: readonly MentionTarget[],
  bindings: Parameters<typeof resolveMentionTargets>[2] = [],
) {
  const { handles } = messageReferenceCandidates(body);
  const resolution = resolveMentionTargets(handles, targets, bindings);
  return {
    body: resolveMessageReferences(body, { mention: resolution.target }),
    mentions: resolution.mentions,
  };
}
test("bindings resolve, and a binding that matches no target is ignored", () => {
  const { body, mentions } = storedBody(
    "taking this",
    [ADA, HELPER],
    [
      { type: "agent", id: HELPER.id, name: "helper" },
      { type: "user", id: "99999999-9999-4999-8999-999999999999", name: "ghost" },
    ],
  );
  expect(body).toBe("taking this");
  expect(mentions).toEqual([HELPER]);
});

test("a bound handle's plain-text occurrences are rewritten", () => {
  const { body } = storedBody(
    "@helper take it, @helper?",
    [HELPER],
    [{ type: "agent", id: HELPER.id, name: "helper" }],
  );
  expect(body).toBe(`<@agent:${HELPER.id}> take it, <@agent:${HELPER.id}>?`);
});

test("the Agent wins a handle shared with a User", () => {
  const frankUser = {
    key: "member-frank-user",
    type: "user" as const,
    id: ADA.id,
    handle: "frank",
  };
  const frankAgent = {
    key: "member-frank-agent",
    type: "agent" as const,
    id: HELPER.id,
    handle: "frank",
  };
  const { body, mentions } = storedBody("hey @frank", [frankUser, frankAgent]);
  expect(mentions).toEqual([frankAgent]);
  expect(body).toBe(`hey <@agent:${HELPER.id}>`);
});

// Tasks (the resolution rules the tokenizer carries over unchanged).

test("task candidates are prose references outside code, deduped in first-seen order", () => {
  const body = "pairs with task #68 and task #70, again task #68, and `task #99` in code";
  expect(messageReferenceCandidates(body).taskNumbers).toEqual([68, 70]);
});

test("a longer word before #N is not the words `task #N`", () => {
  expect(
    resolveMessageReferences("mytask #5", {
      task: (number) => (number === 5 ? "task-5" : undefined),
    }),
  ).toBe(`mytask ${taskReferenceToken(5)}`);
  expect(messageReferenceCandidates("task #680").taskNumbers).toEqual([680]);
});

test("the word task is matched case-insensitively", () => {
  expect(messageReferenceCandidates("Task #5").taskNumbers).toEqual([5]);
});

test("only numbers that name a real task are tokenized", () => {
  expect(
    resolveMessageReferences("task #68 and task #999 and task #70", {
      task: (number) => (number === 68 ? "task-68" : number === 70 ? "task-70" : undefined),
    }),
  ).toBe(`${taskReferenceToken(68)} and task #999 and ${taskReferenceToken(70)}`);
});

test("task references inside code spans stay byte-for-byte", () => {
  const source = "see `task #68` and\n```\ntask #68\n```\nand task #68";
  expect(resolveMessageReferences(source, { task: () => "task-id" })).toBe(
    `see \`task #68\` and\n\`\`\`\ntask #68\n\`\`\`\nand ${taskReferenceToken(68)}`,
  );
});
