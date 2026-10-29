import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { AgentControl, type AgentControlAgent } from "#src/server/agents/agent-control.server";
import {
  decodeAgentStartIntent,
  decodeAgentStopIntent,
  decodeAgentWorkspaceResetRequest,
} from "@lrm/coforge-sdk/internal";
import { pendingOpStore } from "./helpers/agent-control-store";
import { coordinatorChangeNotice } from "#src/server/conversations/channel-coordination.server";

test("a coordinator notice is one sentence naming who changed it", () => {
  expect(coordinatorChangeNotice("team", "Frank An", undefined, "lead")).toBe(
    "Frank An made @lead the coordinator of #team",
  );
  expect(coordinatorChangeNotice("team", "Frank An", "old", "lead")).toBe(
    "Frank An made @lead the coordinator of #team (replacing @old)",
  );
  expect(coordinatorChangeNotice("team", "Frank An", "old", undefined)).toBe(
    "Frank An removed @old as coordinator of #team",
  );
});

/** Real channel settings, delivery/read boundaries and restart recovery against scratch PostgreSQL. */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

async function fixture() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID();
  const owner = await db.user.create({
    data: { username: `coord-${suffix}`, displayName: "Coordinator test" },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: suffix,
      name: "Coordinator boundaries",
      members: { create: { userId: owner.id, role: "owner" } },
    },
  });
  const createAgent = (name: string) =>
    db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        name,
        displayName: name,
        description: "Helps the team",
        runtimeConfig: {},
      },
    });
  const lead = await createAgent("coforge-lead");
  const worker = await createAgent("worker");
  const channels = new PublicChannels(
    db,
    { execute: async (_scope, persist) => persist() },
    { publish: async () => {}, publishJson: async () => {}, broadcast: async () => {} },
    undefined,
    { messageAvailable: async () => {}, memberChanged: async () => {} },
  );
  const team = await channels.create(workspace.id, owner.id, "team");
  const other = await channels.create(workspace.id, owner.id, "other");
  for (const channel of [team, other])
    await channels.addMembers(workspace.id, { userId: owner.id }, channel.id, {
      userIds: [],
      agentIds: [lead.id, worker.id],
    });
  const repo = new PrismaDirectConversationRepository(db);
  const set = (id: string | null, channelId = team.id) =>
    channels.setCoordinator(workspace.id, owner.id, channelId, id);
  const send = (body: string, channelId = team.id) =>
    channels.send({
      workspaceId: workspace.id,
      userId: owner.id,
      channelId,
      idempotencyKey: crypto.randomUUID(),
      body,
    });
  return {
    db,
    owner,
    workspace,
    lead,
    worker,
    team,
    other,
    channels,
    repo,
    set,
    send,
    async cleanup() {
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.computer.deleteMany({ where: { ownerId: owner.id } });
      await db.user.delete({ where: { id: owner.id } });
      await db.$disconnect();
    },
  };
}

test.skipIf(!connectionString)(
  "revocation persists a system delivery even for a stopped, muted former coordinator",
  async () => {
    const f = await fixture();
    try {
      await f.set(f.lead.id);
      await f.repo.drainAgentEvents(f.workspace.id, f.lead.id);
      await f.db.agent.update({ where: { id: f.lead.id }, data: { stoppedAt: new Date() } });
      const member = await f.db.conversationMember.update({
        where: { conversationId_agentId: { conversationId: f.team.id, agentId: f.lead.id } },
        data: { channelMuted: true },
      });
      await f.set(null);
      const recovery = await f.repo.readAgentRecoveryContext(f.workspace.id, f.lead.id);
      expect(recovery.resumeMessages).toHaveLength(1);
      const notice = recovery.resumeMessages[0]!;
      expect(notice.latestSenderKind).toBe("system");
      expect(notice.body).toEndWith(
        "Coordinator test removed @coforge-lead as coordinator of #team",
      );
      expect(notice.body).toStartWith("[CoForge current channel role: member; coordinator=none]");
      expect(recovery.unreadSummary["#team"]).toBe(1);
      expect(
        (await f.db.agent.findUniqueOrThrow({ where: { id: f.lead.id } })).stoppedAt,
      ).not.toBeNull();
      expect(
        await f.db.conversationMember.findUniqueOrThrow({ where: { id: member.id } }),
      ).toMatchObject({
        channelMuted: true,
        agentReadThroughSequence: member.agentReadThroughSequence,
      });
      const count = await f.db.message.count({ where: { conversationId: f.team.id } });
      await f.set(null);
      expect(await f.db.message.count({ where: { conversationId: f.team.id } })).toBe(count);
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "a rapid coordinator switch projects today's role onto old notices, history and thread reads",
  async () => {
    const f = await fixture();
    try {
      await f.set(f.lead.id);
      const original = await f.db.message.findFirstOrThrow({
        where: { conversationId: f.team.id, senderMemberId: null },
        orderBy: { sequence: "desc" },
      });
      await f.set(f.worker.id);
      const lead = await f.repo.drainAgentEvents(f.workspace.id, f.lead.id);
      const worker = await f.repo.drainAgentEvents(f.workspace.id, f.worker.id);
      expect(lead.messages).toHaveLength(2);
      for (const message of lead.messages)
        expect(message.body).toStartWith(
          "[CoForge current channel role: member; coordinator=@worker]",
        );
      expect(worker.messages).toHaveLength(1);
      expect(worker.messages[0]!.body).toStartWith(
        "[CoForge current channel role: coordinator; coordinator=@worker]",
      );
      const history = await f.repo.readMessagesPage(f.workspace.id, f.lead.id, "#team", {
        around: original.id,
      });
      expect(history.messages.find((message) => message.id === original.id)?.body).toStartWith(
        "[CoForge current channel role: member; coordinator=@worker]",
      );
      const root = await f.send("Please investigate this");
      const reply = await f.channels.send({
        workspaceId: f.workspace.id,
        userId: f.owner.id,
        channelId: f.team.id,
        threadRootId: root.id,
        idempotencyKey: crypto.randomUUID(),
        body: "A detail in the thread",
      });
      const thread = await f.repo.readMessagesPage(f.workspace.id, f.lead.id, `#team:${root.id}`);
      expect(thread.messages.find((message) => message.id === reply.id)?.body).toStartWith(
        "[CoForge current channel role: member; coordinator=@worker]",
      );
      expect((await f.db.message.findUniqueOrThrow({ where: { id: original.id } })).body).toBe(
        original.body,
      );
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "new repository instances recover the current channel role without restoring it in another channel",
  async () => {
    const f = await fixture();
    try {
      await f.set(f.lead.id);
      await f.set(f.lead.id, f.other.id);
      await f.repo.drainAgentEvents(f.workspace.id, f.lead.id);
      await f.set(null);
      const fresh = new PrismaDirectConversationRepository(f.db);
      const recovery = await fresh.readAgentRecoveryContext(f.workspace.id, f.lead.id);
      expect(recovery.resumeMessages[0]?.body).toStartWith(
        "[CoForge current channel role: member; coordinator=none]",
      );
      await fresh.drainAgentEvents(f.workspace.id, f.lead.id);
      const post = await f.send("Another ordinary message");
      const otherPost = await f.send("Another channel", f.other.id);
      const events = await fresh.drainAgentEvents(f.workspace.id, f.lead.id);
      expect(events.messages.find((message) => message.id === post.id)?.body).toStartWith(
        "[CoForge current channel role: member; coordinator=none]",
      );
      expect(events.messages.find((message) => message.id === otherPost.id)?.body).toStartWith(
        "[CoForge current channel role: coordinator; coordinator=@coforge-lead]",
      );
      expect((await f.db.message.findUniqueOrThrow({ where: { id: post.id } })).body).toBe(
        "Another ordinary message",
      );
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "a revocation from before this fix has a current member context without a role-change notice",
  async () => {
    const f = await fixture();
    try {
      const post = await f.send("Work after a legacy revocation");
      const read = await f.repo.readMessagesPage(f.workspace.id, f.lead.id, "#team");
      expect(read.messages.find((message) => message.id === post.id)?.body).toStartWith(
        "[CoForge current channel role: member; coordinator=none]",
      );
      expect(
        await f.db.message.count({ where: { conversationId: f.team.id, senderMemberId: null } }),
      ).toBe(0);
    } finally {
      await f.cleanup();
    }
  },
);

for (const action of ["start", "restart", "reset-session", "full-reset"] as const)
  test.skipIf(!connectionString)(
    `${action} carries revoked coordination through the real recovery reader and Start codec`,
    async () => {
      const f = await fixture();
      try {
        await f.set(f.lead.id);
        await f.repo.drainAgentEvents(f.workspace.id, f.lead.id);
        await f.set(null);
        const { store } = pendingOpStore({
          id: f.lead.id,
          workspaceId: f.workspace.id,
          computerId: crypto.randomUUID(),
          ownerId: f.owner.id,
          visibility: "public",
          runtimeConfig: {
            runtime: "pi",
            provider: { kind: "default" },
            model: "",
            modelProvider: "",
            reasoning: "",
          },
          identity: { sessionId: "old-coordinator-session", state: "resumable" },
          state: null,
        } satisfies AgentControlAgent);
        const starts: ReturnType<typeof decodeAgentStartIntent>[] = [];
        const control: AgentControl = new AgentControl(
          store,
          {
            async publish(_channel, bytes) {
              let stop: ReturnType<typeof decodeAgentStopIntent> | undefined;
              let reset: ReturnType<typeof decodeAgentWorkspaceResetRequest> | undefined;
              try {
                stop = decodeAgentStopIntent(bytes);
              } catch {
                /* Different control method. */
              }
              if (stop) {
                await control.result(stop, {
                  ...stop,
                  provider: stop.provider!,
                  epoch: stop.controlEpoch!,
                  phase: "stopped",
                  sequence: 1,
                });
                return;
              }
              try {
                reset = decodeAgentWorkspaceResetRequest(bytes);
              } catch {
                /* Start follows. */
              }
              if (reset) {
                await control.result(reset, { ...reset, phase: "workspace-reset", sequence: 2 });
                return;
              }
              const start = decodeAgentStartIntent(bytes);
              starts.push(start);
              await control.authorizeLaunch(start);
              await control.result(start, {
                ...start,
                epoch: start.controlEpoch!,
                launchId: start.launchId!,
                phase: "started",
                sequence: 3,
                identity: { sessionId: "active-session", state: "empty" },
              });
            },
          },
          { run: async (_id, work) => work() },
          { timeoutMs: 100 },
          undefined,
          undefined,
          f.repo,
        );
        await control.execute({
          userId: f.owner.id,
          workspaceId: f.workspace.id,
          agentId: f.lead.id,
          requestId: `${action}-${crypto.randomUUID()}`,
          action,
          confirmed: true,
        });
        expect(starts).toHaveLength(1);
        expect(starts[0]!.resumeMessages?.[0]?.body).toStartWith(
          "[CoForge current channel role: member; coordinator=none]",
        );
        expect(starts[0]!.resumeMessages?.[0]?.body).toEndWith(
          "Coordinator test removed @coforge-lead as coordinator of #team",
        );
        expect(starts[0]!.sessionId).toBe(
          action === "start" || action === "restart" ? "old-coordinator-session" : undefined,
        );
        expect(
          (await f.db.conversation.findUniqueOrThrow({ where: { id: f.team.id } }))
            .coordinatorAgentId,
        ).toBeNull();
      } finally {
        await f.cleanup();
      }
    },
  );

test.skipIf(!connectionString)(
  "a failed live publication leaves exactly one canonical role update for restart recovery",
  async () => {
    const f = await fixture();
    try {
      const computer = await f.db.computer.create({
        data: { ownerId: f.owner.id, machineId: crypto.randomUUID() },
      });
      await f.db.agent.update({ where: { id: f.lead.id }, data: { computerId: computer.id } });
      let attempts = 0;
      const channels = new PublicChannels(f.db, undefined, {
        async publish() {
          attempts++;
          throw new Error("offline");
        },
        publishJson: async () => {},
        broadcast: async () => {},
      });
      await channels.setCoordinator(f.workspace.id, f.owner.id, f.team.id, f.lead.id);
      expect(attempts).toBe(1);
      await channels.setCoordinator(f.workspace.id, f.owner.id, f.team.id, f.lead.id);
      expect(attempts).toBe(1);
      const pending = await f.repo.readPendingAgentDeliveries(f.workspace.id, f.lead.id);
      const recovery = await f.repo.readAgentRecoveryContext(f.workspace.id, f.lead.id);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.messageId).toBe(recovery.resumeMessages[0]!.messageId);
      expect(pending[0]!.body).toStartWith(
        "[CoForge current channel role: coordinator; coordinator=@coforge-lead]",
      );
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "a departed coordinator has no current authority and cannot be reselected",
  async () => {
    const f = await fixture();
    try {
      await f.set(f.lead.id);
      await f.db.conversationMember.update({
        where: { conversationId_agentId: { conversationId: f.team.id, agentId: f.lead.id } },
        data: { leftAt: new Date() },
      });
      const history = await f.repo.readMessagesPage(f.workspace.id, f.worker.id, "#team");
      expect(history.messages[0]!.body).toStartWith(
        "[CoForge current channel role: member; coordinator=none]",
      );
      const count = await f.db.message.count({ where: { conversationId: f.team.id } });
      await expect(f.set(f.lead.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await f.db.message.count({ where: { conversationId: f.team.id } })).toBe(count);
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "production construction announces role notices without an injected realtime port",
  async () => {
    const f = await fixture();
    try {
      // The open page's signal goes to the channel (`publishJson`); the sidebar row's goes to
      // each recipient's own channel (`broadcast`), as of task #285.
      const events: unknown[] = [];
      const broadcasts: unknown[] = [];
      const channels = new PublicChannels(f.db, undefined, {
        publish: async () => {},
        async publishJson(_channel, event) {
          events.push(event);
        },
        async broadcast(_channels, event) {
          broadcasts.push(event);
        },
      });
      await channels.setCoordinator(f.workspace.id, f.owner.id, f.team.id, f.lead.id);
      expect(events).toEqual([
        expect.objectContaining({ type: "message.available.v1", conversationId: f.team.id }),
      ]);
      expect(broadcasts).toEqual([
        expect.objectContaining({ type: "conversation.activity.v1", conversationId: f.team.id }),
      ]);
      // Setting the same coordinator again writes and announces nothing.
      await channels.setCoordinator(f.workspace.id, f.owner.id, f.team.id, f.lead.id);
      expect(events).toHaveLength(1);
      expect(broadcasts).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  },
);
