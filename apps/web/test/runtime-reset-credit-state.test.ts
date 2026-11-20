import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import {
  RESET_CREDIT_HIGH_USAGE_PERCENT,
  canOfferAgentResetCredit,
  resetCreditPrompt,
} from "#src/features/computers/runtime-reset-credit-state";
import type { UsageSnapshot } from "#src/server/centrifugo/usage-cache.server";

const codexSnapshot = (overrides: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  provider: RUNTIME_PROVIDER.CODEX,
  health: "ok",
  resetCreditsAvailable: 2,
  ...overrides,
});

test("resetCreditPrompt hides the button when no reset credit is available or provider is not Codex", () => {
  expect(resetCreditPrompt(undefined)).toBeUndefined();
  expect(
    resetCreditPrompt(
      codexSnapshot({
        resetCreditsAvailable: undefined,
        health: "rate_limited",
      }),
    ),
  ).toBeUndefined();
  expect(
    resetCreditPrompt(
      codexSnapshot({
        resetCreditsAvailable: 0,
        health: "rate_limited",
      }),
    ),
  ).toBeUndefined();
  expect(
    resetCreditPrompt({
      provider: RUNTIME_PROVIDER.CLAUDE_CODE,
      health: "rate_limited",
      resetCreditsAvailable: 2,
    }),
  ).toBeUndefined();
});

test("resetCreditPrompt hides the button while every reported window is below 80% used", () => {
  expect(RESET_CREDIT_HIGH_USAGE_PERCENT).toBe(80);
  expect(
    resetCreditPrompt(
      codexSnapshot({
        primary: { usedPercent: 0, status: "ok", windowDurationMinutes: 10_080 },
      }),
    ),
  ).toBeUndefined();
  expect(
    resetCreditPrompt(
      codexSnapshot({
        primary: { usedPercent: 79, status: "ok", windowDurationMinutes: 300 },
        officialGroups: [
          {
            name: "Codex",
            buckets: [{ window: "secondary", remainingFraction: 0.21, status: "ok" }],
          },
        ],
      }),
    ),
  ).toBeUndefined();
});

test("resetCreditPrompt returns secondary at or above 80% used, including funded 100% windows", () => {
  expect(
    resetCreditPrompt(
      codexSnapshot({
        primary: { usedPercent: 80, status: "ok", windowDurationMinutes: 10_080 },
      }),
    ),
  ).toEqual({
    available: 2,
    variant: "secondary",
  });

  expect(
    resetCreditPrompt(
      codexSnapshot({
        officialGroups: [
          {
            name: "Codex",
            buckets: [{ window: "primary", remainingFraction: 0.2, status: "ok" }],
          },
        ],
      }),
    ),
  ).toEqual({
    available: 2,
    variant: "secondary",
  });

  expect(
    resetCreditPrompt(
      codexSnapshot({
        health: "ok",
        credits: { hasCredits: true, unlimited: false, balance: "12.50" },
        primary: { usedPercent: 100, status: "ok", windowDurationMinutes: 10_080 },
      }),
    ),
  ).toEqual({
    available: 2,
    variant: "secondary",
  });
});

test("resetCreditPrompt returns primary on rate_limited or limit_reached, including depleted or hard-limited accounts", () => {
  expect(
    resetCreditPrompt(
      codexSnapshot({
        health: "rate_limited",
        primary: { usedPercent: 100, status: "limit_reached", windowDurationMinutes: 10_080 },
      }),
    ),
  ).toEqual({
    available: 2,
    variant: "primary",
  });

  expect(
    resetCreditPrompt(
      codexSnapshot({
        health: "ok",
        officialGroups: [
          {
            name: "Codex",
            buckets: [{ window: "primary", usedPercent: 100, status: "limit_reached" }],
          },
        ],
      }),
    ),
  ).toEqual({
    available: 2,
    variant: "primary",
  });

  expect(
    resetCreditPrompt(
      codexSnapshot({
        health: "rate_limited",
        credits: { hasCredits: true, unlimited: false, balance: "0.00" },
        primary: { usedPercent: 100, status: "limit_reached", windowDurationMinutes: 10_080 },
      }),
    ),
  ).toEqual({
    available: 2,
    variant: "primary",
  });

  expect(
    resetCreditPrompt(
      codexSnapshot({
        health: "rate_limited",
        credits: { hasCredits: true, unlimited: false, balance: "12.50" },
        primary: { usedPercent: 100, status: "limit_reached", windowDurationMinutes: 300 },
      }),
    ),
  ).toEqual({
    available: 2,
    variant: "primary",
  });
});

test("canOfferAgentResetCredit allows reset only when usage is visible and no per-Agent credential overrides it", () => {
  expect(canOfferAgentResetCredit({ runtimeUsageVisible: true, runtimeCredential: null })).toBe(
    true,
  );
  expect(
    canOfferAgentResetCredit({ runtimeUsageVisible: true, runtimeCredential: undefined }),
  ).toBe(true);
  expect(canOfferAgentResetCredit({ runtimeUsageVisible: false, runtimeCredential: null })).toBe(
    false,
  );
  expect(
    canOfferAgentResetCredit({
      runtimeUsageVisible: true,
      runtimeCredential: { provider: RUNTIME_PROVIDER.CODEX },
    }),
  ).toBe(false);
});

test("RuntimeUsage owns reset credit action and dialog for both Computer and Agent pages while keeping Agent context", async () => {
  const [runtimeUsage, popoverContent, computerRuntimes, agentProfileTab] = await Promise.all([
    Bun.file(
      new URL("../src/features/computers/runtime-usage.tsx", import.meta.url).pathname,
    ).text(),
    Bun.file(
      new URL("../src/features/computers/runtime-usage-popover-content.tsx", import.meta.url)
        .pathname,
    ).text(),
    Bun.file(
      new URL("../src/features/computers/computer-runtimes.tsx", import.meta.url).pathname,
    ).text(),
    Bun.file(
      new URL("../src/features/agents/profile-panel/agent-profile-tab.tsx", import.meta.url)
        .pathname,
    ).text(),
  ]);

  expect(popoverContent).toContain("RuntimeResetCreditAction");
  expect(runtimeUsage).toContain("RuntimeResetCreditDialog");
  expect(computerRuntimes).toContain("canResetCredit=");
  expect(computerRuntimes).not.toContain("RuntimeResetCreditDialog");
  expect(computerRuntimes).not.toContain("RuntimeResetCreditButton");
  expect(agentProfileTab).toContain("canResetCredit={canOfferAgentResetCredit(profile)}");
  expect(agentProfileTab).toContain("<AgentContextSection");
});
