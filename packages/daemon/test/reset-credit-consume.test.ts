import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { RUNTIME_PROVIDER, type ResetCreditOutcome } from "@lrm/coforge-sdk/internal";
import {
  consumeResetCredit,
  releaseProviderAgents,
} from "#src/daemon-runtime/reset-credit-consume";

const key = "0b8c1f3e-52d7-4a9c-9a4e-6f1d2c3b4a59";
const snapshot = { provider: "codex", resetCreditsAvailable: 1 } as const;
const NOW = new Date("2026-11-09T12:00:00.000Z");

beforeEach(() => setSystemTime(NOW));
afterEach(() => setSystemTime());

/** A runtime whose Codex adapter answers `outcome` (or throws), recording what it was asked and
 * what the rest of the runtime was told to do afterwards. `read` is what a fresh usage read gives. */
function harness(
  consume: ResetCreditOutcome | Error | "absent",
  options: {
    read?: typeof snapshot | null | Error;
    running?: boolean;
    release?: () => void;
  } = {},
) {
  const calls: Array<{ workingDirectory: string; idempotencyKey: string }> = [];
  const order: string[] = [];
  const ports = {
    assertRunning: () => {
      if (options.running === false) throw new Error("not running");
    },
    workspaceRoot: "/workspace",
    createProvider: () =>
      consume === "absent"
        ? {}
        : {
            consumeResetCredit: async (request: {
              workingDirectory: string;
              idempotencyKey: string;
            }) => {
              calls.push(request);
              order.push("consume");
              if (consume instanceof Error) throw consume;
              return consume;
            },
            readUsage: async () => {
              order.push("read");
              const read = options.read === undefined ? snapshot : options.read;
              if (read instanceof Error) throw read;
              return read;
            },
          },
    agents: {
      activeAgentIds: () => ["held"],
      restartConfig: () => ({ config: { provider: RUNTIME_PROVIDER.CODEX as string } }),
      session: () => ({}),
    },
    hold: {
      releaseRateLimitBackoff: () => {
        order.push(`release ${RUNTIME_PROVIDER.CODEX}`);
        options.release?.();
        return true;
      },
    },
  };
  return { ports, calls, order };
}

test("sends the key as given from the Workspace root and answers with the fresh usage", async () => {
  const { ports, calls } = harness("no_credit");
  const result = await consumeResetCredit(ports, RUNTIME_PROVIDER.CODEX, key);
  expect(calls).toEqual([{ workingDirectory: "/workspace", idempotencyKey: key }]);
  expect(result.outcome).toBe("no_credit");
  // The reading is the adapter's own, stamped with the time it was read.
  expect(JSON.parse(new TextDecoder().decode(result.snapshotJson))).toEqual({
    ...snapshot,
    collectedAt: NOW.toISOString(),
  });
});

test("after a reset the held Agents are released before the usage is read again", async () => {
  const { ports, order } = harness("reset");
  const result = await consumeResetCredit(ports, RUNTIME_PROVIDER.CODEX, key);
  expect(result.outcome).toBe("reset");
  expect(order).toEqual(["consume", "release codex", "read"]);
});

test("an already redeemed credit means the limit was lifted, so the Agents are released too", async () => {
  const { ports, order } = harness("already_redeemed");
  expect((await consumeResetCredit(ports, RUNTIME_PROVIDER.CODEX, key)).outcome).toBe(
    "already_redeemed",
  );
  expect(order).toContain("release codex");
});

test("any other outcome releases nobody", async () => {
  for (const outcome of ["nothing_to_reset", "no_credit", "unknown"] as const) {
    const { ports, order } = harness(outcome);
    expect((await consumeResetCredit(ports, RUNTIME_PROVIDER.CODEX, key)).outcome).toBe(outcome);
    expect(order).not.toContain("release codex");
  }
});

test("releasing the Agents cannot lose the outcome", async () => {
  const { ports } = harness("reset", {
    release: () => {
      throw new Error("agent store is broken");
    },
  });
  const result = await consumeResetCredit(ports, RUNTIME_PROVIDER.CODEX, key);
  expect(result.outcome).toBe("reset");
  expect(result.snapshotJson).toBeDefined();
});

test("a usage read that gave nothing, or failed, is not replaced by anything older", async () => {
  // Only a real read after the attempt is sent: the Daemon's earlier observation of this account
  // (what a usage scan falls back to) still counts the credit that was just spent.
  for (const read of [null, new Error("provider unreachable")]) {
    const { ports } = harness("reset", { read });
    expect(await consumeResetCredit(ports, RUNTIME_PROVIDER.CODEX, key)).toEqual({
      outcome: "reset",
    });
  }
});

test("a refusal before the credit could be asked for reads nothing again", async () => {
  for (const outcome of ["unsupported", "reauth_required"] as const) {
    const { ports, order } = harness(outcome);
    expect(await consumeResetCredit(ports, RUNTIME_PROVIDER.CODEX, key)).toEqual({ outcome });
    expect(order).toEqual(["consume"]);
  }
});

test("an adapter that throws leaves the attempt open, because the credit may be spent", async () => {
  const { ports } = harness(new Error("secret provider detail"));
  const result = await consumeResetCredit(ports, RUNTIME_PROVIDER.CODEX, key);
  expect(result.outcome).toBe("unknown");
});

test("a runtime that cannot spend a credit says unsupported without asking anyone", async () => {
  const { ports, order } = harness("absent");
  expect(await consumeResetCredit(ports, RUNTIME_PROVIDER.CODEX, key)).toEqual({
    outcome: "unsupported",
  });
  expect(await consumeResetCredit(ports, RUNTIME_PROVIDER.PI, key)).toEqual({
    outcome: "unsupported",
  });
  expect(order).toEqual([]);
});

test("a Daemon that is not running leaves the attempt open", async () => {
  const { ports, calls } = harness("reset", { running: false });
  expect(await consumeResetCredit(ports, RUNTIME_PROVIDER.CODEX, key)).toEqual({
    outcome: "unknown",
  });
  expect(calls).toEqual([]);
});

test("only this provider's Agents with a live session that wait out a rate limit are released", () => {
  const released: string[] = [];
  const providers: Record<string, string | undefined> = {
    "codex-held": "codex",
    "codex-free": "codex",
    "claude-held": "claude-code",
    unlaunched: undefined,
    "codex-held-exited": "codex",
  };
  const count = releaseProviderAgents(
    {
      agents: {
        activeAgentIds: () => Object.keys(providers),
        restartConfig: (agentId) =>
          providers[agentId] ? { config: { provider: providers[agentId] } } : undefined,
        session: (agentId) => (agentId.endsWith("-exited") ? undefined : {}),
      },
      hold: {
        releaseRateLimitBackoff: (agentId) => {
          released.push(agentId);
          return agentId.endsWith("-held");
        },
      },
    },
    RUNTIME_PROVIDER.CODEX,
  );
  expect(released).toEqual(["codex-held", "codex-free"]);
  expect(count).toBe(1);
});
