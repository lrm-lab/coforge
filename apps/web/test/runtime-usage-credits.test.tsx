import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

import { RuntimeUsagePopoverContent } from "#src/features/computers/runtime-usage";
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
        planType: "power",
        primary: {
          usedPercent: Math.round((creditUsage.used / creditUsage.limit) * 100),
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

test("an overage follows the amounts on the same line, in the locale's number format", () => {
  const html = render(kiroUsage({ used: 10_250, limit: 10_000, overage: 250 }));
  expect(html).toContain("10,250 / 10,000 credits used · Overage: 250 credits");
});
