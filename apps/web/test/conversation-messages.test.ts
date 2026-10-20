import { describe, expect, test } from "bun:test";

import { mergeMessages } from "#src/features/conversations/conversation-messages";

const thumbs = [{ emoji: "👍", count: 1, reactors: [{ id: "user-jordan", label: "Jordan Lee" }] }];
const party = [{ emoji: "🎉", count: 1, reactors: [{ id: "user-casey", label: "Casey Morgan" }] }];

type Message = {
  id: string;
  sequence: number;
  body: string;
  reactions?: typeof thumbs;
  reactionVersion?: number;
};

describe("mergeMessages", () => {
  test("orders by sequence, the incoming copy winning", () => {
    const merged = mergeMessages(
      [
        { id: "m2", sequence: 2, body: "old" },
        { id: "m1", sequence: 1, body: "one" },
      ],
      [{ id: "m2", sequence: 2, body: "new" }],
    );
    expect(merged).toEqual([
      { id: "m1", sequence: 1, body: "one" },
      { id: "m2", sequence: 2, body: "new" },
    ]);
  });

  test("a re-read older than the reactions shown keeps them, and takes everything else", () => {
    const shown: Message = {
      id: "m1",
      sequence: 1,
      body: "old",
      reactions: party,
      reactionVersion: 3,
    };
    const reread: Message = {
      id: "m1",
      sequence: 1,
      body: "edited",
      reactions: thumbs,
      reactionVersion: 2,
    };
    expect(mergeMessages([shown], [reread])).toEqual([
      { id: "m1", sequence: 1, body: "edited", reactions: party, reactionVersion: 3 },
    ]);
  });

  test("at the same version the shown reactions stay: they also hold the viewer's pending clicks", () => {
    const pending = [
      ...thumbs,
      { emoji: "🎉", count: 1, reactors: [{ id: "user-dev", label: "Dev" }] },
    ];
    const shown: Message = {
      id: "m1",
      sequence: 1,
      body: "a",
      reactions: pending,
      reactionVersion: 2,
    };
    const reread: Message = {
      id: "m1",
      sequence: 1,
      body: "a",
      reactions: thumbs,
      reactionVersion: 2,
    };
    expect(mergeMessages([shown], [reread])[0]!.reactions).toEqual(pending);
  });

  test("a newer re-read wins", () => {
    const shown: Message = {
      id: "m1",
      sequence: 1,
      body: "a",
      reactions: thumbs,
      reactionVersion: 2,
    };
    expect(
      mergeMessages([shown], [{ id: "m1", sequence: 1, body: "a", reactionVersion: 3 }])[0],
    ).toEqual({ id: "m1", sequence: 1, body: "a", reactionVersion: 3 });
  });

  test("a send's echo, which carries no version, keeps the reactions shown", () => {
    const shown: Message = {
      id: "m1",
      sequence: 1,
      body: "a",
      reactions: thumbs,
      reactionVersion: 2,
    };
    expect(mergeMessages([shown], [{ id: "m1", sequence: 1, body: "b" }])[0]).toEqual({
      id: "m1",
      sequence: 1,
      body: "b",
      reactions: thumbs,
      reactionVersion: 2,
    });
  });

  test("a copy shown without a version is replaced as it is", () => {
    const shown: Message = { id: "m1", sequence: 1, body: "a", reactions: thumbs };
    expect(mergeMessages([shown], [{ id: "m1", sequence: 1, body: "b" }])[0]).toEqual({
      id: "m1",
      sequence: 1,
      body: "b",
    });
  });
});
