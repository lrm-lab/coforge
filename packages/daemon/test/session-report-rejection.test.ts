import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentActivity } from "@lrm/coforge-sdk/internal";
import type {
  AgentRuntimeConfig,
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionOptions,
} from "@lrm/coforge-anvil";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";
import { captureDaemonLogs } from "./log-capture";

const tempRoot = realpathSync(tmpdir());
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: join(tempRoot, `coforge-session-report-rejection-${crypto.randomUUID()}`),
};
const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};
const START = new Date("2026-10-15T00:00:00.000Z");

afterAll(() => rm(connection.workspaceRoot, { recursive: true, force: true }));
afterEach(() => setSystemTime());

async function harness(options: {
  reportSessionSuperseded?: boolean;
  reportSessionUnexpectedError?: boolean;
  reportSessionMismatch?: boolean;
}) {
  setSystemTime(START);
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const sessions: Array<{
    options: AgentSessionOptions;
    notices: string[];
    inputs: string[];
    disposed: boolean;
    emit(event: AgentRuntimeEvent): void;
  }> = [];
  const activities: AgentActivity[] = [];
  const reportedLaunchIds: string[] = [];
  const acks: string[] = [];
  const cloud: string[] = [];
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession(sessionOptions: AgentSessionOptions) {
        const listeners = new Set<(event: AgentRuntimeEvent) => void>();
        const exitListeners = new Set<() => void>();
        const record = {
          options: sessionOptions,
          notices: [] as string[],
          inputs: [] as string[],
          disposed: false,
          emit(event: AgentRuntimeEvent) {
            for (const listener of listeners) listener(event);
          },
        };
        sessions.push(record);
        await sessionOptions.onSessionId?.("native-1");
        return {
          async sendMessage(text: string) {
            record.inputs.push(text);
            for (const listener of listeners) listener({ type: "completed", status: "completed" });
          },
          async notify(notice: string) {
            record.notices.push(notice);
            record.inputs.push(notice);
          },
          get hasLiveTurn() {
            return true;
          },
          readSessionIdentity: async () => ({ sessionId: "native-1", state: "resumable" as const }),
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async interrupt() {},
          onExit(listener) {
            exitListeners.add(listener);
            return () => exitListeners.delete(listener);
          },
          async dispose() {
            record.disposed = true;
            for (const listener of Array.from(exitListeners)) listener();
          },
        } satisfies AgentSession;
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        async requestAgentLaunchConfig() {
          return { agentApiKey: `sk_agent_${"a".repeat(43)}` };
        },
        async revokeAgentApiKey() {},
        sendAgentActivity(activity) {
          activities.push(activity);
        },
        async sendAgentControlResult() {},
        async reportAgentSession(report) {
          if (options.reportSessionSuperseded)
            throw Object.assign(new Error("Agent session launch was superseded"), {
              code: 409,
              category: "superseded",
            });
          if (options.reportSessionUnexpectedError)
            throw Object.assign(new Error("database connection failed"), {
              code: 503,
            });
          if (options.reportSessionMismatch)
            throw Object.assign(new Error("Agent Session snapshot is not authorized"), {
              code: 403,
              category: "session_mismatch",
            });
          reportedLaunchIds.push(report.launchId);
          cloud.push(`session ${report.launchId}`);
        },
        async sendAgentDeliveryAck(ack) {
          acks.push(ack.deliveryId);
        },
        async sendAgentDeliveryRejection() {},
        async sendAgentMentionDeliveryTransition() {},
        async sendAgentMentionDeliveryTerminalError() {},
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
  );
  await runtime.start(connection);
  await runtime.handleAgentStart({
    protocolMajor: 1,
    requestId: "start-1",
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId: "agent-a",
    ...config,
    controlEpoch: 1,
    launchId: "launch-1",
  });
  const deliver = (sequence: number) =>
    runtime.handleAgentMessage({
      protocolMajor: 1,
      requestId: `request-${sequence}`,
      messageId: `message-${sequence}`,
      deliveryId: `delivery-${sequence}`,
      sequence,
      workspaceId: connection.workspaceId,
      conversationId: "conversation-a",
      agentId: "agent-a",
      body: `body-${sequence}`,
      method: "agent:v1:message:deliver",
      target: "#general",
      mentionsAgent: true,
    });
  return {
    runtime,
    sessions,
    activities,
    reportedLaunchIds,
    acks,
    cloud,
    deliver,
  };
}

test("a superseded session report stops the launched provider process and marks the launch failed without retry", async () => {
  let launchError: unknown;
  const { records } = await captureDaemonLogs(async () => {
    try {
      await harness({ reportSessionSuperseded: true });
    } catch (error) {
      launchError = error;
    }
  });
  expect(launchError).toBeDefined();
  expect(records.map((record) => record.properties.event)).toContain(
    "agent_session:report_superseded",
  );
  expect(records.map((record) => record.properties.event)).not.toContain(
    "agent_control:launch_retry_scheduled",
  );
});

test("an unexpected non-verify session report error (e.g. database error) keeps the launched provider process serving", async () => {
  const { result: h, records } = await captureDaemonLogs(() =>
    harness({ reportSessionUnexpectedError: true }),
  );
  try {
    h.sessions[0]!.emit({ type: "progress" });
    await h.deliver(1);

    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]!.disposed).toBe(false);
    expect(h.acks).toContain("delivery-1");
    expect(records.map((record) => record.properties.event)).toContain(
      "agent_session:report_deferred",
    );
    expect(records.map((record) => record.properties.event)).not.toContain(
      "agent_session:report_superseded",
    );
  } finally {
    await h.runtime.stop();
  }
});

test("a session_mismatch session report error keeps the launched provider process serving", async () => {
  const { result: h, records } = await captureDaemonLogs(() =>
    harness({ reportSessionMismatch: true }),
  );
  try {
    h.sessions[0]!.emit({ type: "progress" });
    await h.deliver(1);

    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]!.disposed).toBe(false);
    expect(h.acks).toContain("delivery-1");
    expect(records.map((record) => record.properties.event)).toContain(
      "agent_session:report_deferred",
    );
    expect(records.map((record) => record.properties.event)).not.toContain(
      "agent_session:report_superseded",
    );
  } finally {
    await h.runtime.stop();
  }
});
