import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { usageWindowLabel } from "#src/features/computers/runtime-usage-windows";
import {
  accountBand,
  chipStatus,
  shownAccount,
  usageFailureDescription,
  usageHealth,
  usageReadForAuth,
  usageStatus,
} from "#src/features/computers/runtime-usage-status";
import type { UsageReadResult } from "#src/server/centrifugo/usage-cache.server";

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
  // A trigger with props still presses open; only a hover trigger would regress the behaviour.
  expect(content).toMatch(/<DialogTrigger[\s>]/);
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

test("only the runtime's own login check says whether it is signed in", () => {
  const reauth = {
    state: "fresh",
    result: { status: "reauth", collectedAt: "2026-10-27T00:00:00.000Z" },
  } as unknown as UsageReadResult;
  // Kiro's whoami says signed in while the usage reader's token has expired (task #203): the
  // usage is unavailable, not a second, contradicting "Not signed in".
  const signedIn = usageReadForAuth(reauth, "logged_in");
  expect(signedIn?.result?.status).toBe("unavailable");
  expect(usageFailureDescription(signedIn?.result)).toBeUndefined();
  expect(usageHealth(signedIn)).toBeUndefined();
  // A login check that failed, or never came, outranks the reader too: one login fact (task #208).
  expect(usageReadForAuth(reauth, "unknown")?.result?.status).toBe("unavailable");
  expect(usageReadForAuth(reauth, "unreported")?.result?.status).toBe("unavailable");
  // Signed out, or with no login check, the reader's own answer stands.
  expect(usageReadForAuth(reauth, "logged_out")).toBe(reauth);
  expect(usageReadForAuth(reauth, undefined)).toBe(reauth);
});

test("the chip's dot and the popover's badge name each state from one table", () => {
  const read = (result: Record<string, unknown>, state = "fresh") =>
    ({ state, result: { collectedAt: "2026-10-27T00:00:00.000Z", ...result } }) as UsageReadResult;
  const record = (result: Record<string, unknown>) => read(result).result!;
  // A failed read says nothing about the runtime (Frank, task #209): no badge, no dot, no line.
  for (const status of ["unavailable", "error"]) {
    expect(usageStatus(record({ status }))).toBeUndefined();
    expect(usageHealth(read({ status }))).toBeUndefined();
    expect(usageFailureDescription(record({ status }))).toBeUndefined();
  }
  // A runtime that reports no usage, or a reader not yet connected, is nobody's to fix: no dot.
  expect(usageStatus(record({ status: "unsupported" }))).toBeUndefined();
  expect(
    usageHealth(read({ status: "unsupported", message: "Usage reader is not connected yet" })),
  ).toBeUndefined();
  // An old read is still OK: the popover says how old it is.
  expect(usageHealth(read({ status: "ok", snapshot: {} }, "stale"))?.ok).toBe(true);
  expect(usageStatus(record({ status: "ok", snapshot: { health: "rate_limited" } }))).toEqual({
    ok: false,
    label: "Limit reached",
  });
});

test("a login state that needs saying outranks usage on the chip, and never leaves it blank", () => {
  const usageOk = { ok: true, label: "Usage OK" };
  expect(chipStatus("unreported", usageOk)).toEqual({
    ok: false,
    label: "Update Computer to sign in or out here",
  });
  expect(chipStatus("logged_out", usageOk)?.label).toBe("Not signed in");
  expect(chipStatus("logged_in", usageOk)).toBe(usageOk);
  expect(chipStatus("logged_in", undefined)).toEqual({ ok: true, label: "Signed in" });
  expect(chipStatus("unavailable", undefined)).toBeUndefined();
});

test("a failed login check reads as signed in while usage reads, else as signed out", () => {
  const read = (status: string) =>
    ({
      state: "fresh",
      result: { status, collectedAt: "2026-10-27T00:00:00.000Z" },
    }) as UsageReadResult;
  // Frank's Kiro on staging (task #209): whoami failed, Kiro Power still read, so nothing to do.
  expect(shownAccount("unknown", read("available"))).toBe("logged_in");
  // With no usage either it is simply not signed in, Sign In beside it (Frank, task #209).
  expect(shownAccount("unknown", read("unavailable"))).toBe("logged_out");
  expect(shownAccount("unknown", undefined)).toBe("logged_out");
  expect(shownAccount("logged_out", read("available"))).toBe("logged_out");
  // The orange band is only for what the user must do: sign in, or update the Computer.
  expect(accountBand("logged_out")?.label).toBe("Not signed in");
  expect(accountBand("unreported")?.label).toBe("Update Computer to sign in or out here");
  expect(accountBand("unknown")).toBeUndefined();
  expect(accountBand("logged_in")).toBeUndefined();
});
