import { fixtureCodexHost } from "./fixtures/codex-host";
import { expect, test } from "bun:test";
import { CodexProvider, consumeCodexResetCredit } from "@lrm/coforge-anvil/codex";

const fixture = new URL("./fixtures/codex-app-server.ts", import.meta.url).pathname;
const key = "0b8c1f3e-52d7-4a9c-9a4e-6f1d2c3b4a59";

function consume(scenario: string[], timeoutMs?: number) {
  return consumeCodexResetCredit(process.cwd(), {
    host: fixtureCodexHost,
    command: [process.execPath, fixture, ...scenario],
    idempotencyKey: key,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
}

test("sends the attempt's key as given, with no credit chosen, and names what the account settled", async () => {
  for (const [wire, outcome] of [
    ["reset", "reset"],
    ["nothingToReset", "nothing_to_reset"],
    ["noCredit", "no_credit"],
    ["alreadyRedeemed", "already_redeemed"],
  ] as const)
    expect(await consume([`usage-consume=${wire}`, `usage-key=${key}`])).toBe(outcome);
});

test("an answer it cannot read leaves the attempt open", async () => {
  expect(await consume(["usage-consume=unknown-outcome"])).toBe("unknown");
});

test("a failure on the way leaves the attempt open, because the credit may be spent", async () => {
  expect(await consume(["usage-consume=error"])).toBe("unknown");
  expect(await consume(["usage-consume=exit"])).toBe("unknown");
  expect(await consume(["usage-consume=timeout"], 50)).toBe("unknown");
});

test("an app-server that does not know the method has spent nothing and says unsupported", async () => {
  expect(await consume(["usage-consume=method-not-found"])).toBe("unsupported");
});

test("a Codex older than the first release with the method is unsupported without being asked", async () => {
  expect(await consume(["usage-consume=reset", "usage-version=0.140.9"])).toBe("unsupported");
  expect(await consume(["usage-consume=reset", "usage-version=0.141.0"])).toBe("reset");
  expect(await consume(["usage-consume=reset", "usage-version=0.200.1"])).toBe("reset");
  // A version it cannot read is never gated: the app-server's own answer decides.
  expect(await consume(["usage-consume=reset"])).toBe("reset");
});

test("an account without a plan has nothing to reset and is not asked", async () => {
  expect(await consume(["usage-consume=reset", "usage-apikey"])).toBe("unsupported");
  expect(await consume(["usage-consume=reset", "usage-noauth"])).toBe("unsupported");
});

test("a runtime that is signed out needs signing in again and is not asked", async () => {
  expect(await consume(["usage-consume=reset", "usage-signedout"])).toBe("reauth_required");
});

test("an app-server that predates account/read is still asked", async () => {
  expect(await consume(["usage-consume=reset", "usage-legacy"])).toBe("reset");
});

test("the Codex adapter offers the attempt", async () => {
  const provider = new CodexProvider({
    host: fixtureCodexHost,
    command: [process.execPath, fixture, "usage-consume=reset", `usage-key=${key}`],
  });
  expect(
    await provider.consumeResetCredit({
      workingDirectory: process.cwd(),
      idempotencyKey: key,
    }),
  ).toBe("reset");
});
