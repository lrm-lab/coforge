import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import type { TrustedAgentActivity } from "#src/server/db/repositories/agent-activity.repositories.server";
import { AgentActivityRepository } from "#src/server/db/repositories/agent-activity.repositories.server";
import { PrismaUsageLimitEventRepository } from "#src/server/db/repositories/usage-limit-events.repositories.server";
import {
  observeUsageLimitActivity,
  UsageLimitEvents,
  type UsageLimitAnnouncer,
} from "#src/server/usage-limits/usage-limit-events.server";
import { sweepUsageLimitEvents } from "#src/server/usage-limits/usage-limit-sweep.server";
import type { UsageLimitChangedEvent } from "#src/features/usage-limits/usage-limit-events";
import { m } from "#src/paraglide/messages";
import { AppError } from "#src/lib/app-error";

/**
 * The usage-limit event store, its Activity hook and its sweep against local
 * PostgreSQL (task #611): open/merge/announce on quota reports only, the four
 * close reasons, recovery evidence, the owner/admin-only reads and marks,
 * and the push audience.
 *
 * Skipped unless `USAGE_LIMIT_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.USAGE_LIMIT_TEST_DATABASE_URL;

function activity(overrides: Partial<TrustedAgentActivity> = {}): TrustedAgentActivity {
  return {
    protocolMajor: 1,
    requestId: "req",
    workspaceId: "",
    agentId: "",
    computerId: "",
    launchId: "launch",
    clientSeq: 1,
    detailKind: "runtime_error",
    level: "error",
    detail: "",
    observedAtMs: 0,
    ...overrides,
  };
}

function quotaActivity(
  scope: { workspaceId: string; agentId: string; computerId: string },
  overrides: Partial<TrustedAgentActivity> = {},
): TrustedAgentActivity {
  return activity({
    ...scope,
    runtimeProvider: "claude-code",
    runtimeError: {
      errorClass: "RateLimitError",
      errorReason: "quota_exhausted",
      fingerprint: "fp",
      retryNotBefore: "2026-11-08T00:00:00.000Z",
    },
    ...overrides,
  });
}

async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `ul-owner-${suffix}`, username: `ul-owner-${suffix}` },
  });
  const admin = await db.user.create({
    data: { displayName: `ul-admin-${suffix}`, username: `ul-admin-${suffix}` },
  });
  const member = await db.user.create({
    data: { displayName: `ul-member-${suffix}`, username: `ul-member-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `ul-${suffix}`,
      name: "Usage limits",
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: admin.id, role: "admin" },
          { userId: member.id, role: "member" },
        ],
      },
    },
  });
  const computer = await db.computer.create({
    data: { ownerId: owner.id, machineId: `ul-machine-${suffix}` },
  });
  await db.workspaceComputer.create({
    data: { workspaceId: workspace.id, computerId: computer.id },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      name: `ul-agent-${suffix}`,
      displayName: "Limited",
      ownerId: owner.id,
      computerId: computer.id,
      runtimeConfig: {},
    },
  });
  const scope = {
    workspaceId: workspace.id,
    computerId: computer.id,
    agentId: agent.id,
  };
  const announced: UsageLimitChangedEvent[] = [];
  const announce: UsageLimitAnnouncer = async (changes) => {
    announced.push(...changes);
  };
  const repo = new PrismaUsageLimitEventRepository(db);
  const addAgent = () =>
    db.agent.create({
      data: {
        workspaceId: workspace.id,
        name: `ul-agent-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Limited too",
        ownerId: owner.id,
        computerId: computer.id,
        runtimeConfig: {},
      },
    });
  const sweep = (now?: Date) =>
    sweepUsageLimitEvents(
      db,
      async (changes) => {
        announced.push(...changes);
      },
      now,
    );
  const cleanup = async () => {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.delete({ where: { id: computer.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, admin.id, member.id] } } });
    await db.$disconnect();
  };
  return {
    db,
    owner,
    admin,
    member,
    workspace,
    computer,
    agent,
    scope,
    announced,
    announce,
    repo,
    addAgent,
    sweep,
    cleanup,
  };
}

test.skipIf(!connectionString)(
  "quota reports open and merge events; every other frame is inert",
  async () => {
    const { db, owner, workspace, agent, scope, announced, announce, repo, addAgent, cleanup } =
      await setup();
    try {
      // A quota Activity opens the event and announces it with its set size.
      await observeUsageLimitActivity(db, quotaActivity(scope), announce);
      let events = await repo.listOpenForViewer(workspace.id, owner.id);
      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.provider).toBe("claude-code");
      expect(event.resetsAt?.toISOString()).toBe("2026-11-08T00:00:00.000Z");
      expect(event.agents.map((a) => a.id)).toEqual([agent.id]);
      expect(announced).toEqual([
        {
          type: "usage.limit.changed.v1",
          workspaceId: workspace.id,
          eventId: event.id,
          status: "open",
          affectedCount: 1,
          resetsAt: "2026-11-08T00:00:00.000Z",
        },
      ]);

      // A repeat report for an Agent already counted merges silently: one
      // event, later reset wins, nothing announced.
      await observeUsageLimitActivity(
        db,
        quotaActivity(scope, {
          clientSeq: 2,
          runtimeError: {
            errorClass: "RateLimitError",
            errorReason: "quota_exhausted",
            fingerprint: "fp",
            retryNotBefore: "2026-11-09T00:00:00.000Z",
          },
        }),
        announce,
      );
      events = await repo.listOpenForViewer(workspace.id, owner.id);
      expect(events).toHaveLength(1);
      expect(events[0]!.id).toBe(event.id);
      expect(events[0]!.resetsAt?.toISOString()).toBe("2026-11-09T00:00:00.000Z");
      expect(announced).toHaveLength(1);

      // A second Agent's report joins the affected set and announces the growth.
      const agent2 = await addAgent();
      await observeUsageLimitActivity(
        db,
        quotaActivity({ ...scope, agentId: agent2.id }, { clientSeq: 3 }),
        announce,
      );
      expect(announced.at(-1)).toMatchObject({
        eventId: event.id,
        status: "open",
        affectedCount: 2,
      });

      // A different provider is a different event; a billing report has no reset.
      await observeUsageLimitActivity(
        db,
        quotaActivity(scope, {
          clientSeq: 4,
          runtimeProvider: "codex",
          runtimeError: {
            errorClass: "BillingError",
            errorReason: "billing_exhausted",
            fingerprint: "fp",
          },
        }),
        announce,
      );
      events = await repo.listOpenForViewer(workspace.id, owner.id);
      expect(events).toHaveLength(2);
      const billing = events.find((e) => e.provider === "codex")!;
      expect(billing.resetsAt).toBeNull();
      expect(announced.at(-1)).toMatchObject({
        eventId: billing.id,
        status: "open",
        affectedCount: 1,
        resetsAt: null,
      });

      // Nothing else touches state: an old daemon's quota error (no provider),
      // a different runtime error, ordinary work and a stop all leave both
      // events open and announce nothing — recovery and gone detection are
      // the sweep's job, off the write path.
      const announcedBefore = announced.length;
      for (const frame of [
        quotaActivity(scope, { clientSeq: 5, launchId: "old-launch", runtimeProvider: undefined }),
        activity({
          ...scope,
          agentId: agent2.id,
          clientSeq: 6,
          runtimeProvider: "codex",
          runtimeError: {
            errorClass: "AuthError",
            errorReason: "user_reauth",
            fingerprint: "fp",
          },
        }),
        activity({ ...scope, clientSeq: 7, detailKind: "tool_end", level: "info" }),
        activity({ ...scope, clientSeq: 8, detailKind: "stopped", level: "info" }),
      ])
        await observeUsageLimitActivity(db, frame, announce);
      expect(await repo.listOpenForViewer(workspace.id, owner.id)).toHaveLength(2);
      expect(announced).toHaveLength(announcedBefore);
    } finally {
      await cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "the sweep recovers Agents on activity or message evidence",
  async () => {
    const { db, owner, workspace, agent, scope, announced, repo, addAgent, sweep, cleanup } =
      await setup();
    try {
      // Event A holds two Agents; event B (another provider) holds a third.
      await repo.openOrMerge({ ...scope, provider: "claude-code", resetsAt: null });
      const agentB = await addAgent();
      await repo.openOrMerge({
        ...scope,
        agentId: agentB.id,
        provider: "claude-code",
        resetsAt: null,
      });
      const agentC = await addAgent();
      await repo.openOrMerge({
        ...scope,
        agentId: agentC.id,
        provider: "codex",
        resetsAt: null,
      });
      const [eventA] = await db.usageLimitEvent.findMany({
        where: { workspaceId: workspace.id, provider: "claude-code" },
      });
      const [eventB] = await db.usageLimitEvent.findMany({
        where: { workspaceId: workspace.id, provider: "codex" },
      });

      const activityRepo = new AgentActivityRepository(db);
      const work = (agentId: string, seq: number, detailKind = "tool_started") =>
        activityRepo.record(
          activity({
            ...scope,
            agentId,
            clientSeq: seq,
            launchId: `launch-${agentId.slice(0, 8)}`,
            detailKind,
            level: "info",
          }),
        );

      // Agent A shows substantive work: it leaves event A's set, which stays
      // open for B — announced as an open change, not a close.
      await work(agent.id, 1);
      await sweep();
      let events = await repo.listOpenForViewer(workspace.id, owner.id);
      expect(events.map((e) => e.id).sort()).toEqual([eventA!.id, eventB!.id].sort());
      expect(events.find((e) => e.id === eventA!.id)!.agents.map((a) => a.id)).toEqual([agentB.id]);
      expect(announced.at(-1)).toMatchObject({
        eventId: eventA!.id,
        status: "open",
        affectedCount: 1,
      });

      // Agent B works too: event A empties and closes as recovered. A
      // response marker covers a second recovery kind.
      await work(agentB.id, 1, "model_response_started");
      await sweep();
      events = await repo.listOpenForViewer(workspace.id, owner.id);
      expect(events.map((e) => e.id)).toEqual([eventB!.id]);
      expect(announced.at(-1)).toMatchObject({
        eventId: eventA!.id,
        status: "closed",
        closeReason: "recovered",
      });

      // Agent C never produced Activity but sent a Message: same evidence.
      const channel = await db.conversation.create({
        data: {
          workspaceId: workspace.id,
          channelName: `ul-${crypto.randomUUID().slice(0, 8)}`,
          members: { create: [{ agentId: agentC.id }] },
        },
        include: { members: true },
      });
      await db.message.create({
        data: {
          conversationId: channel.id,
          workspaceId: workspace.id,
          senderMemberId: channel.members[0]!.id,
          sequence: 1,
          body: "back online",
        },
      });
      await sweep();
      expect(await repo.listOpenForViewer(workspace.id, owner.id)).toHaveLength(0);
      expect(announced.at(-1)).toMatchObject({
        eventId: eventB!.id,
        status: "closed",
        closeReason: "recovered",
      });
    } finally {
      await cleanup();
    }
  },
);

test.skipIf(!connectionString)("the sweep keeps events open on non-work rows only", async () => {
  const { db, owner, workspace, agent, scope, repo, sweep, cleanup } = await setup();
  try {
    await repo.openOrMerge({ ...scope, provider: "claude-code", resetsAt: null });
    const activityRepo = new AgentActivityRepository(db);
    // None of these is recovery evidence: another runtime error, the
    // thinking_end the daemon synthesizes on the error that ends a thinking
    // run, a request-start marker emitted before the request's outcome is
    // known (a failed retry must not read as recovery), an idle turn
    // boundary, and a Computer lifecycle row.
    for (const [seq, detailKind, level] of [
      [1, "runtime_error", "error"],
      [2, "thinking_end", "info"],
      [3, "model_request_started", "info"],
      [4, "idle", "info"],
      [5, "computer_restarted", "info"],
    ] as const)
      await activityRepo.record(
        activity({
          ...scope,
          clientSeq: seq,
          launchId: "launch-x",
          detailKind,
          level,
          runtimeError:
            detailKind === "runtime_error"
              ? { errorClass: "AuthError", errorReason: "user_reauth", fingerprint: "fp" }
              : undefined,
        }),
      );
    await sweep();
    const events = await repo.listOpenForViewer(workspace.id, owner.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.agents.map((a) => a.id)).toEqual([agent.id]);
  } finally {
    await cleanup();
  }
});

test.skipIf(!connectionString)(
  "the sweep closes reset_passed, aged_out and agents_gone",
  async () => {
    const { db, owner, workspace, agent, scope, repo, addAgent, cleanup } = await setup();
    try {
      const now = new Date("2026-11-10T00:00:00.000Z");
      // Event A: reset already passed → reset_passed.
      await repo.openOrMerge({
        ...scope,
        provider: "claude-code",
        resetsAt: new Date("2026-11-09T00:00:00.000Z"),
      });
      // Event B: billing, no reset; its only Agent is deleted → agents_gone.
      await repo.openOrMerge({ ...scope, provider: "codex", resetsAt: null });
      await db.agent.update({ where: { id: agent.id }, data: { deletedAt: now } });
      // Event C: a stopped Agent's event → agents_gone through stoppedAt.
      const agent3 = await addAgent();
      await repo.openOrMerge({ ...scope, agentId: agent3.id, provider: "pi", resetsAt: null });
      await db.agent.update({ where: { id: agent3.id }, data: { stoppedAt: now } });
      // Event D: a different Agent's fresh-provider event, backdated past the
      // age bound → aged_out (its Agent stays live so agents_gone cannot claim it).
      const agent4 = await addAgent();
      const aged = await repo.openOrMerge({
        ...scope,
        agentId: agent4.id,
        provider: "grok",
        resetsAt: null,
      });
      await db.usageLimitEvent.update({
        where: { id: aged.id },
        data: { openedAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000) },
      });

      const announced: UsageLimitChangedEvent[] = [];
      await sweepUsageLimitEvents(
        db,
        async (changes) => {
          announced.push(...changes);
        },
        now,
      );

      expect(await repo.listOpenForViewer(workspace.id, owner.id)).toHaveLength(0);
      const stored = await db.usageLimitEvent.findMany({
        where: { workspaceId: workspace.id },
        select: { provider: true, status: true, closeReason: true },
        orderBy: { provider: "asc" },
      });
      expect(stored).toEqual([
        { provider: "claude-code", status: "closed", closeReason: "reset_passed" },
        { provider: "codex", status: "closed", closeReason: "agents_gone" },
        { provider: "grok", status: "closed", closeReason: "aged_out" },
        { provider: "pi", status: "closed", closeReason: "agents_gone" },
      ]);
      expect(announced).toHaveLength(4);
      expect(announced.every((c) => c.status === "closed")).toBe(true);
      // A second pass announces nothing: every close was conditional on open.
      announced.length = 0;
      await sweepUsageLimitEvents(
        db,
        async (changes) => {
          announced.push(...changes);
        },
        now,
      );
      expect(announced).toHaveLength(0);
    } finally {
      await cleanup();
    }
  },
);

test.skipIf(!connectionString)(
  "record reports first-seen only, so replays skip the hook",
  async () => {
    const { db, scope, cleanup } = await setup();
    try {
      const activityRepo = new AgentActivityRepository(db);
      const frame = quotaActivity(scope, { clientSeq: 9 });
      expect(await activityRepo.record(frame)).toBe(true);
      expect(await activityRepo.record(frame)).toBe(false);
    } finally {
      await cleanup();
    }
  },
);

test.skipIf(!connectionString)("seen, dismiss and the read stay owner/admin-only", async () => {
  const { db, owner, admin, member, workspace, scope, repo, cleanup } = await setup();
  try {
    await repo.openOrMerge({ ...scope, provider: "claude-code", resetsAt: null });
    const [event] = await repo.listOpenForViewer(workspace.id, owner.id);
    expect(event).toBeDefined();

    const events = new UsageLimitEvents(db);
    // Members are refused on every verb.
    for (const call of [
      () => events.listForViewer(workspace.id, member.id, "member"),
      () => events.markSeen(workspace.id, member.id, "member", event!.id),
      () => events.dismiss(workspace.id, member.id, "member", event!.id),
    ])
      await expect(call()).rejects.toBeInstanceOf(AppError);

    // Admins read and mark; marks are per person and first-write-wins.
    await events.markSeen(workspace.id, admin.id, "admin", event!.id);
    await events.markSeen(workspace.id, admin.id, "admin", event!.id);
    await events.dismiss(workspace.id, admin.id, "admin", event!.id);
    const [forAdmin] = await repo.listOpenForViewer(workspace.id, admin.id);
    expect(forAdmin!.viewer.seenAt).not.toBeNull();
    expect(forAdmin!.viewer.dismissedAt).not.toBeNull();
    const [forOwner] = await repo.listOpenForViewer(workspace.id, owner.id);
    expect(forOwner!.viewer.seenAt).toBeNull();
    expect(forOwner!.viewer.dismissedAt).toBeNull();

    // A mark for another Workspace's event answers false, not a write.
    expect(await repo.markSeen(event!.id, owner.id, crypto.randomUUID())).toBe(false);

    // The push audience is owner + admin, never the plain member.
    expect((await repo.elevatedUserIds(workspace.id)).sort()).toEqual([owner.id, admin.id].sort());
  } finally {
    await cleanup();
  }
});

test.skipIf(!connectionString)(
  "the read carries the Computer's list label as computerName",
  async () => {
    const { db, owner, workspace, computer, scope, repo, cleanup } = await setup();
    try {
      await db.computer.update({
        where: { id: computer.id },
        data: { name: "studio.local", displayName: "Studio" },
      });
      await repo.openOrMerge({ ...scope, provider: "claude-code", resetsAt: null });
      const events = new UsageLimitEvents(db);
      const [named] = await events.listForViewer(workspace.id, owner.id, "owner");
      expect(named!.computerName).toBe("Studio");

      // No display name or hostname: the same fallback the Computers list shows.
      await db.computer.update({
        where: { id: computer.id },
        data: { name: "", displayName: "" },
      });
      const [fallback] = await events.listForViewer(workspace.id, owner.id, "owner");
      expect(fallback!.computerName).toBe(m.computer_platform_unknown());
    } finally {
      await cleanup();
    }
  },
);
