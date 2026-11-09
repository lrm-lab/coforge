import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import {
  liftProviderLimit,
  type ProviderLimitLiftPorts,
} from "#src/daemon-runtime/provider-limit-lift";
import { captureDaemonLogs } from "./log-capture";

/** Every wait owner as a recording fake; `fail` names the owner that throws instead. */
function harness(fail?: "hold" | "launchRetries" | "launchWaits" | "wakeCooldowns") {
  const calls: string[] = [];
  const attempt = (owner: NonNullable<typeof fail>, count: number) => {
    if (owner === fail) throw new Error(`${owner} is broken`);
    return count;
  };
  const restartProviders: Record<string, string | undefined> = {
    "codex-agent": "codex",
    "claude-agent": "claude-code",
    unlaunched: undefined,
  };
  const wakeCooldownAgents: string[] = [];
  const ports: ProviderLimitLiftPorts = {
    agents: {
      restartConfig: (agentId) =>
        restartProviders[agentId]
          ? { config: { provider: restartProviders[agentId]! } }
          : undefined,
      session: (agentId) => (agentId === "codex-agent" ? {} : undefined),
    },
    hold: {
      releaseRateLimitBackoffs: (provider, hasSession) => {
        calls.push(`hold ${provider} session:${hasSession("codex-agent")}/${hasSession("other")}`);
        return attempt("hold", 2);
      },
    },
    launchRetries: {
      endQuotaLaunchWaits: (provider) => {
        calls.push(`launchRetries ${provider}`);
        return attempt("launchRetries", 3);
      },
    },
    launchWaits: {
      endLaunchWaits: (provider) => {
        calls.push(`launchWaits ${provider}`);
        return attempt("launchWaits", 4);
      },
    },
    wakeCooldowns: {
      endRecoveryWaits: (belongs) => {
        calls.push("wakeCooldowns");
        for (const agentId of Object.keys(restartProviders))
          if (belongs(agentId)) wakeCooldownAgents.push(agentId);
        return attempt("wakeCooldowns", 5);
      },
    },
  };
  return { ports, calls, wakeCooldownAgents };
}

test("a lifted limit reaches every wait owner for that provider and counts what each ended", () => {
  const { ports, calls, wakeCooldownAgents } = harness();

  expect(liftProviderLimit(ports, RUNTIME_PROVIDER.CODEX)).toEqual({
    backoffs: 2,
    launchRetries: 3,
    launchWaits: 4,
    wakeCooldowns: 5,
  });

  expect(calls).toEqual([
    "hold codex session:true/false",
    "launchWaits codex",
    "launchRetries codex",
    "wakeCooldowns",
  ]);
  // A wake cooldown has no provider of its own: the Agent's restart config says whose it is.
  expect(wakeCooldownAgents).toEqual(["codex-agent"]);
});

test("one owner failing leaves the others released and is logged without a payload", async () => {
  const reported = {
    hold: "backoffs",
    launchRetries: "launchRetries",
    launchWaits: "launchWaits",
    wakeCooldowns: "wakeCooldowns",
  } as const;
  for (const owner of Object.keys(reported) as Array<keyof typeof reported>) {
    const { ports, calls } = harness(owner);
    const { result, records } = await captureDaemonLogs(async () =>
      liftProviderLimit(ports, RUNTIME_PROVIDER.CODEX),
    );

    expect(calls).toHaveLength(4);
    expect(Object.values(result).filter((count) => count === 0)).toHaveLength(1);
    expect(
      records.find(
        (record) => record.properties.event === "daemon_runtime:provider_limit_lift_failed",
      )?.properties,
    ).toMatchObject({ provider: "codex", owner: reported[owner] });
  }
});
