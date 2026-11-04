import { expect, test } from "bun:test";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import {
  restoreSupersededAgentApiKey,
  revokeAgentApiKey,
} from "#src/daemon-runtime/agent-api-key-revoke";

const transportThat = (revoked: string[]) =>
  ({
    revokeAgentApiKey: async (agentApiKey: string) => {
      revoked.push(agentApiKey);
    },
  }) as Pick<DaemonConnectionClient, "revokeAgentApiKey"> as DaemonConnectionClient;

test("a failed launch's revoke puts back the key the still-running process holds", async () => {
  const agentApiKeys = new Map([["agent-a", "k1"]]);
  // The second launch overwrote the running process's K1 with its own K2, then failed.
  agentApiKeys.set("agent-a", "k2");
  const revoked: string[] = [];

  restoreSupersededAgentApiKey(agentApiKeys, "agent-a", "k2", "k1");
  await revokeAgentApiKey(transportThat(revoked), agentApiKeys, "agent-a", "k2");

  expect(agentApiKeys.get("agent-a")).toBe("k1");
  expect(revoked).toEqual(["k2"]);
});

test("a failed first launch leaves the table empty, as before", async () => {
  const agentApiKeys = new Map([["agent-a", "k2"]]);
  const revoked: string[] = [];

  restoreSupersededAgentApiKey(agentApiKeys, "agent-a", "k2", undefined);
  await revokeAgentApiKey(transportThat(revoked), agentApiKeys, "agent-a", "k2");

  expect(agentApiKeys.has("agent-a")).toBe(false);
  expect(revoked).toEqual(["k2"]);
});

test("a concurrent launch's newer key is never clobbered by the restore", () => {
  const agentApiKeys = new Map([["agent-a", "k3"]]);
  restoreSupersededAgentApiKey(agentApiKeys, "agent-a", "k2", "k1");
  expect(agentApiKeys.get("agent-a")).toBe("k3");
});

test("the restore does nothing when the superseded key was never written", () => {
  const agentApiKeys = new Map([["agent-a", "k1"]]);
  restoreSupersededAgentApiKey(agentApiKeys, "agent-a", "k2", "k1");
  expect(agentApiKeys.get("agent-a")).toBe("k1");
});
