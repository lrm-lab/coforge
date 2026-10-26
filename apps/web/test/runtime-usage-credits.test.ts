import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { usageWindowLabel } from "#src/features/computers/runtime-usage-windows";

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

test("both runtime entry points open the popover on a press, as on Raft", async () => {
  // This reverses the hover peek task #116 chose (0ff45a971): the Computer page and the Profile
  // badge share RuntimeUsage, so they still open the same way.
  const content = await Bun.file(
    new URL("../src/features/computers/runtime-usage.tsx", import.meta.url).pathname,
  ).text();
  expect(content).toContain("<DialogTrigger>");
  expect(content).not.toContain("HoverPopover");
});

test("the Public toggle stays live while its update is in flight so the peek survives", async () => {
  // The update replaces the refresh bug's shape: a disabled Toggle would drop focus to the page
  // mid-press (task #116). Edits repeat-guard in the handler instead.
  const detail = await Bun.file(
    new URL("../src/features/computers/computer-runtimes.tsx", import.meta.url).pathname,
  ).text();
  expect(detail).toMatch(/aria-busy=\{updatingRuntimeIds\.has\(runtime\.id\) \|\| undefined\}/);
  expect(detail).toMatch(
    /if \(!updatingRuntimeIds\.has\(runtime\.id\)\)\s*\n\s*void setRuntimePublic/,
  );
  expect(detail).not.toMatch(/isDisabled=\{updatingRuntimeIds\.has\(runtime\.id\)\}/);
});
