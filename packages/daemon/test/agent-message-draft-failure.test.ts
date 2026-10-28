import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "bun:test";
import { connectLocal } from "@lrm/coforge/local-client";
import { startAgentProxy } from "#src/agent-proxy";
import { AgentInboxStateMachine } from "#src/daemon-runtime/agent-inbox-state-machine";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { AgentMessageOperations } from "#src/daemon-runtime/agent-message-operations";
import { AgentStateDb } from "#src/persistence/agent-state-db";
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
    // The store fails the same way a damaged table would: `DROP TABLE` makes every draft
    // operation throw. Recreating it is the repair the "ordinary send" path relies on.
    const db = AgentStateDb.open(root, "agent");
    const breakDrafts = () => db.database.exec("DROP TABLE drafts");
    const repairDrafts = () =>
      db.database.exec(`CREATE TABLE IF NOT EXISTS drafts (
        target TEXT PRIMARY KEY, content TEXT NOT NULL, attachment_ids TEXT,
        idempotency_key TEXT NOT NULL, mentions TEXT, saved_at INTEGER NOT NULL,
        rehold_count INTEGER NOT NULL DEFAULT 0, seen_up_to_seq INTEGER, seen_exact_seqs TEXT
      )`);
    const reading = scenario.endsWith("lookup");
    const afterTransport =
      scenario === "accepted send cleanup" || scenario === "held draft refresh";
    const inbox = new AgentInboxStateMachine(new AgentMessageDraftStore(db));
    if (reading) breakDrafts();
    else expect(await inbox.draft("@ada")).toBeUndefined();
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
          if (afterTransport) breakDrafts();
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
    if (!reading && !afterTransport) breakDrafts();
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
      repairDrafts();
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
