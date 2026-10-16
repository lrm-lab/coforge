import { expect, test } from "bun:test";
import {
  APP_CONFIG_SYNC_MESSAGE_TYPE,
  CLEANER_APP_ID,
  type AppConfig,
  type AppConfigSync,
} from "@lrm/coforge-sdk/internal";
import {
  AgentAppConfigSync,
  type AppConfigTarget,
  type FlatAppConfig,
} from "#src/agent-app-config/agent-app-config-sync";
import { captureDaemonLogs } from "./log-capture";

const cleaner = (ownerAgentId: string, revision = 2): AppConfig => ({
  appId: CLEANER_APP_ID,
  ownerAgentId,
  revision,
  effective: { enabled: true, thresholdBytes: 8192, intervalMs: 900_000 },
});
const sync = (
  agentId: string,
  operation: AppConfigSync["operation"],
  configs: AppConfig[],
): AppConfigSync => ({
  protocolMajor: 1,
  requestId: crypto.randomUUID(),
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId,
  operation,
  configs,
  messageType: APP_CONFIG_SYNC_MESSAGE_TYPE,
});

function recordingTarget() {
  const calls: Array<["apply", FlatAppConfig] | ["replace", string, FlatAppConfig | null]> = [];
  const target: AppConfigTarget = {
    applyConfig: (raw) => void calls.push(["apply", raw]),
    replaceOwnerSnapshot: (owner, raw) => void calls.push(["replace", owner, raw]),
  };
  return { calls, target };
}

test("an upsert reaches its App's runtime as one flat config", () => {
  const { calls, target } = recordingTarget();
  const mirror = new AgentAppConfigSync({
    requestSnapshot: async () => sync("agent-1", "snapshot", []),
    apps: { [CLEANER_APP_ID]: target },
  });
  mirror.apply(sync("agent-1", "upsert", [cleaner("agent-1", 5)]));
  expect(calls).toEqual([
    [
      "apply",
      {
        appId: CLEANER_APP_ID,
        ownerAgentId: "agent-1",
        revision: 5,
        enabled: true,
        thresholdBytes: 8192,
        intervalMs: 900_000,
      },
    ],
  ]);
});

test("a snapshot replaces the owner's config, and one without the App's row removes it", () => {
  const { calls, target } = recordingTarget();
  const mirror = new AgentAppConfigSync({
    requestSnapshot: async () => sync("agent-1", "snapshot", []),
    apps: { [CLEANER_APP_ID]: target },
  });
  mirror.apply(sync("agent-1", "snapshot", [cleaner("agent-1")]));
  mirror.apply(sync("agent-1", "snapshot", []));
  expect(calls).toEqual([
    ["replace", "agent-1", expect.objectContaining({ ownerAgentId: "agent-1", revision: 2 })],
    ["replace", "agent-1", null],
  ]);
});

test("a runtime that throws does not stop the sync", () => {
  const mirror = new AgentAppConfigSync({
    requestSnapshot: async () => sync("agent-1", "snapshot", []),
    apps: {
      [CLEANER_APP_ID]: {
        applyConfig: () => {
          throw new Error("refused");
        },
        replaceOwnerSnapshot: () => {
          throw new Error("refused");
        },
      },
    },
  });
  expect(() => mirror.apply(sync("agent-1", "upsert", [cleaner("agent-1")]))).not.toThrow();
  expect(() => mirror.apply(sync("agent-1", "snapshot", []))).not.toThrow();
});

test("a runtime whose apply rejects later is logged, not left unhandled", async () => {
  const { records } = await captureDaemonLogs(async (records) => {
    const mirror = new AgentAppConfigSync({
      requestSnapshot: async () => sync("agent-1", "snapshot", []),
      apps: {
        [CLEANER_APP_ID]: {
          applyConfig: async () => {
            throw new Error("refused");
          },
          replaceOwnerSnapshot: () => undefined,
        },
      },
    });
    mirror.apply(sync("agent-1", "upsert", [cleaner("agent-1")]));
    while (!records.some((record) => record.properties.event === "agent_app_config:apply_failed"))
      await Promise.resolve();
  });
  expect(records.map((record) => record.properties.event)).toContain(
    "agent_app_config:apply_failed",
  );
});

test("each owner's snapshot is requested at most once per connection and applied", async () => {
  const { calls, target } = recordingTarget();
  const requested: string[] = [];
  const mirror = new AgentAppConfigSync({
    requestSnapshot: async (agentId) => {
      requested.push(agentId);
      return sync(agentId, "snapshot", [cleaner(agentId)]);
    },
    apps: { [CLEANER_APP_ID]: target },
  });
  await mirror.request("agent-1");
  await mirror.request("agent-1");
  await mirror.request("agent-2");
  expect(requested).toEqual(["agent-1", "agent-2"]);
  expect(calls.map((call) => call[1])).toEqual(["agent-1", "agent-2"]);

  mirror.connected();
  await mirror.request("agent-1");
  expect(requested).toEqual(["agent-1", "agent-2", "agent-1"]);
});

test("a failed request may be asked again on the same connection", async () => {
  let fail = true;
  const requested: string[] = [];
  const mirror = new AgentAppConfigSync({
    requestSnapshot: async (agentId) => {
      requested.push(agentId);
      if (fail) throw new Error("rpc failed");
      return sync(agentId, "snapshot", []);
    },
    apps: {},
  });
  await expect(mirror.request("agent-1")).rejects.toThrow("rpc failed");
  fail = false;
  await mirror.request("agent-1");
  expect(requested).toEqual(["agent-1", "agent-1"]);
});

test("a snapshot that answers on an older connection, or for another Agent, is not applied", async () => {
  const { calls, target } = recordingTarget();
  const replies: Array<PromiseWithResolvers<AppConfigSync>> = [];
  const mirror = new AgentAppConfigSync({
    requestSnapshot: () => {
      const reply = Promise.withResolvers<AppConfigSync>();
      replies.push(reply);
      return reply.promise;
    },
    apps: { [CLEANER_APP_ID]: target },
  });
  const stale = mirror.request("agent-1");
  mirror.connected();
  const current = mirror.request("agent-1");
  replies[0]!.resolve(sync("agent-1", "snapshot", [cleaner("agent-1", 1)]));
  await stale;
  replies[1]!.resolve(sync("agent-2", "snapshot", []));
  await expect(current).rejects.toThrow("another Agent");
  expect(calls).toEqual([]);
});

test("an older connection's failed request does not let this one ask twice", async () => {
  const replies: Array<PromiseWithResolvers<AppConfigSync>> = [];
  const mirror = new AgentAppConfigSync({
    requestSnapshot: () => {
      const reply = Promise.withResolvers<AppConfigSync>();
      replies.push(reply);
      return reply.promise;
    },
    apps: {},
  });
  const stale = mirror.request("agent-1");
  mirror.connected();
  void mirror.request("agent-1");
  replies[0]!.reject(new Error("connection closed"));
  await expect(stale).rejects.toThrow("connection closed");
  void mirror.request("agent-1");
  expect(replies).toHaveLength(2);
});
