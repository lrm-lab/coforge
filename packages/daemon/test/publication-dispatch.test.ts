import { describe, expect, test } from "bun:test";
import {
  AGENT_ACTIVITY_PROBE_MESSAGE_TYPE,
  AGENT_MESSAGE_METHOD,
  APP_CONFIG_SYNC_MESSAGE_TYPE,
  REMINDER_DUE_MESSAGE_TYPE,
  REMINDER_SYNC_MESSAGE_TYPE,
  encodeAgentActivityProbe,
  encodeAgentConfigSync,
  encodeAgentContextViewRequest,
  encodeAgentInboxPurge,
  encodeAgentMessageDelivery,
  encodeAgentServerFeatures,
  encodeAgentSkillsListRequest,
  encodeAgentStaleRuntimeStop,
  encodeAgentStartIntent,
  encodeAgentStopIntent,
  encodeAgentTurnInterruptIntent,
  encodeAppConfigSync,
  encodeComputerRestartIntent,
  encodeComputerUpgradeIntent,
  encodeDaemonRuntimeUsageScanRequest,
  encodeReminderDue,
  encodeReminderSync,
  encodeRuntimeAuthIntent,
} from "@lrm/coforge-sdk/internal";
import { encodePiChatRequest } from "@lrm/coforge-sdk/internal/pi-chat-wire";
import { DaemonConnection } from "#src/connection/daemon-connection";
import { scanPublicationKinds } from "#src/connection/publication-routing";
import { gatedCentrifuge } from "./fixtures/gated-centrifuge";
import { captureDaemonLogs } from "./log-capture";

const WORKSPACE_ID = "019b0381-1111-7111-8111-111111111111";
const COMPUTER_ID = "019b0381-2222-7222-8222-222222222222";
const AGENT_ID = "019b0381-3333-7333-8333-333333333333";

function sampleAgentMessage(overrides?: Partial<Parameters<typeof encodeAgentMessageDelivery>[0]>) {
  return encodeAgentMessageDelivery({
    protocolMajor: 1,
    requestId: "req-msg-1",
    messageId: "msg-1",
    workspaceId: WORKSPACE_ID,
    conversationId: "conv-1",
    agentId: AGENT_ID,
    body: "hello world",
    method: AGENT_MESSAGE_METHOD,
    deliveryId: "del-1",
    sequence: 1,
    target: "#general",
    latestSenderKind: "human",
    latestSenderHandle: "alice",
    ...overrides,
  });
}

describe("scanPublicationKinds", () => {
  test("identifies AgentMessageDelivery with large body and 64-bit sequence varint", () => {
    const bytes = sampleAgentMessage({
      body: "x".repeat(64 * 1024),
      sequence: 2 ** 42 + 7,
    });
    expect(scanPublicationKinds(bytes)).toEqual(["agent_message"]);
  });

  test("identifies tagged server publications and stale runtime stop", () => {
    expect(
      scanPublicationKinds(
        encodeAgentStartIntent({
          protocolMajor: 1,
          requestId: "s1",
          workspaceId: WORKSPACE_ID,
          computerId: COMPUTER_ID,
          agentId: AGENT_ID,
          provider: "codex",
          model: "default",
          reasoning: "balanced",
          controlEpoch: 1,
          launchId: "l1",
        }),
      ),
    ).toEqual(["agent_start"]);

    expect(
      scanPublicationKinds(
        encodeAgentStopIntent({
          protocolMajor: 1,
          requestId: "s2",
          workspaceId: WORKSPACE_ID,
          computerId: COMPUTER_ID,
          agentId: AGENT_ID,
          provider: "codex",
          controlEpoch: 2,
        }),
      ),
    ).toEqual(["agent_stop"]);

    expect(
      scanPublicationKinds(
        encodeAgentTurnInterruptIntent({
          protocolMajor: 1,
          requestId: "s3",
          workspaceId: WORKSPACE_ID,
          computerId: COMPUTER_ID,
          agentId: AGENT_ID,
          provider: "codex",
          epoch: 1,
          launchId: "l1",
        }),
      ),
    ).toEqual(["agent_turn_interrupt"]);

    expect(
      scanPublicationKinds(
        encodeAgentStaleRuntimeStop({
          protocolMajor: 1,
          requestId: "s4",
          workspaceId: WORKSPACE_ID,
          agentId: AGENT_ID,
          computerId: COMPUTER_ID,
          controlEpoch: 3,
        }),
      ),
    ).toEqual(["stale_runtime_stop"]);

    expect(
      scanPublicationKinds(
        encodeAgentConfigSync({
          protocolMajor: 1,
          workspaceId: WORKSPACE_ID,
          computerId: COMPUTER_ID,
          agentId: AGENT_ID,
          revision: 1,
          provider: "codex",
          model: "default",
          reasoning: "balanced",
        }),
      ),
    ).toEqual(["agent_config_sync"]);

    expect(
      scanPublicationKinds(
        encodeAppConfigSync({
          protocolMajor: 1,
          requestId: "a1",
          workspaceId: WORKSPACE_ID,
          computerId: COMPUTER_ID,
          agentId: AGENT_ID,
          operation: "snapshot",
          configs: [],
          messageType: APP_CONFIG_SYNC_MESSAGE_TYPE,
        }),
      ),
    ).toEqual(["app_config_sync"]);

    expect(
      scanPublicationKinds(
        encodeAgentServerFeatures({
          protocolMajor: 1,
          requestId: "f1",
          workspaceId: WORKSPACE_ID,
          computerId: COMPUTER_ID,
          revision: 1,
          agentIds: [AGENT_ID],
        }),
      ),
    ).toEqual(["agent_server_features"]);

    expect(
      scanPublicationKinds(
        encodeReminderDue({
          protocolMajor: 1,
          workspaceId: WORKSPACE_ID,
          computerId: COMPUTER_ID,
          agentId: AGENT_ID,
          occurrenceId: "019b0381-4444-7444-8444-444444444444",
          job: {
            reminderId: "019b0381-5555-7555-8555-555555555555",
            ownerAgentId: AGENT_ID,
            version: 1,
            title: "Check",
            target: "#general",
            messageId: "019b0381-6666-7666-8666-666666666666",
            fireAt: "2026-11-17T00:00:00.000Z",
          },
          expiresAt: "2026-11-24T00:00:00.000Z",
          messageType: REMINDER_DUE_MESSAGE_TYPE,
        }),
      ),
    ).toEqual(["reminder_due"]);

    expect(
      scanPublicationKinds(
        encodeReminderSync({
          protocolMajor: 1,
          requestId: "rs-1",
          workspaceId: WORKSPACE_ID,
          computerId: COMPUTER_ID,
          agentId: AGENT_ID,
          operation: "snapshot",
          jobs: [],
          messageType: REMINDER_SYNC_MESSAGE_TYPE,
        }),
      ),
    ).toEqual(["reminder_sync"]);

    expect(
      scanPublicationKinds(
        encodeAgentActivityProbe({
          protocolMajor: 1,
          requestId: "p-1",
          workspaceId: WORKSPACE_ID,
          computerId: COMPUTER_ID,
          agentId: AGENT_ID,
          probeId: "probe-1",
        }),
      ),
    ).toEqual(["agent_activity_probe"]);

    expect(
      scanPublicationKinds(
        encodeAgentInboxPurge({
          protocolMajor: 1,
          requestId: "ip-1",
          workspaceId: WORKSPACE_ID,
          computerId: COMPUTER_ID,
          agentId: AGENT_ID,
          conversationIds: ["conv-1"],
          targets: ["#general"],
          reason: "left",
        }),
      ),
    ).toEqual(["agent_inbox_purge"]);

    expect(
      scanPublicationKinds(
        encodeComputerUpgradeIntent({
          protocolMajor: 1,
          requestId: "u-1",
          workspaceId: WORKSPACE_ID,
          computerId: COMPUTER_ID,
          target: "latest",
          expectedVersion: "1.0.0",
          releaseChannel: "stable",
        }),
      ),
    ).toEqual(["computer_upgrade"]);

    expect(
      scanPublicationKinds(
        encodeComputerRestartIntent({
          protocolMajor: 1,
          requestId: "cr-1",
          workspaceId: WORKSPACE_ID,
          computerId: COMPUTER_ID,
        }),
      ),
    ).toEqual(["computer_restart"]);

    expect(
      scanPublicationKinds(
        encodeDaemonRuntimeUsageScanRequest({
          protocolMajor: 1,
          requestId: "us-1",
          workspaceId: WORKSPACE_ID,
          computerId: COMPUTER_ID,
          provider: "codex",
        }),
      ),
    ).toEqual(["usage_scan"]);

    expect(
      scanPublicationKinds(
        encodeRuntimeAuthIntent({
          protocolMajor: 1,
          workspaceId: WORKSPACE_ID,
          computerId: COMPUTER_ID,
          kind: "status_read",
          provider: "codex",
        }),
      ),
    ).toEqual(["runtime_auth"]);

    expect(
      scanPublicationKinds(
        encodeAgentSkillsListRequest({
          protocolMajor: 1,
          requestId: "sk-1",
          workspaceId: WORKSPACE_ID,
          computerId: COMPUTER_ID,
          agentId: AGENT_ID,
          provider: "codex",
        }),
      ),
    ).toEqual(["agent_skills"]);

    expect(
      scanPublicationKinds(
        encodePiChatRequest({
          workspaceId: WORKSPACE_ID,
          computerId: COMPUTER_ID,
          userId: "019b0381-7777-7777-8777-777777777777",
          requestId: "019b0381-8888-7888-8888-888888888888",
          command: { action: "list" },
        }),
      ),
    ).toEqual(["pi_chat"]);
  });

  test("preserves priority order when message body contains another discriminator and honors proto3 last-value-wins", () => {
    const crafted = sampleAgentMessage({ body: AGENT_ACTIVITY_PROBE_MESSAGE_TYPE });
    expect(scanPublicationKinds(crafted)).toEqual(["agent_activity_probe", "agent_message"]);

    const overriddenField8 = new Uint8Array([
      ...sampleAgentMessage(),
      0x42,
      0x05,
      0x6f,
      0x74,
      0x68,
      0x65,
      0x72,
    ]);
    expect(scanPublicationKinds(overriddenField8)).toEqual([]);

    expect(scanPublicationKinds(new Uint8Array())).toEqual([]);
    expect(scanPublicationKinds(new Uint8Array([0x42, 0x7f, 0x01]))).toEqual([]);
  });
});

describe("DaemonConnection fast-path publication dispatch", () => {
  test("delivers crafted AgentMessageDelivery whose body equals another discriminator", async () => {
    const centrifuge = gatedCentrifuge(WORKSPACE_ID, COMPUTER_ID);
    const transport = new DaemonConnection("wss://cloud.example", () => centrifuge.client);
    const delivered: string[] = [];
    transport.onAgentMessage((msg) => delivered.push(msg.body));
    await transport.start("secret", { workspaceId: WORKSPACE_ID, computerId: COMPUTER_ID });

    centrifuge.publish(sampleAgentMessage({ body: AGENT_ACTIVITY_PROBE_MESSAGE_TYPE }));

    expect(delivered).toEqual([AGENT_ACTIVITY_PROBE_MESSAGE_TYPE]);
  });

  test("logs malformed AgentContextViewRequest once and rejects wrong-workspace AgentMessageDelivery", async () => {
    const centrifuge = gatedCentrifuge(WORKSPACE_ID, COMPUTER_ID);
    const transport = new DaemonConnection("wss://cloud.example", () => centrifuge.client);
    await transport.start("secret", { workspaceId: WORKSPACE_ID, computerId: COMPUTER_ID });

    const badCtx = encodeAgentContextViewRequest({
      protocolMajor: 1,
      requestId: "ctxv_0123456789abcdef",
      workspaceId: WORKSPACE_ID,
      computerId: COMPUTER_ID,
      agentId: AGENT_ID,
      messageId: "msg-1",
      sessionId: "sess-1",
      maxBytes: 4096,
    } as never);
    const marker = Buffer.from("ctxv_", "latin1");
    const at = Buffer.from(badCtx).indexOf(marker);
    badCtx[at] = 0x58;

    const foreignMsg = sampleAgentMessage({
      workspaceId: "019b0381-9999-7999-8999-999999999999",
    });

    const { records } = await captureDaemonLogs(async () => {
      centrifuge.publish(badCtx);
      centrifuge.publish(foreignMsg);
    });

    const invalidCtxLogs = records.filter((record) =>
      record.message.join("").includes("Agent context view request invalid"),
    );
    const rejectedLogs = records.filter(
      (record) => record.properties.event === "daemon_control:rejected",
    );
    expect(invalidCtxLogs.length).toBe(1);
    expect(rejectedLogs.length).toBe(2);
  });

  test("invokes a throwing listener or lifecycle handler at most once when fast-path falls back", async () => {
    const centrifuge = gatedCentrifuge(WORKSPACE_ID, COMPUTER_ID);
    const transport = new DaemonConnection("wss://cloud.example", () => centrifuge.client);
    let messageCalls = 0;
    let upgradeCalls = 0;
    let configCalls = 0;
    transport.onAgentMessage(() => {
      messageCalls += 1;
      throw new Error("sync message listener failure");
    });
    transport.onAgentConfigSync(() => {
      configCalls += 1;
      throw new Error("sync config listener failure");
    });
    await transport.start("secret", {
      workspaceId: WORKSPACE_ID,
      computerId: COMPUTER_ID,
      requestUpgrade: () => {
        upgradeCalls += 1;
        throw new Error("sync upgrade failure");
      },
    });

    await captureDaemonLogs(async () => {
      centrifuge.publish(sampleAgentMessage());
      centrifuge.publish(
        encodeComputerUpgradeIntent({
          protocolMajor: 1,
          requestId: "u-sync-1",
          workspaceId: WORKSPACE_ID,
          computerId: COMPUTER_ID,
          target: "latest",
          expectedVersion: "1.0.0",
          releaseChannel: "stable",
        }),
      );
      centrifuge.publish(
        encodeAgentConfigSync({
          protocolMajor: 1,
          workspaceId: WORKSPACE_ID,
          computerId: COMPUTER_ID,
          agentId: AGENT_ID,
          revision: 1,
          provider: "codex",
          model: "default",
          reasoning: "balanced",
        }),
      );
    });

    expect(messageCalls).toBe(1);
    expect(upgradeCalls).toBe(1);
    expect(configCalls).toBe(1);
  });
});
