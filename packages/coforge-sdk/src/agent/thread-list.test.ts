import { expect, test } from "bun:test";
import { decodeAgentThreadListResponse } from "./thread-list";

const THREAD = {
  target: "#general:01a16c6c-1c04",
  parentChannel: "#general",
  rootMessageId: "01a16c6c-1c04-77cc-ac0d-1ec28453613a",
  followedAt: "2026-10-24T17:00:00.000Z",
};

test("decodes the followed threads", () => {
  expect(decodeAgentThreadListResponse({ ok: true, threads: [THREAD] })).toEqual({
    ok: true,
    threads: [THREAD],
  });
  expect(decodeAgentThreadListResponse({ ok: true, threads: [] })).toEqual({
    ok: true,
    threads: [],
  });
});

test("refuses a response that is not a list of followed threads", () => {
  for (const value of [
    undefined,
    { ok: false, threads: [] },
    { ok: true },
    { ok: true, threads: [{ ...THREAD, followedAt: 5 }] },
    { ok: true, threads: [{ target: "#a:b" }] },
  ])
    expect(() => decodeAgentThreadListResponse(value)).toThrow("invalid Agent thread list");
});
