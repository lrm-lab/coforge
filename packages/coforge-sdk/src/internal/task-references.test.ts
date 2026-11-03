import { expect, test } from "bun:test";
import { canonicalTaskReference, readableBody } from "./readable-body";
import {
  channelTaskReferenceToken,
  dmTaskReferenceToken,
  replaceTaskReferenceTokens,
  taskReferenceToken,
  type TaskReference,
} from "./task-references";

const conversation = "01a19d18-791a-70dc-9961-37f663f63aa1";

test("every task token shape reads back as its reference", () => {
  const body = [
    taskReferenceToken(68),
    channelTaskReferenceToken(conversation, "design", 7),
    dmTaskReferenceToken(conversation, "ada", 9),
  ].join(" ");
  expect(readableBody(body, { mention: () => undefined })).toBe("task #68 #design:#7 dm:@ada:#9");
  expect(
    replaceTaskReferenceTokens(body, (reference) =>
      reference.kind === "local" ? `task #${reference.number}` : undefined,
    ),
  ).toBe(
    `task #68 ${channelTaskReferenceToken(conversation, "design", 7)} ${dmTaskReferenceToken(conversation, "ada", 9)}`,
  );
});

test("a reader can rewrite a direct message's task from its own seat", () => {
  const reference: TaskReference = {
    kind: "dm",
    conversationId: conversation,
    peerHandle: "ada",
    number: 9,
  };
  expect(
    readableBody(dmTaskReferenceToken(conversation, "ada", 9), {
      mention: () => undefined,
      task: (read) =>
        read.kind === "dm" && read.conversationId === conversation
          ? `dm:@sender:#${read.number}`
          : undefined,
    }),
  ).toBe("dm:@sender:#9");
  expect(canonicalTaskReference(reference)).toBe("dm:@ada:#9");
});

test("a typed token is read like its text, and a malformed one stays written", () => {
  const body = "<@task:c:not-a-uuid:design:7> <@task:0> <@task:68>";
  expect(readableBody(body, { mention: () => undefined })).toBe(
    "<@task:c:not-a-uuid:design:7> task #0 task #68",
  );
});
