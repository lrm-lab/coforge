import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { ClaudeRateLimitState } from "#src/claude-code/rate-limit";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { claudeEventFeed, claudeFixtureProvider } from "./fixtures/claude-feed";

const NOW_MS = Date.parse("2026-10-20T12:00:00.000Z");
const IN_AN_HOUR_S = NOW_MS / 1000 + 3600;
const IN_AN_HOUR_ISO = "2026-10-20T13:00:00.000Z";
const SESSION = "session-a";
const GENERIC_RATE_LIMIT_TEXT = "API Error: Rate limit reached";

const state = () => new ClaudeRateLimitState(() => NOW_MS);
const rateLimitEvent = (info: Record<string, unknown>) => ({
  type: "rate_limit_event",
  rate_limit_info: info,
});
/** A state that has seen a current rejected event in `SESSION`. */
function rejectedState(): ClaudeRateLimitState {
  const limits = state();
  limits.observe(rateLimitEvent({ status: "rejected", resetsAt: IN_AN_HOUR_S }), SESSION);
  return limits;
}
const failure = (providerErrorCode: string | undefined, message = GENERIC_RATE_LIMIT_TEXT) =>
  ({
    type: "error",
    message,
    ...(providerErrorCode ? { providerErrorCode } : {}),
  }) satisfies AgentRuntimeEvent;
const limitOf = (
  limits: ClaudeRateLimitState,
  code: string | undefined,
  message?: string,
  sessionId = SESSION,
) => limits.annotate(failure(code, message), sessionId).providerLimit;

describe("ClaudeRateLimitState: the limit a Claude error reports", () => {
  test("billing_error is an exhausted quota, whatever was remembered", () => {
    expect(limitOf(state(), "billing_error", "Credit balance too low")).toEqual({
      kind: "quota_exhausted",
    });
  });

  test("rate_limit after a current rejected event is an exhausted quota until its reset", () => {
    expect(limitOf(rejectedState(), "rate_limit")).toEqual({
      kind: "quota_exhausted",
      resetsAt: IN_AN_HOUR_ISO,
    });
  });

  test("a rejected event in milliseconds reads the same reset", () => {
    const limits = state();
    limits.observe(rateLimitEvent({ status: "rejected", resetsAt: IN_AN_HOUR_S * 1000 }), SESSION);
    expect(limitOf(limits, "rate_limit")?.resetsAt).toBe(IN_AN_HOUR_ISO);
  });

  test("a rejected event without a reset is an exhausted quota with no reset time", () => {
    const limits = state();
    limits.observe(rateLimitEvent({ status: "rejected", errorCode: "credits_required" }), SESSION);
    expect(limitOf(limits, "rate_limit")).toStrictEqual({ kind: "quota_exhausted" });
  });

  test("a rejected event whose reset has passed falls back to the error text", () => {
    const limits = state();
    limits.observe(rateLimitEvent({ status: "rejected", resetsAt: NOW_MS / 1000 - 1 }), SESSION);
    expect(limitOf(limits, "rate_limit")).toEqual({ kind: "transient_rate_limit" });
    expect(limitOf(limits, "rate_limit", "You've hit your session limit · resets 3:45pm")).toEqual({
      kind: "quota_exhausted",
    });
  });

  test.each([
    "You've hit your session limit · resets 3:45pm",
    "You’ve hit your weekly limit",
    "Hit your weekly limit",
    "You have reached your usage limit for this week.",
    "you've REACHED your Opus limit",
    "You're out of usage credits",
    "You've hit your monthly spend limit",
    "You've hit your organization's budget",
    "You've used your included Max usage",
    "You've reached your organization's monthly extra-usage spend limit",
  ])("rate_limit with no remembered event reads %p as an exhausted quota", (message) => {
    expect(limitOf(state(), "rate_limit", message)).toEqual({ kind: "quota_exhausted" });
  });

  test.each([
    GENERIC_RATE_LIMIT_TEXT,
    "API Error: 429 Too Many Requests",
    "You've hit your stride. The limit is far away.",
    `You've reached your ${"very ".repeat(12)}limit`,
    "Rate limited: try again in a few seconds",
    "You’re out of extra usage · add credits to keep going",
  ])("rate_limit with no remembered event reads %p as a transient rate limit", (message) => {
    expect(limitOf(state(), "rate_limit", message)).toEqual({ kind: "transient_rate_limit" });
  });

  test.each(["allowed", "allowed_warning"])(
    "a later %s event replaces a remembered rejected one",
    (status) => {
      const limits = rejectedState();
      limits.observe(rateLimitEvent({ status, resetsAt: IN_AN_HOUR_S }), SESSION);
      expect(limitOf(limits, "rate_limit")).toEqual({ kind: "transient_rate_limit" });
    },
  );

  test.each([{}, { status: "" }, { status: 1 }, { resetsAt: IN_AN_HOUR_S }])(
    "an event without a status (%p) leaves a remembered rejected one in place",
    (info) => {
      const limits = rejectedState();
      limits.observe(rateLimitEvent(info), SESSION);
      expect(limitOf(limits, "rate_limit")).toEqual({
        kind: "quota_exhausted",
        resetsAt: IN_AN_HOUR_ISO,
      });
    },
  );

  test("a rejected event remembered for another session is forgotten", () => {
    expect(limitOf(rejectedState(), "rate_limit", undefined, "session-b")).toEqual({
      kind: "transient_rate_limit",
    });
  });

  test.each(["server_error", "overloaded", "authentication_failed"])(
    "%s reports no limit, and the event is passed on unchanged",
    (code) => {
      const event = failure(code, "You've hit your session limit");
      expect(rejectedState().annotate(event, SESSION)).toEqual(event);
    },
  );

  test("an error without a Claude error code reports no limit", () => {
    expect(limitOf(rejectedState(), undefined, "You've hit your session limit")).toBeUndefined();
  });
});

describe("ClaudeRateLimitState: usage windows", () => {
  test("each windowed event updates the cumulative snapshot; others leave it alone", () => {
    const limits = state();
    expect(
      limits.observe(
        rateLimitEvent({ status: "allowed", rateLimitType: "five_hour", resetsAt: IN_AN_HOUR_S }),
        SESSION,
      ),
    ).toEqual({
      provider: "claude-code",
      primary: { status: "ok", windowDurationMinutes: 300, resetsAt: IN_AN_HOUR_ISO },
    });
    expect(
      limits.observe(
        rateLimitEvent({ status: "rejected", rateLimitType: "seven_day", resetsAt: IN_AN_HOUR_S }),
        SESSION,
      ),
    ).toEqual({
      provider: "claude-code",
      primary: { status: "ok", windowDurationMinutes: 300, resetsAt: IN_AN_HOUR_ISO },
      secondary: {
        status: "limit_reached",
        windowDurationMinutes: 10_080,
        resetsAt: IN_AN_HOUR_ISO,
      },
    });
    for (const info of [
      { status: "allowed_warning", rateLimitType: "five_hour", resetsAt: IN_AN_HOUR_S },
      { status: "rejected", rateLimitType: "overage", resetsAt: IN_AN_HOUR_S },
      { status: "rejected", rateLimitType: "five_hour" },
    ])
      expect(limits.observe(rateLimitEvent(info), SESSION)).toBeUndefined();
  });
});

test("a Claude usage limit reaches the session as an exhausted quota with its reset", async () => {
  const feed = claudeEventFeed();
  const session = await claudeFixtureProvider().createAgentSession({
    agentWorkspaceDirectory: tmpdir(),
    instructions: "Test Agent instructions.",
    environment: feed.environment,
  });
  feed.attach(session);
  await feed.sessionId();
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => {
    if (event.type === "error" || event.type === "completed") events.push(event);
  });
  const message = "You've hit your session limit · resets 3:45pm";
  try {
    await session.sendMessage("wait");
    // A usage limit as Claude Code reports it: the rejected rate-limit event, the synthetic
    // assistant error record, then the failed result.
    await feed.emit(
      rateLimitEvent({ status: "rejected", rateLimitType: "five_hour", resetsAt: 4_102_444_800 }),
      {
        type: "assistant",
        error: "rate_limit",
        message: { content: [{ type: "text", text: message }] },
      },
      { type: "result", subtype: "success", is_error: true, result: message, errors: [] },
    );
    expect(events).toEqual([
      {
        type: "error",
        message,
        providerErrorCode: "rate_limit",
        providerLimit: { kind: "quota_exhausted", resetsAt: "2100-01-01T00:00:00.000Z" },
        occurredAt: expect.any(String),
      },
      { type: "completed", status: "failed" },
    ]);
  } finally {
    await session.dispose();
    feed.stop();
  }
});
