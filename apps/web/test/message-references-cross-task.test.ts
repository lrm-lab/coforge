import { expect, test } from "bun:test";
import { replaceTaskReferenceTokens, taskReferenceToken } from "@lrm/coforge-sdk/internal";
import { readMessageReferences } from "#src/lib/message-references";

const resolveMessageReferences = readMessageReferences;

test("replaceTaskReferenceTokens round-trips a stored task token", () => {
  const body = resolveMessageReferences("refer to task #7").resolve({ task: () => true });
  expect(
    replaceTaskReferenceTokens(body, (reference) =>
      reference.kind === "local" ? `task #${reference.number}` : undefined,
    ),
  ).toBe("refer to task #7");
  expect(body).toBe(`refer to ${taskReferenceToken(7)}`);
});

test("cross-conversation task references resolve only when the sender may read them", () => {
  const conversation = "01a19d18-791a-70dc-9961-37f663f63aa1";
  const body = "see #design:#7 and dm:@ada:#9, but not #design:#7x";
  const references = readMessageReferences(body);
  expect(references.candidates.channelTasks).toEqual([{ name: "design", number: 7 }]);
  expect(references.candidates.dmTasks).toEqual([{ peer: "ada", number: 9 }]);
  expect(
    references.resolve({
      channelTask: (name, number) =>
        name === "design" && number === 7
          ? { conversationId: conversation, channelName: "design" }
          : undefined,
      dmTask: () => undefined,
    }),
  ).toBe(`see <@task:c:${conversation}:design:7> and dm:@ada:#9, but not #design:#7x`);
  // Unresolvable whole references stay as written, inner numbers included.
  expect(
    readMessageReferences("#design:#7 and dm:@ada:#9").resolve({
      channelTask: () => undefined,
      dmTask: () => undefined,
      task: () => true,
    }),
  ).toBe("#design:#7 and dm:@ada:#9");
  // A space ends the reference: `#7` after it is this conversation's task.
  expect(readMessageReferences("#design: #7").resolve({ task: () => true })).toBe(
    "#design: <@task:7>",
  );
});

test("cross references in inline and fenced code are never references", () => {
  const conversation = "01a19d18-791a-70dc-9961-37f663f63aa1";
  const body = [
    "inline `#design:#7` and `dm:@ada:#9` and `#12`",
    "```",
    "#design:#7",
    "dm:@ada:#9",
    "#12",
    "```",
    "then #design:#7",
  ].join("\n");
  const references = readMessageReferences(body);
  expect(references.candidates.channelTasks).toEqual([{ name: "design", number: 7 }]);
  expect(references.candidates.dmTasks).toEqual([]);
  expect(references.candidates.taskNumbers).toEqual([]);
  expect(
    references.resolve({
      channelTask: () => ({ conversationId: conversation, channelName: "design" }),
      dmTask: () => ({ conversationId: conversation, peerHandle: "ada" }),
      task: () => true,
    }),
  ).toBe(body.replace("then #design:#7", `then <@task:c:${conversation}:design:7>`));
});
