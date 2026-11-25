import { expect, test } from "bun:test";
import {
  controls,
  faults,
  input,
  intent,
  modes,
  noticePath,
  reason,
  routes,
  runManualFixture,
  slug,
  type Mode,
  type Scenario,
} from "./manual-cli-fixture";

const manualError = (message: string, code = "MANUAL_FAILED") =>
  `Error: ${message}\nCode: ${code}\nRetryable: no\n`;

function originalError(scenario: Scenario, mode: Mode): string {
  if (scenario === "missing" && mode === "external")
    return (
      manualError(`Profile "${slug}" has no credential.`, "PROFILE_NOT_LOGGED_IN") +
      "Next action: Run `coforge agent login --server <url> --agent <id-or-name>` and paste the credential from the Agent's page.\n"
    );
  if (scenario === "missing") return manualError("coforge agent context is not configured");
  if (scenario === "404")
    return (
      manualError("Fixture topic not found", "KNOWLEDGE_NOT_FOUND") +
      "Next action: Retry with a close topic id or different keywords. Browse topics: coforge manual get index\n"
    );
  if (scenario === "401" && mode === "external")
    return (
      manualError(
        "The server rejected this Agent's key; it was revoked or replaced.",
        "EXTERNAL_CREDENTIAL_INVALID",
      ) + "Next action: Run `coforge agent login` again for this profile.\n"
    );
  if (scenario === "refused" || scenario === "timeout")
    return manualError("agent proxy request failed (network or timeout)");
  if (scenario === "503") return manualError("Fixture server error", "KNOWLEDGE_QUERY_INVALID");
  return manualError(`HTTP ${scenario}`);
}

for (const route of routes) {
  for (const mode of modes) {
    const manualRequest = {
      path: route.path,
      method: "GET",
      query: { [route.parameter]: input, intent, reason },
      authorized: true,
    };
    for (const fault of faults) {
      test.concurrent(`manual ${route.command} ${mode} ${fault} prints recovery before the original error`, async () => {
        const result = await runManualFixture(route, mode, fault);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.requests).toEqual(fault === "refused" ? [] : [manualRequest]);
        const original =
          fault === "body-timeout"
            ? `invalid Agent Manual ${route.command} response\n`
            : originalError(fault, mode);
        expect(result.stderr.endsWith(original)).toBeTrue();
        const recovery = result.stderr.slice(0, -original.length);
        const diagnostic =
          mode === "managed" ? "coforge-computer status" : `coforge agent status --profile ${slug}`;
        expect(recovery).toStartWith("Manual recovery");
        expect(recovery).toContain(diagnostic);
        expect(recovery).toContain("retry the manual command once");
        expect(recovery).toContain("Workspace administrator");
      }, 30_000);
    }

    if (mode === "external")
      test.concurrent(`manual ${route.command} external redirect retains the refusal and never follows it`, async () => {
        const result = await runManualFixture(route, mode, "redirect");
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(originalError("timeout", mode));
        expect(result.requests).toEqual([manualRequest]);
      });

    for (const control of controls) {
      test.concurrent(`manual ${route.command} ${mode} ${control} preserves the original CLI result`, async () => {
        const result = await runManualFixture(route, mode, control);
        const success = control === "success";
        const hasNotice = mode === "managed" && control !== "missing";
        expect(result.exitCode).toBe(success ? 0 : 1);
        expect(result.stdout).toBe(success ? route.stdout : "");
        expect(result.stderr).toBe(
          (success ? "" : originalError(control, mode)) + (hasNotice ? "Fixture update\n" : ""),
        );
        expect(result.requests).toEqual([
          ...(control === "missing" ? [] : [manualRequest]),
          ...(hasNotice ? [{ path: noticePath, method: "GET", query: {}, authorized: true }] : []),
        ]);
      });
    }
  }
}
