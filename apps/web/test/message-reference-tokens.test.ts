import { expect, test } from "bun:test";

import {
  patternAlternation,
  rehypeReferenceChips,
} from "#src/features/conversations/message-markdown";
import { CHANNEL_CHIP_CLASS } from "#src/features/conversations/message-reference-chips";
import { escapeLiteralHtml } from "#src/lib/message-syntax";

function text(value: string) {
  return { type: "text", value };
}

function paragraph(children: unknown[]) {
  return { type: "element", tagName: "p", properties: {}, children };
}

const CHANNEL_ID = "33333333-3333-4333-8333-333333333333";
const CHANNEL_TOKEN = `<@channel:${CHANNEL_ID}:product>`;

function channelChipify(children: unknown[], currentNames?: ReadonlyMap<string, string>) {
  const tree = { type: "root", children } as never;
  rehypeReferenceChips({ mentions: new Map(), channelNames: currentNames })(tree);
  return tree as { children: Array<{ children: Array<Record<string, unknown>> }> };
}

test("a channel token keeps its angle brackets through the HTML escape", () => {
  expect(escapeLiteralHtml(`see ${CHANNEL_TOKEN} now`)).toBe(`see ${CHANNEL_TOKEN} now`);
});

test("a channel token becomes a chip carrying the channel id and its current name", () => {
  const tree = channelChipify(
    [paragraph([text(`see ${CHANNEL_TOKEN} now`)])],
    new Map([[CHANNEL_ID, "launch"]]),
  );
  const [before, chip, after] = tree.children[0]!.children;
  expect(before).toEqual(text("see "));
  expect(chip).toMatchObject({
    tagName: "span",
    properties: { className: CHANNEL_CHIP_CLASS.split(" "), "data-channel-id": CHANNEL_ID },
    children: [text("#launch")],
  });
  expect(after).toEqual(text(" now"));
});

test("a channel token whose id the Workspace does not have reads as plain #name, with no link", () => {
  // A token is a claim, checked against the Workspace's channels (closed ones included): an unknown
  // or forged id gets no chip and no link, only the name as text — what typing `#name` gives.
  const tree = channelChipify([paragraph([text(CHANNEL_TOKEN)])], new Map());
  expect(tree.children[0]!.children).toEqual([text("#product")]);
});

test("without a place to navigate from, a channel token reads as plain #name", () => {
  const tree = channelChipify([paragraph([text(`see ${CHANNEL_TOKEN}`)])]);
  expect(tree.children[0]!.children).toEqual([text("see "), text("#product")]);
});

test("a channel token inside a link reads as plain #name, never a link in a link", () => {
  const tree = channelChipify(
    [
      paragraph([
        {
          type: "element",
          tagName: "a",
          properties: { href: "/x" },
          children: [text(CHANNEL_TOKEN)],
        },
      ]),
    ],
    new Map(),
  );
  const link = tree.children[0]!.children[0]!;
  expect(link.children).toEqual([text("#product")]);
});

test("a channel token inside code, and a plain #name anywhere, stay as written", () => {
  const tree = channelChipify(
    [
      paragraph([
        { type: "element", tagName: "code", properties: {}, children: [text(CHANNEL_TOKEN)] },
        text(" and #product"),
      ]),
    ],
    new Map([[CHANNEL_ID, "product"]]),
  );
  const [code, prose] = tree.children[0]!.children;
  expect(code!.children).toEqual([text(CHANNEL_TOKEN)]);
  expect(prose).toEqual(text(" and #product"));
});

test("an alternation reads each match as its own pattern's groups, a `u` pattern included", () => {
  const { pattern, read } = patternAlternation([
    /<@x:(\d+)>/gi,
    /(?<![\p{L}])@(\p{L}+)/gu,
    /#([a-z]+)-(\d+)/g,
  ]);
  const reads = [..."ask @élodie about <@X:5> and #plan-2".matchAll(pattern)].map(read);
  expect(reads).toEqual([
    { index: 1, groups: ["élodie"] },
    { index: 0, groups: ["5"] },
    { index: 2, groups: ["plan", "2"] },
  ]);
});

const TASK_CONVERSATION = "44444444-4444-4444-8444-444444444444";

function taskPass(children: unknown[]) {
  const tree = { type: "root", children } as never;
  rehypeReferenceChips({ mentions: new Map() })(tree);
  return tree as { children: Array<{ children: Array<Record<string, unknown>> }> };
}

test("another conversation's task token carries its conversation and reads as the sender wrote it", () => {
  const tree = taskPass([
    paragraph([
      text(
        `see <@task:c:${TASK_CONVERSATION}:design:7> and <@task:d:${TASK_CONVERSATION}:ada~agent:9>`,
      ),
    ]),
  ]);
  expect(tree.children[0]!.children).toEqual([
    text("see "),
    {
      type: "element",
      tagName: "span",
      properties: {
        "data-task-reference-number": 7,
        "data-task-reference-conversation-id": TASK_CONVERSATION,
        "data-task-reference-kind": "channel",
      },
      children: [text("#design:#7")],
    },
    text(" and "),
    {
      type: "element",
      tagName: "span",
      properties: {
        "data-task-reference-number": 9,
        "data-task-reference-conversation-id": TASK_CONVERSATION,
        "data-task-reference-kind": "dm",
      },
      children: [text("dm:@ada~agent:#9")],
    },
  ]);
});

test("another conversation's task token inside a link or code is its words", () => {
  const tree = taskPass([
    paragraph([
      {
        type: "element",
        tagName: "a",
        properties: { href: "/x" },
        children: [text(`<@task:c:${TASK_CONVERSATION}:design:7>`)],
      },
      {
        type: "element",
        tagName: "code",
        properties: {},
        children: [text(`<@task:d:${TASK_CONVERSATION}:ada:9>`)],
      },
    ]),
  ]);
  const [link, code] = tree.children[0]!.children as Array<{ children: unknown[] }>;
  expect(link!.children).toEqual([text("#design:#7")]);
  expect(code!.children).toEqual([text(`<@task:d:${TASK_CONVERSATION}:ada:9>`)]);
});

test("a typed #channel:#N names a listed channel's Task, an unlisted one stays as written", () => {
  const tree = channelChipify(
    [paragraph([text("see #Launch:#7 and #secret:#2 now")])],
    new Map([[CHANNEL_ID, "launch"]]),
  );
  const [before, reference, after] = tree.children[0]!.children;
  expect(before).toEqual(text("see "));
  expect(reference).toMatchObject({
    tagName: "span",
    properties: {
      "data-task-reference-number": 7,
      "data-task-reference-conversation-id": CHANNEL_ID,
      "data-task-reference-kind": "channel",
    },
  });
  expect(after).toEqual(text(" and #secret:#2 now"));
});

test("a typed dm:@peer:#N is one reference: its @peer is no mention of its own", () => {
  const tree = { type: "root", children: [paragraph([text("ask dm:@ada:#3 first")])] } as never;
  const ada = { actorId: "ada-id", handle: "ada", label: "Ada", agentId: "ada-id" };
  rehypeReferenceChips({ mentions: new Map(), plainMentions: new Map([["ada", ada]]) })(tree);
  const [before, reference, after] = (
    tree as { children: Array<{ children: Array<Record<string, unknown>> }> }
  ).children[0]!.children;
  expect(before).toEqual(text("ask "));
  expect(reference).toMatchObject({
    properties: {
      "data-task-reference-number": 3,
      "data-task-reference-kind": "dm",
      "data-task-reference-peer": "ada",
    },
    children: [text("dm:@ada:#3")],
  });
  expect(after).toEqual(text(" first"));
});
