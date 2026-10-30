import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { type AgentRuntimeConfig } from "@lrm/coforge-anvil";
import type { WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { type AgentMessageRequest, type TaskRequest } from "@lrm/coforge-sdk/internal";
import { createMessageHarness } from "./fixtures/message-harness";
import { messageRecord } from "./fixtures/message-record";

// macOS tmpdir lives under /var, a symlink; the state store rejects linked ancesto
const tempRoot = realpathSync(tmpdir());
/** This process's own root for the Agents' CLI temporary state (see `cli-temp-state.preload.ts`).
 * Without it the stores fall back to the machine-wide `tmpdir()` root, which this file clears
 * before every test, so it refuses to run rather than delete another process's drafts. */
function cliTempStateRoot(
  variable: "COFORGE_CLI_CONSUMED_SEQ_STATE_DIR" | "COFORGE_CLI_DRAFT_STATE_DIR",
) {
  const root = process.env[variable];
  if (!root) throw new Error(`${variable} is unset: run these tests from packages/daemon`);
  return root;
}
const userDirectoryName = encodeURIComponent(
  String(process.geteuid?.() ?? userInfo().username),
).replaceAll(".", "%2E");
/** Where the daemon's consumed cursor lands when a test passes no state directory: the temporary
 * state root (`COFORGE_CLI_CONSUMED_SEQ_STATE_DIR ?? tmpdir()`), under CoForge's own directory
 * name. Only a legacy store lives there now: the live cursor is in the per-Agent state database, and
 * a leftover file would be migrated into it. */
const CONSUMED_SEQ_ROOT = join(
  cliTempStateRoot("COFORGE_CLI_CONSUMED_SEQ_STATE_DIR"),
  `coforge-cli-consumed-seq-${userDirectoryName}`,
);
/** Where the daemon's per-Agent send drafts land in tests: the temporary state root
 * (`COFORGE_CLI_DRAFT_STATE_DIR ?? tmpdir()`). Only a legacy store lives there now: the live
 * drafts are in the per-Agent state database, and a leftover file would be migrated into it. */
const DRAFT_ROOT = join(
  cliTempStateRoot("COFORGE_CLI_DRAFT_STATE_DIR"),
  `coforge-cli-attested-send-${userDirectoryName}`,
);
const workspaceRoot = join(tempRoot, `coforge-daemon-runtime-${crypto.randomUUID()}`);
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));

const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

// The daemon's consumed cursor is durable now, in the per-Agent state database under the daemon
// state directory — and runtimes in this file that name no state directory share the default one.
// Left alone, one test's reviewed boundary would reach the next and suppress a delivery its Agent
// was never shown — correct in production, wrong here. Every test starts from a clean cursor,
// exactly as it already starts from a fresh runtime.
beforeEach(async () => {
  await rm(CONSUMED_SEQ_ROOT, { recursive: true, force: true });
  await rm(DRAFT_ROOT, { recursive: true, force: true });
  await rm(".coforge-daemon-state", { recursive: true, force: true });
});

const messageHarness = createMessageHarness({ connection, config });

describe("Agent Task freshness", () => {
  test("reviewer-isolation holds are repeatable without reading, forwarding, or consuming", async () => {
    const messageCalls: AgentMessageRequest[] = [];
    const taskCalls: TaskRequest[] = [];
    const harness = await messageHarness(
      async (request) => {
        messageCalls.push(request);
        return {
          protocolMajor: 1,
          idempotencyKey: request.idempotencyKey,
          accepted: true,
          attentionCount: 0,
          messages: [],
        };
      },
      async (request) => {
        taskCalls.push(request);
        return { idempotencyKey: request.idempotencyKey, tasks: [] };
      },
    );
    try {
      await harness.deliver(4, "#tasks");
      const command = {
        operation: "claim" as const,
        idempotencyKey: "claim-withheld",
        target: "#tasks",
        number: 7,
        freshnessContextMode: "withheld" as const,
      };

      expect(await harness.runtime.agentTask(harness.context, command, harness.apiKey)).toEqual({
        tasks: [],
        state: "held",
        freshnessContextMode: "withheld",
        withheldMessageCount: 1,
      });
      expect(await harness.runtime.agentTask(harness.context, command, harness.apiKey)).toEqual({
        tasks: [],
        state: "held",
        freshnessContextMode: "withheld",
        withheldMessageCount: 1,
      });
      expect(messageCalls).toHaveLength(0);
      expect(taskCalls).toHaveLength(0);
    } finally {
      await harness.runtime.stop();
    }
  });

  test("a claim on a target the Agent drained with a check reads no context first", async () => {
    const messageCalls: AgentMessageRequest[] = [];
    const harness = await messageHarness(
      async (request) => {
        messageCalls.push(request);
        return {
          idempotencyKey: request.idempotencyKey,
          accepted: true,
          attentionCount: 0,
          hasMore: false,
          messages: request.operation === "check" ? [messageRecord(4, "@ada", "#tasks")] : [],
        };
      },
      async (request) => ({ idempotencyKey: request.idempotencyKey, tasks: [] }),
    );
    try {
      await harness.deliver(4, "#tasks");
      await harness.runtime.agentMessage(
        harness.context,
        { idempotencyKey: "check", context: harness.context, operation: "check" },
        harness.apiKey,
      );
      await harness.runtime.agentTask(
        harness.context,
        { operation: "claim", idempotencyKey: "claim", target: "#tasks", number: 7 },
        harness.apiKey,
      );
      expect(messageCalls.map(({ operation }) => operation)).toEqual(["check"]);
    } finally {
      await harness.runtime.stop();
    }
  });

  test("claim isolates exact-target freshness, bounds pending reads, and preserves Task results", async () => {
    const messageCalls: AgentMessageRequest[] = [];
    const upstream = {
      protocolMajor: 1,
      idempotencyKey: "claim-forward",
      tasks: [],
      claims: [],
      assignmentReceipts: [
        {
          messageId: "receipt-message",
          content: "claimed",
          assignee: "@agent-a",
          state: "started" as const,
        },
      ],
    };
    const harness = await messageHarness(
      async (request) => {
        messageCalls.push(request);
        return {
          protocolMajor: 1,
          idempotencyKey: request.idempotencyKey,
          accepted: true,
          attentionCount: 1,
          messages: [messageRecord(9, "@alice", request.target)],
        };
      },
      async () => upstream,
    );
    try {
      await harness.deliver(3, "#unrelated");
      const firstTouch = await harness.runtime.agentTask(
        harness.context,
        { operation: "claim", idempotencyKey: "first-touch", target: "#tasks", number: 7 },
        harness.apiKey,
      );
      expect(firstTouch).toMatchObject({ state: "held", freshnessContextMode: "inline" });
      expect(messageCalls[0]).toMatchObject({ target: "#tasks", limit: 3 });

      const result = await harness.runtime.agentTask(
        harness.context,
        { operation: "claim", idempotencyKey: "claim-forward", target: "#tasks", number: 7 },
        harness.apiKey,
      );
      expect(result).toBe(upstream);
    } finally {
      await harness.runtime.stop();
    }
  });

  test("an unavailable exact-target pending read holds instead of forwarding or consuming", async () => {
    const messageCalls: AgentMessageRequest[] = [];
    const taskCalls: TaskRequest[] = [];
    const harness = await messageHarness(
      async (request) => {
        messageCalls.push(request);
        return {
          protocolMajor: 1,
          idempotencyKey: request.idempotencyKey,
          accepted: messageCalls.length > 1,
          attentionCount: 1,
          messages: [],
        };
      },
      async (request) => {
        taskCalls.push(request);
        return { idempotencyKey: request.idempotencyKey, tasks: [] };
      },
    );
    try {
      await harness.deliver(5, "#tasks");
      const command = {
        operation: "update" as const,
        idempotencyKey: "update",
        target: "#tasks",
        number: 7,
      };

      expect(await harness.runtime.agentTask(harness.context, command, harness.apiKey)).toEqual({
        tasks: [],
        state: "held",
        freshnessContextMode: "inline",
        heldMessages: [],
        newMessageCount: 1,
      });
      expect(messageCalls[0]).toMatchObject({
        target: "#tasks",
        fromSequence: 5,
        throughSequence: 5,
        limit: 3,
      });
      expect(taskCalls).toHaveLength(0);

      await harness.runtime.agentTask(harness.context, command, harness.apiKey);
      expect(messageCalls).toHaveLength(2);
      expect(taskCalls).toHaveLength(0);
    } finally {
      await harness.runtime.stop();
    }
  });

  test("amend bypasses local freshness preflight and forwards the complete result", async () => {
    const messageCalls: AgentMessageRequest[] = [];
    const upstream = {
      protocolMajor: 1,
      idempotencyKey: "amend",
      tasks: [],
      history: [],
      resourceFollowup: {
        id: "followup-a",
        ownerAgentId: "agent-a",
        owner: "@agent-a",
        fireAt: "2026-09-10T12:00:00.000Z",
        messageId: "message-a",
        conversationId: "conversation-a",
      },
    };
    const harness = await messageHarness(
      async (request) => {
        messageCalls.push(request);
        throw new Error("amend must not read messages");
      },
      async () => upstream,
    );
    try {
      await harness.deliver(2, "#tasks");
      const result = await harness.runtime.agentTask(
        harness.context,
        { operation: "amend", idempotencyKey: "amend", target: "#tasks", number: 7, title: "new" },
        harness.apiKey,
      );
      expect(result).toBe(upstream);
      expect(messageCalls).toHaveLength(0);
    } finally {
      await harness.runtime.stop();
    }
  });
});
