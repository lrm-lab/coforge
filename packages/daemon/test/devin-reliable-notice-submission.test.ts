import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevinProvider } from "@lrm/coforge-anvil/devin";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { settleForwardedTaskRead } from "#src/daemon-runtime/agent-history-read";
import { unreadNoticeComposer } from "#src/daemon-runtime/important-unread-compose";
import { composeImportantUnreadReminder } from "#src/daemon-runtime/important-unread-wiring";
import { fixturePerTurnHost } from "../../anvil/test/fixtures/runtime-host";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";
import { delivery } from "./fixtures/attention-delivery";
import { captureDaemonLogs } from "./log-capture";

test("a reliable task notice queued in real Devin ACP is withdrawn before the prompt when read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-devin-reliable-"));
  const log = join(directory, "rpc.jsonl");
  const release = join(directory, "release");
  try {
    const session = await new DevinProvider({
      command: [process.execPath, anvilRuntimeFixtures.devin],
      host: {
        processTreeSpawner: fixturePerTurnHost.processTreeSpawner,
        clientInfo: { name: "daemon-devin-fixture", version: "1" },
        buildCatalogEnvironment: () => ({}),
        createReplyIntentScanner: () => ({
          feed: () => undefined,
          complete: () => {},
          reset: () => [],
        }),
        isShellToolName: (name) => name === "bash",
        versionReader: async () => "3000.11.228",
        buildEnvironment: () => ({
          DEVIN_FIXTURE_LOG: log,
          DEVIN_FIXTURE_RELEASE: release,
        }),
      },
    }).createAgentSession({ agentWorkspaceDirectory: directory, instructions: "" });
    try {
      const target = "#runtime-optimization:#100";
      const stale = {
        ...delivery("stale", "human", "ada"),
        target,
        taskDiscussion: true,
        sequence: 46,
        body: "stale preview",
      };
      const fresh = {
        ...delivery("fresh", "human", "ada"),
        target,
        sequence: 55,
        body: "fresh preview",
      };
      const { records } = await captureDaemonLogs(async (running) => {
        let attention!: AgentMessageAttentionIndex;
        const reminder = composeImportantUnreadReminder({
          session: () => session,
          store: { save: () => {}, clear: () => {}, list: () => [] },
          eligibility: (...args) => attention.noticeEligibility(...args),
          unread: (agentId) => attention.unreadDeliveries(agentId),
          report: () => {},
          compose: unreadNoticeComposer({
            eligibility: (...args) => attention.noticeEligibility(...args),
            queued: () => [],
            prefix: () => "",
            previewedInFull: () => false,
          }),
          now: Date.now,
        });
        attention = new AgentMessageAttentionIndex(
          stale.workspaceId,
          { session: () => session },
          async () => {},
          () => {},
          {
            shouldHold: () => false,
            enqueue: () => {},
            busy: () => {},
            unread: (messages) => reminder.observeDeliveries(messages),
          },
        );
        await session.sendMessage("hold until released");
        const queued = attention.receive(stale);
        const timeout = Date.now() + 1_000;
        while (
          !running.some(
            ({ properties }) => properties.event === "agent.inbox_notice.admission_requested",
          )
        ) {
          if (Date.now() >= timeout) throw new Error("reliable writer did not request admission");
          await Bun.sleep(5);
        }
        settleForwardedTaskRead(
          attention,
          stale.agentId,
          { unread: "true" },
          {
            consumptionScope: {
              agentId: stale.agentId,
              target,
              conversationId: stale.conversationId,
              channelType: "thread",
            },
            messages: [],
            hasOlder: false,
            hasNewer: false,
            moreUnread: false,
            modelSeenUpToSeq: 54,
          },
        );
        await Bun.write(release, "");
        await queued;
        await attention.receive(fresh);
      });
      const prompts = (await Bun.file(log).text())
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as { method: string; params?: { prompt?: { text: string }[] } },
        )
        .filter(({ method }) => method === "session/prompt")
        .map(({ params }) => params?.prompt?.[0]?.text);
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toBe("hold until released");
      expect(prompts[1]).toContain("fresh preview");
      const events = records.map(({ properties }) => properties);
      const reliable = events.find(
        ({ event, source }) =>
          event === "agent.inbox_notice.admission_requested" && source === "reliable",
      );
      expect(reliable?.attempt_id).toBeString();
      expect(events).toContainEqual(
        expect.objectContaining({
          event: "agent.inbox_notice.submission_decision",
          attempt_id: reliable?.attempt_id,
          boundary: "prompt",
          outcome: "suppress",
        }),
      );
      expect(
        events.filter(({ event }) => event === "agent.inbox_notice.acp_prompt_written"),
      ).toEqual([expect.objectContaining({ source: "indexed", request_id: fresh.requestId })]);
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
