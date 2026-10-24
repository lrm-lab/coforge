import { expect, test } from "bun:test";
import type { AgentMentionPendingResponse } from "@lrm/coforge-sdk/agent";
import { parseArgs, run } from "../index";
import { CliError } from "#src/cli-error";

const ROW = {
  resolutionId: "22222222-2222-4222-8222-222222222222",
  messageId: "11111111-1111-4111-8111-111111111111",
  targetType: "user" as const,
  targetHandle: "bob",
  targetAvatarUrl: null,
  reason: "not_member" as const,
  availableActions: [] as string[],
  expiresAt: "2026-10-01T00:00:00.000Z",
  channelName: "triage",
};

const transport = (
  response: Partial<AgentMentionPendingResponse> = {},
  limits: Array<number | undefined> = [],
) => ({
  check: async () => ({ messages: [] }),
  read: async () => undefined,
  send: async () => undefined,
  view: async () => ({ bytes: new Uint8Array() }),
  mentionPending: async (limit?: number) => {
    limits.push(limit);
    return { ok: true as const, pendingMentionActions: [], ...response };
  },
});

const refusal = (args: string[]): CliError => {
  try {
    parseArgs(["mention", "pending", ...args]);
  } catch (error) {
    return error as CliError;
  }
  throw new Error("expected a refusal");
};

test("pending takes an optional --limit from 1 to 100", () => {
  expect(parseArgs(["mention", "pending", "--limit", "5", "--json"])).toEqual({
    command: "mention-pending",
    json: true,
    limit: 5,
  });
  expect(refusal(["--limit", "0"]).message).toBe("--limit must be a positive integer; got 0");
  expect(refusal(["--limit", "x"]).code).toBe("INVALID_ARG");
  expect(refusal(["--limit", "101"]).message).toContain("--limit must be at most 100");
  expect(refusal(["--limit"]).message).toContain("Usage: coforge mention pending");
});

test("a complete page says so, whatever the limit was", async () => {
  const limits: Array<number | undefined> = [];
  const output = await run(
    ["mention", "pending", "--limit", "10"],
    transport({ pendingMentionActions: [ROW], hasMore: false }, limits),
  );
  expect(limits).toEqual([10]);
  expect(output).toBe(
    [
      "Pending mention actions",
      "(shown 1, --limit 10 — truncated=false · this is the complete list)",
      "",
      "- 22222222-2222-4222-8222-222222222222 — bob (user)",
      "  message: 11111111-1111-4111-8111-111111111111",
      "  reason: not in the conversation at send time, so the @mention was not delivered",
      "  expires: 2026-10-01T00:00:00.000Z",
    ].join("\n"),
  );
});

test("a page with more behind it says how to reach the rest", async () => {
  const more = transport({ pendingMentionActions: [ROW], hasMore: true });
  expect(await run(["mention", "pending"], more)).toContain(
    "(shown 1, server default 50 — truncated=true · more pending actions exist; raise --limit (server caps at 100) or resolve these first and re-run)",
  );
  expect(await run(["mention", "pending", "--limit", "100"], more)).toContain(
    "truncated=true · more pending actions exist AND this is the server's maximum page (100); this route has no offset or cursor",
  );
});

test("a server that does not report hasMore leaves completeness unasserted", async () => {
  expect(await run(["mention", "pending"], transport({ pendingMentionActions: [ROW] }))).toContain(
    "truncated=unknown · server did not report hasMore, so completeness is NOT asserted",
  );
});

test("recovery commands are listed for the actions a pending mention still allows", async () => {
  const output = await run(
    ["mention", "pending"],
    transport({
      pendingMentionActions: [{ ...ROW, targetType: "agent", availableActions: ["notify", "add"] }],
      hasMore: false,
    }),
  );
  expect(output).toContain(
    [
      "  recovery commands:",
      "  notify: coforge mention notify 22222222-2222-4222-8222-222222222222",
      "  add: coforge mention add 22222222-2222-4222-8222-222222222222",
      "  note: notify exits nonzero unless the target queue accepts the delivery.",
    ].join("\n"),
  );
});

test("nothing pending still says how complete that answer is, and --json carries truncated and limit", async () => {
  const none = transport({ hasMore: false });
  expect(await run(["mention", "pending"], none)).toBe(
    "Pending mention actions\n\nNo pending mention actions. (shown 0, server default 50 — truncated=false · this is the complete list)",
  );
  expect(await run(["mention", "pending", "--json", "--limit", "7"], none)).toEqual({
    ok: true,
    pendingMentionActions: [],
    truncated: false,
    noLongerActionable: null,
    limit: 7,
  });
  expect(await run(["mention", "pending", "--json"], transport())).toEqual({
    ok: true,
    pendingMentionActions: [],
    truncated: null,
    noLongerActionable: null,
    limit: null,
  });
});

test("pending mentions that can no longer be acted on are counted after the page, in text and --json", async () => {
  const counted = transport({
    pendingMentionActions: [ROW],
    hasMore: false,
    noLongerActionable: 3,
  });
  const output = (await run(["mention", "pending"], counted)) as string;
  expect(
    output.endsWith("\n\n3 pending mentions can no longer be acted on; they expire on their own."),
  ).toBe(true);
  expect(
    await run(["mention", "pending"], transport({ hasMore: false, noLongerActionable: 1 })),
  ).toBe(
    "Pending mention actions\n\nNo pending mention actions. (shown 0, server default 50 — truncated=false · this is the complete list)\n\n1 pending mention can no longer be acted on; it expires on its own.",
  );
  expect(await run(["mention", "pending", "--json"], counted)).toMatchObject({
    noLongerActionable: 3,
  });
});
