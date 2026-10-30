import { expect, test } from "bun:test";

import type { ChatListRead } from "#src/features/conversations/chat-list-reads";
import { createChatListReader } from "#src/features/conversations/chat-lists-reader";
import { AppError, isAppErrorCode } from "#src/lib/app-error";

type Results = Awaited<ReturnType<Parameters<typeof createChatListReader>[0]>>;
/** Answers in a fake's own shapes: the reader passes each list's answer through as it is. */
const asResults = (answers: Partial<Record<ChatListRead, unknown>>) => answers as Results;

/** A reader over a fake `loadChatLists` that answers each list with its own name, unless told
 * otherwise, and notes the lists every call named. */
function fakeReader(answer: (lists: ChatListRead[]) => Promise<Results> = answerEach) {
  const calls: ChatListRead[][] = [];
  const read = createChatListReader((lists) => {
    calls.push(lists);
    return answer(lists);
  });
  return { calls, read };
}

async function answerEach(lists: ChatListRead[]): Promise<Results> {
  return asResults(Object.fromEntries(lists.map((list) => [list, { value: list }])));
}

test("lists asked for a few promise turns apart are read in one call, a list asked twice once", async () => {
  const { calls, read } = fakeReader();
  const channels = read("channels");
  await Promise.resolve();
  const saved = read("saved");
  await Promise.resolve().then(() => undefined);
  const again = read("channels");
  const sections = read("sections");

  expect(await Promise.all([channels, saved, again, sections])).toEqual([
    "channels",
    "saved",
    "channels",
    "sections",
  ] as never);
  expect(calls).toEqual([["channels", "saved", "sections"]]);
});

test("a list asked for once the call has gone out goes into the next call", async () => {
  const { calls, read } = fakeReader();
  const first = read("channels");
  await Bun.sleep(1);
  const second = read("channelNames");
  await Promise.all([first, second]);
  expect(calls).toEqual([["channels"], ["channelNames"]]);
});

test("a list that failed rejects alone, with the error its own call would have thrown", async () => {
  const { read } = fakeReader(async () =>
    asResults({
      channels: { value: "channels" },
      directBadges: { error: { code: "ACCESS_DENIED", errorId: "e-1" } },
    }),
  );
  const channels = read("channels");
  const badges = read("directBadges");

  expect(await channels).toBe("channels" as never);
  const error = await badges.catch((cause: unknown) => cause);
  expect(isAppErrorCode(error, "ACCESS_DENIED")).toBe(true);
  expect((error as AppError).errorId).toBe("e-1");
});

test("a call that failed as a whole rejects every list it named", async () => {
  const failure = new AppError("TEMPORARILY_UNAVAILABLE");
  const { read } = fakeReader(() => Promise.reject(failure));
  const results = await Promise.allSettled([read("channels"), read("saved")]);
  expect(results).toEqual([
    { status: "rejected", reason: failure },
    { status: "rejected", reason: failure },
  ]);
});
