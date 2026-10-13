import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

import { RuntimeUsagePopoverContent } from "#src/features/computers/runtime-usage";
import { usageWindowLabel } from "#src/features/computers/runtime-usage-windows";
import type { UsageReadResult } from "#src/server/centrifugo/usage-cache.server";

function kiroUsage(creditUsage: { used: number; limit: number; overage: number }): UsageReadResult {
  return {
    state: "fresh",
    result: {
      workspaceId: "workspace-1",
      computerId: "computer-1",
      provider: RUNTIME_PROVIDER.KIRO,
      scanId: "scan-1",
      status: "available",
      collectedAt: new Date().toISOString(),
      snapshot: {
        provider: RUNTIME_PROVIDER.KIRO,
        planType: "KIRO POWER",
        primary: {
          usedPercent: Math.round((creditUsage.used / creditUsage.limit) * 10_000) / 100,
          status: "ok",
          windowDurationMinutes: 43_200,
        },
        creditUsage,
      },
    },
  };
}

function render(data: UsageReadResult) {
  return renderToStaticMarkup(
    <RuntimeUsagePopoverContent
      runtime={{ provider: RUNTIME_PROVIDER.KIRO, displayName: "Kiro", version: "2.22.0" }}
      data={data}
      scanning={false}
      computerOnline
      onRefresh={() => {}}
    />,
  );
}

test("a credit plan's header line is the label and its percentage; the amounts sit under the bar", () => {
  const html = render(kiroUsage({ used: 7517.29, limit: 10_000, overage: 0 }));
  const header = html.indexOf("Monthly credits");
  // 75.17% reads as a whole percentage; the exact amounts are under the bar.
  const percent = html.indexOf("75%");
  const bar = html.indexOf('role="progressbar"');
  const amounts = html.indexOf("7,517.29 / 10,000 credits used");
  expect(header).toBeGreaterThan(-1);
  expect(percent).toBeGreaterThan(header);
  expect(bar).toBeGreaterThan(percent);
  expect(amounts).toBeGreaterThan(bar);
  // The bar is named by its window for screen readers.
  expect(html).toContain('role="group" aria-label="Monthly credits"');
});

test("a running scan never disables the refresh button, so its focus stays in the popover", () => {
  // The pointer that asked for the refresh is parked on the button; a disabled state drops the
  // focus out of the popover (which reads as an outside-interaction close, task #116). The
  // refresh runs as React Aria's isPending: presses ignored, focus kept, spinner shown; the
  // label names the running scan.
  const html = renderToStaticMarkup(
    <RuntimeUsagePopoverContent
      runtime={{ provider: RUNTIME_PROVIDER.GROK, displayName: "Grok Build", version: "1.0.52" }}
      data={kiroUsage({ used: 700, limit: 10_000, overage: 0 })}
      scanning
      computerOnline
      onRefresh={() => {}}
    />,
  );
  expect(html).not.toMatch(/<button[^>]*\sdisabled(?=[\s>])/);
  expect(html).toContain('aria-label="Refreshing…"');
  expect(html).toContain("data-pending");
});

test("an overage follows the amounts on the same line, in the locale's number format", () => {
  const html = render(kiroUsage({ used: 10_250, limit: 10_000, overage: 250 }));
  expect(html).toContain("10,250 / 10,000 credits used · Overage: 250 credits");
});

test("each runtime names its usage windows the way that runtime reports them", () => {
  const session = { windowDurationMinutes: 300 };
  const week = { windowDurationMinutes: 10_080 };
  const month = { windowDurationMinutes: 43_200 };
  // Claude Code's duration is "time until reset", so a session window can look long: the slot decides.
  expect(usageWindowLabel(RUNTIME_PROVIDER.CLAUDE_CODE, "primary", month)).toBe("Session");
  expect(usageWindowLabel(RUNTIME_PROVIDER.CLAUDE_CODE, "secondary", session)).toBe("Weekly");
  expect(usageWindowLabel(RUNTIME_PROVIDER.ANTIGRAVITY, "primary", session)).toBe("Session");
  expect(usageWindowLabel(RUNTIME_PROVIDER.ANTIGRAVITY, "secondary", week)).toBe("Weekly");
  expect(usageWindowLabel(RUNTIME_PROVIDER.KIRO, "primary", month)).toBe("Monthly credits");
  // Grok: the billing period, then pay-as-you-go — never "Session" / "Weekly" by slot.
  expect(usageWindowLabel(RUNTIME_PROVIDER.GROK, "primary", { id: "grok-monthly", ...month })).toBe(
    "Monthly",
  );
  expect(usageWindowLabel(RUNTIME_PROVIDER.GROK, "primary", { id: "grok-weekly", ...week })).toBe(
    "Weekly",
  );
  expect(
    usageWindowLabel(RUNTIME_PROVIDER.GROK, "secondary", { id: "grok-pay-as-you-go", ...month }),
  ).toBe("Pay-as-you-go");
  // Codex reports each window's real length.
  expect(usageWindowLabel(RUNTIME_PROVIDER.CODEX, "primary", session)).toBe("Session");
  expect(usageWindowLabel(RUNTIME_PROVIDER.CODEX, "primary", week)).toBe("Weekly");
  expect(usageWindowLabel(RUNTIME_PROVIDER.CODEX, "secondary", week)).toBe("Weekly");
});

test("the popover's head: Refresh is an icon button, the plan is named, and OK says nothing", () => {
  const html = render(kiroUsage({ used: 7517.29, limit: 10_000, overage: 0 }));
  expect(html).toContain('aria-label="Refresh"');
  expect(html).not.toContain(">Refresh<");
  expect(html).toContain(">Kiro Power<");
  expect(html).not.toContain("Runtime account");
  expect(html).not.toContain(">OK<");
});

test("Codex's credits flag is a note on the account line when it says something", () => {
  const codex = (credits: { hasCredits: boolean; unlimited: boolean }) =>
    renderToStaticMarkup(
      <RuntimeUsagePopoverContent
        runtime={{ provider: RUNTIME_PROVIDER.CODEX, displayName: "Codex", version: "1.0.0" }}
        data={{
          state: "fresh",
          result: {
            workspaceId: "workspace-1",
            computerId: "computer-1",
            provider: RUNTIME_PROVIDER.CODEX,
            scanId: "scan-1",
            status: "available",
            collectedAt: new Date().toISOString(),
            snapshot: {
              provider: RUNTIME_PROVIDER.CODEX,
              planType: "pro",
              accountLabel: "f***@example.com",
              credits,
              primary: { usedPercent: 12, status: "ok", windowDurationMinutes: 300 },
            },
          },
        }}
        scanning={false}
        computerOnline
        onRefresh={() => {}}
      />,
    );
  expect(codex({ hasCredits: true, unlimited: true })).toContain(
    "f***@example.com · Unlimited credits",
  );
  expect(codex({ hasCredits: true, unlimited: false })).toContain(
    "f***@example.com · Credits available",
  );
  const none = codex({ hasCredits: false, unlimited: false });
  expect(none).toContain(">f***@example.com<");
  expect(none).not.toContain("credits");
});

test("the Computer page's runtime usage opens the same peek the Profile badge opens", async () => {
  // One hover-open peek serves both entry points (task #116): the Computer page chip no longer
  // runs the press-open variant with its close button.
  const content = await Bun.file(
    new URL("../src/features/computers/runtime-usage.tsx", import.meta.url).pathname,
  ).text();
  expect(content).not.toContain("openOnPress");
  expect(content).not.toContain("onClose");
  expect(content).not.toContain("ReactAriaClose"); // sanity: real marker replaced below
});

test("the Computer page's chip passes no press-open flag", async () => {
  const detail = await Bun.file(
    new URL("../src/features/computers/computer-detail.tsx", import.meta.url).pathname,
  ).text();
  expect(detail).not.toContain("openOnPress");
});

test("the Public toggle stays live while its update is in flight so the peek survives", async () => {
  // The update replaces the refresh bug's shape: a disabled Toggle would drop focus to the page
  // and a hover peek closes with it (task #116). Edits repeat-guard in the handler instead.
  const detail = await Bun.file(
    new URL("../src/features/computers/computer-detail.tsx", import.meta.url).pathname,
  ).text();
  expect(detail).toMatch(/aria-busy=\{updatingRuntimeIds\.has\(runtime\.id\) \|\| undefined\}/);
  expect(detail).toMatch(
    /if \(!updatingRuntimeIds\.has\(runtime\.id\)\)\s*\n\s*void setRuntimePublic/,
  );
  expect(detail).not.toMatch(/isDisabled=\{updatingRuntimeIds\.has\(runtime\.id\)\}/);
});
