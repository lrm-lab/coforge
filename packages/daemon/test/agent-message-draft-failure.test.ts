import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "bun:test";
import { connectLocal } from "@lrm/coforge/local-client";
import { startAgentProxy } from "#src/agent-proxy";
import { AgentInboxStateMachine } from "#src/daemon-runtime/agent-inbox-state-machine";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { AgentMessageOperations } from "#src/daemon-runtime/agent-message-operations";
import { AgentMessageDraftStore } from "#src/persistence/agent-message-draft-store";

test.each([
  "ordinary send",
  "thread confirmation",
  "new draft lookup",
  "saved draft lookup",
  "accepted send cleanup",
  "held draft refresh",
])("draft storage failure during %s keeps the correct issuance verdict", async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), "coforge-draft-failure-"));
  let proxy: ReturnType<typeof startAgentProxy> | undefined;
  try {
    const identity = encodeURIComponent(
      String(process.geteuid?.() ?? userInfo().username),
    ).replaceAll(".", "%2E");
    const path = join(
      root,
      `coforge-cli-attested-send-${identity}`,
      "agent",
      "continue-state.json",
    );
    const reading = scenario.endsWith("lookup");
    const afterTransport =
      scenario === "accepted send cleanup" || scenario === "held draft refresh";
    if (afterTransport) {
      await mkdir(dirname(path), { recursive: true });
    } else if (reading) {
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, "invalid saved draft data");
    } else {
      // A directory at the file destination makes replacement fail on every OS,
      // while the initial lookup still reports no file.
      await mkdir(path, { recursive: true });
    }
    const inbox = new AgentInboxStateMachine(new AgentMessageDraftStore("agent", root));
    if (!reading) expect(await inbox.draft("@ada")).toBeUndefined();
    const attention = new AgentMessageAttentionIndex(
      "workspace",
      { session: () => undefined },
      async () => {},
    );
    if (scenario === "thread confirmation")
      attention.recordReadContext("agent", "@ada:12345678", 1);
    let sends = 0;
    const operations = new AgentMessageOperations({
      connection: { workspaceId: "workspace", computerId: "computer" },
      attention,
      inbox: () => inbox,
      transport: {
        agentMessage: async (request) => {
          sends += 1;
          if (afterTransport) await Bun.write(path, "invalid saved draft data");
          if (scenario === "held draft refresh")
            return {
              protocolMajor: 1,
              idempotencyKey: request.idempotencyKey,
              accepted: false,
              state: "held",
              attentionCount: 0,
              messages: [],
            };
          return {
            protocolMajor: 1,
            idempotencyKey: request.idempotencyKey,
            accepted: true,
            attentionCount: 0,
            messages: [],
          };
        },
      },
      reportFreshnessHold: () => {},
    });
    proxy = startAgentProxy({
      runtime: {
        agentMessage: (_context, request, key) =>
          operations.handle("agent", request, request.target, key),
      },
    });
    const token = proxy.issue("agent", `sk_agent_${"a".repeat(43)}`);
    const client = connectLocal("", token, proxy.url, "");
    const error = await client
      .send("@ada", "new reply", { sendDraft: scenario === "saved draft lookup" })
      .catch((error: unknown) => error);
    expect(sends).toBe(afterTransport ? 1 : 0);
    if (afterTransport) {
      expect(error).toMatchObject({
        code: "SERVER_5XX",
        draftSaved: true,
        proxy: { failureClass: "unclassified" },
      });
      expect(String(error)).not.toContain("made no send request");
    } else {
      expect(error).toMatchObject({
        code: "SEND_DRAFT_STORAGE_FAILED",
        draftSaved: false,
        retryable: false,
        proxy: {
          failureClass: "local_precondition",
          responseStarted: false,
          responseComplete: false,
        },
      });
    }
    expect(String(error)).not.toContain(root);
    if (scenario === "ordinary send") {
      await rm(path, { recursive: true });
      expect(await client.send("@ada", "reply after storage repair")).toMatchObject({
        accepted: true,
      });
      expect(sends).toBe(1);
    }
  } finally {
    proxy?.close();
    await rm(root, { recursive: true, force: true });
  }
});
