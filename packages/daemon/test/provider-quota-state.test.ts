import { describe, expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import {
  ProviderQuotaState,
  QUOTA_STATE_TTL_MS,
  type QuotaPressureTransition,
} from "#src/daemon-runtime/provider-quota-state";
import { formatSideAskStatus } from "#src/agent-runtime/agent-side-ask";

const BASE_MS = Date.parse("2026-11-19T10:00:00.000Z");
const RESETS_IN_2H = new Date(BASE_MS + 2 * 60 * 60 * 1_000).toISOString();
const RESETS_IN_8H = new Date(BASE_MS + 8 * 60 * 60 * 1_000).toISOString();

describe("ProviderQuotaState", () => {
  test("tracks warning -> near_exhausted -> exhausted -> ok transitions per agent and window", () => {
    let now = BASE_MS;
    const transitions: QuotaPressureTransition[] = [];
    const quota = new ProviderQuotaState({
      now: () => now,
      onTransition: (transition) => transitions.push(transition),
    });

    quota.observe("agent-1", {
      provider: RUNTIME_PROVIDER.CLAUDE_CODE,
      primary: {
        status: "ok",
        quotaLevel: "warning",
        usedPercent: 80,
        windowDurationMinutes: 300,
        resetsAt: RESETS_IN_2H,
      },
    });
    expect(quota.summaryForAgent("agent-1")).toEqual({
      provider: RUNTIME_PROVIDER.CLAUDE_CODE,
      window: "primary",
      windowDurationMinutes: 300,
      level: "warning",
      usedPercent: 80,
      resetsAt: RESETS_IN_2H,
      observedAtMs: BASE_MS,
    });

    now += 10_000;
    quota.observe("agent-1", {
      provider: RUNTIME_PROVIDER.CLAUDE_CODE,
      primary: {
        status: "ok",
        usedPercent: 92,
        windowDurationMinutes: 300,
        resetsAt: RESETS_IN_2H,
      },
    });
    expect(quota.summaryForAgent("agent-1")?.level).toBe("near_exhausted");

    now += 10_000;
    quota.observe("agent-1", {
      provider: RUNTIME_PROVIDER.CLAUDE_CODE,
      primary: {
        status: "limit_reached",
        quotaLevel: "exhausted",
        windowDurationMinutes: 300,
        resetsAt: RESETS_IN_2H,
      },
    });
    expect(quota.summaryForAgent("agent-1")?.level).toBe("exhausted");

    now += 10_000;
    quota.observe("agent-1", {
      provider: RUNTIME_PROVIDER.CLAUDE_CODE,
      primary: {
        status: "ok",
        usedPercent: 12,
        windowDurationMinutes: 300,
        resetsAt: RESETS_IN_2H,
      },
    });
    expect(quota.summaryForAgent("agent-1")).toBeUndefined();

    expect(transitions.map((t) => `${t.previousLevel}->${t.level}`)).toEqual([
      "ok->warning",
      "warning->near_exhausted",
      "near_exhausted->exhausted",
      "exhausted->ok",
    ]);
  });

  test("expires entries after resetsAt or 6h TTL and isolates agents", () => {
    let now = BASE_MS;
    const quota = new ProviderQuotaState({ now: () => now });

    quota.observe("agent-a", {
      provider: RUNTIME_PROVIDER.CLAUDE_CODE,
      primary: {
        status: "ok",
        quotaLevel: "warning",
        windowDurationMinutes: 300,
        resetsAt: RESETS_IN_2H,
      },
    });
    quota.observe("agent-b", {
      provider: RUNTIME_PROVIDER.CLAUDE_CODE,
      secondary: {
        status: "ok",
        quotaLevel: "near_exhausted",
        usedPercent: 95,
        windowDurationMinutes: 10_080,
        resetsAt: RESETS_IN_8H,
      },
    });

    now = Date.parse(RESETS_IN_2H) + 1;
    expect(quota.summaryForAgent("agent-a")).toBeUndefined();
    expect(quota.summaryForAgent("agent-b")?.level).toBe("near_exhausted");

    now = BASE_MS + QUOTA_STATE_TTL_MS + 1;
    expect(quota.summaryForAgent("agent-b")).toBeUndefined();
  });

  test("picks highest severity across primary and secondary and clears on forgetAgent", () => {
    const quota = new ProviderQuotaState({ now: () => BASE_MS });
    quota.observe("agent-1", {
      provider: RUNTIME_PROVIDER.CODEX,
      primary: {
        status: "ok",
        usedPercent: 78,
        windowDurationMinutes: 300,
        resetsAt: RESETS_IN_2H,
      },
      secondary: {
        status: "ok",
        usedPercent: 94,
        windowDurationMinutes: 10_080,
        resetsAt: RESETS_IN_8H,
      },
    });
    expect(quota.summaryForAgent("agent-1")).toMatchObject({
      window: "secondary",
      level: "near_exhausted",
      usedPercent: 94,
    });
    quota.forgetAgent("agent-1");
    expect(quota.summaryForAgent("agent-1")).toBeUndefined();
  });

  test("preserves passive observedUsage fallback per provider", () => {
    let now = BASE_MS;
    const quota = new ProviderQuotaState({ now: () => now });
    quota.observe("agent-1", {
      provider: RUNTIME_PROVIDER.CLAUDE_CODE,
      primary: {
        status: "ok",
        quotaLevel: "warning",
        usedPercent: 81,
        windowDurationMinutes: 300,
        resetsAt: RESETS_IN_2H,
      },
    });
    expect(quota.observedUsage(RUNTIME_PROVIDER.CLAUDE_CODE)?.primary).toMatchObject({
      status: "ok",
      quotaLevel: "warning",
      usedPercent: 81,
    });
    now = Date.parse(RESETS_IN_2H) + 1;
    expect(quota.observedUsage(RUNTIME_PROVIDER.CLAUDE_CODE)).toBeUndefined();
  });

  test("scopes summaries by provider, avoids extending TTL on unchanged sibling windows, and breaks severity ties by usedPercent", () => {
    let now = BASE_MS;
    const quota = new ProviderQuotaState({ now: () => now });
    const secondary = {
      status: "ok" as const,
      quotaLevel: "near_exhausted" as const,
      usedPercent: 92,
      windowDurationMinutes: 10_080,
      resetsAt: RESETS_IN_8H,
    };
    quota.observe("agent-1", {
      provider: RUNTIME_PROVIDER.CLAUDE_CODE,
      primary: {
        status: "ok",
        quotaLevel: "near_exhausted",
        usedPercent: 95,
        windowDurationMinutes: 300,
        resetsAt: RESETS_IN_2H,
      },
      secondary,
    });
    expect(quota.summaryForAgent("agent-1", RUNTIME_PROVIDER.CLAUDE_CODE)).toMatchObject({
      window: "primary",
      usedPercent: 95,
    });
    expect(quota.summaryForAgent("agent-1", RUNTIME_PROVIDER.CODEX)).toBeUndefined();

    now = BASE_MS + 4 * 60 * 60 * 1_000;
    quota.observe("agent-1", {
      provider: RUNTIME_PROVIDER.CLAUDE_CODE,
      primary: {
        status: "ok",
        usedPercent: 10,
        windowDurationMinutes: 300,
        resetsAt: RESETS_IN_8H,
      },
      secondary,
    });
    expect(quota.summaryForAgent("agent-1", RUNTIME_PROVIDER.CLAUDE_CODE)?.window).toBe(
      "secondary",
    );

    now = BASE_MS + QUOTA_STATE_TTL_MS + 1;
    expect(quota.summaryForAgent("agent-1", RUNTIME_PROVIDER.CLAUDE_CODE)).toBeUndefined();
  });

  test("formats active quota warning into SideAsk status output", () => {
    const text = formatSideAskStatus({
      runtime: RUNTIME_PROVIDER.CLAUDE_CODE,
      quotaWarning: {
        level: "near_exhausted",
        windowDurationMinutes: 300,
        usedPercent: 93,
        resetsAt: RESETS_IN_2H,
      },
    });
    expect(text).toContain(
      "Quota: near_exhausted (5h window, 93%, resets 2026-11-19T12:00:00.000Z)",
    );
  });
});
