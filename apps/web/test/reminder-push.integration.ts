import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  decodeReminderFireResponse,
  decodeReminderSync,
  encodeReminderFireRequest,
  encodeReminderSync,
  type ReminderSync,
} from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { createReminderFireMethod } from "#src/server/centrifugo/rpc-handler.server";
import { daemonControlChannel } from "#src/server/centrifugo/server-api.server";
import { PrismaReminderRepository } from "#src/server/db/repositories/reminder.repositories.server";
import { pushReminderSnapshots } from "#src/server/reminders/reminder-push.server";
import { Reminders, nextOccurrence } from "#src/server/reminders/reminders.server";

const connectionString = Bun.env.REMINDER_TEST_DATABASE_URL;
if (!connectionString)
  throw new Error("REMINDER_TEST_DATABASE_URL is required (isolated PostgreSQL)");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const now = new Date("2026-09-08T12:00:00.000Z");
/** Ninety minutes before `now`: the reminder was due while the Daemon was away. */
const overdue = new Date(now.getTime() - 90 * 60_000);

const published: ReminderSync[] = [];
const reminders = new Reminders(
  new PrismaReminderRepository(db),
  { supports: async () => true },
  async (sync) => void published.push(decodeReminderSync(encodeReminderSync(sync))),
  () => now,
);

const fixture = {} as {
  userId: string;
  outsiderId: string;
  workspaceId: string;
  otherWorkspaceId: string;
  computerId: string;
  otherComputerId: string;
  neverStartedAgentId: string;
  rotatedAgentId: string;
  outsiderAgentId: string;
  otherComputerAgentId: string;
  otherWorkspaceAgentId: string;
  overdueReminderId: string;
  metadata: { principal: { userId: string; workspaceId: string; computerId: string } };
};

async function scheduledReminder(input: {
  workspaceId: string;
  computerId: string;
  agentId: string;
  title: string;
  repeat?: string;
}) {
  return db.reminder.create({
    data: {
      workspaceId: input.workspaceId,
      ownerAgentId: input.agentId,
      computerId: input.computerId,
      title: input.title,
      target: "@frank",
      messageId: crypto.randomUUID(),
      fireAt: overdue,
      status: "scheduled",
      version: 1,
      ...(input.repeat ? { repeat: input.repeat, timezone: "UTC" } : {}),
    },
  });
}

beforeAll(async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: { displayName: `push_${suffix}`, username: `push_${suffix}` },
  });
  // Owns an Agent on the Computer but is in no Workspace with it: the in-scope rule is membership,
  // and this row is the one a Daemon must never be handed.
  const outsider = await db.user.create({
    data: { displayName: `outsider_${suffix}`, username: `outsider_${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `push-${suffix}`,
      name: "Reminder push",
      members: { create: { userId: user.id } },
    },
  });
  const otherWorkspace = await db.workspace.create({
    data: {
      slug: `push-other-${suffix}`,
      name: "Elsewhere",
      members: { create: { userId: outsider.id } },
    },
  });
  const computer = await db.computer.create({
    data: {
      ownerId: user.id,
      machineId: `push-machine-${suffix}`,
      workspaces: { create: { workspaceId: workspace.id } },
    },
  });
  const otherComputer = await db.computer.create({
    data: {
      ownerId: user.id,
      machineId: `push-other-machine-${suffix}`,
      workspaces: { create: { workspaceId: workspace.id } },
    },
  });
  const elsewhereComputer = await db.computer.create({
    data: {
      ownerId: outsider.id,
      machineId: `push-elsewhere-machine-${suffix}`,
      workspaces: { create: { workspaceId: otherWorkspace.id } },
    },
  });
  const agent = (input: {
    workspaceId: string;
    computerId: string;
    ownerId: string;
    name: string;
  }) =>
    db.agent.create({
      data: {
        workspaceId: input.workspaceId,
        ownerId: input.ownerId,
        computerId: input.computerId,
        name: input.name,
        displayName: input.name,
        runtimeConfig: {},
      },
    });

  // No session, no process, no launch: nothing on this Computer was ever asked to run it. That is
  // the whole point — the Daemon cannot ask for a snapshot of an Agent it has never been given.
  const neverStarted = await agent({
    workspaceId: workspace.id,
    computerId: computer.id,
    ownerId: user.id,
    name: "never-started",
  });
  const rotated = await agent({
    workspaceId: workspace.id,
    computerId: computer.id,
    ownerId: user.id,
    name: "rotated",
  });
  const outsiderAgent = await agent({
    workspaceId: workspace.id,
    computerId: computer.id,
    ownerId: outsider.id,
    name: "outsider",
  });
  const otherComputerAgent = await agent({
    workspaceId: workspace.id,
    computerId: otherComputer.id,
    ownerId: user.id,
    name: "other-computer",
  });
  const otherWorkspaceAgent = await agent({
    workspaceId: otherWorkspace.id,
    computerId: elsewhereComputer.id,
    ownerId: outsider.id,
    name: "other-workspace",
  });

  const overdueReminder = await scheduledReminder({
    workspaceId: workspace.id,
    computerId: computer.id,
    agentId: neverStarted.id,
    title: "Overdue on a cold Agent",
    repeat: "every:1d",
  });
  await scheduledReminder({
    workspaceId: workspace.id,
    computerId: computer.id,
    agentId: rotated.id,
    title: "One shot",
  });
  await scheduledReminder({
    workspaceId: workspace.id,
    computerId: computer.id,
    agentId: outsiderAgent.id,
    title: "Out of scope",
  });
  await scheduledReminder({
    workspaceId: workspace.id,
    computerId: otherComputer.id,
    agentId: otherComputerAgent.id,
    title: "Another Computer",
  });
  await scheduledReminder({
    workspaceId: otherWorkspace.id,
    computerId: elsewhereComputer.id,
    agentId: otherWorkspaceAgent.id,
    title: "Another Workspace",
  });

  Object.assign(fixture, {
    userId: user.id,
    outsiderId: outsider.id,
    workspaceId: workspace.id,
    otherWorkspaceId: otherWorkspace.id,
    computerId: computer.id,
    otherComputerId: otherComputer.id,
    neverStartedAgentId: neverStarted.id,
    rotatedAgentId: rotated.id,
    outsiderAgentId: outsiderAgent.id,
    otherComputerAgentId: otherComputerAgent.id,
    otherWorkspaceAgentId: otherWorkspaceAgent.id,
    overdueReminderId: overdueReminder.id,
    metadata: {
      principal: {
        userId: user.id,
        workspaceId: workspace.id,
        computerId: computer.id,
      },
    },
  });
});

afterAll(async () => {
  await db.$disconnect();
});

/** Runs the daemon-ready push and returns the frames it published, decoded. */
async function push(): Promise<{ channel: string; sync: ReminderSync }[]> {
  const entries: { channel: string; data: Uint8Array }[] = [];
  await pushReminderSnapshots(
    {
      db,
      centrifugo: {
        publishBatch: async (batch) => {
          entries.push(...(batch as { channel: string; data: Uint8Array }[]));
          return batch.map(() => ({ status: "fulfilled" as const, value: undefined }));
        },
      },
      reminders,
    },
    { workspaceId: fixture.workspaceId, computerId: fixture.computerId },
  );
  return entries.map((entry) => ({
    channel: entry.channel,
    sync: decodeReminderSync(entry.data),
  }));
}

const fire = (input: {
  reminderId: string;
  version: number;
  requestId: string;
  agentId?: string;
}) =>
  createReminderFireMethod(reminders)(
    encodeReminderFireRequest({
      protocolMajor: 1,
      requestId: input.requestId,
      workspaceId: fixture.workspaceId,
      computerId: fixture.computerId,
      agentId: input.agentId ?? fixture.neverStartedAgentId,
      reminderId: input.reminderId,
      version: input.version,
      firedAtClient: now.toISOString(),
    }),
    fixture.metadata,
  );

async function fireResult(input: {
  reminderId: string;
  version: number;
  requestId: string;
  agentId?: string;
}) {
  const response = await fire(input);
  if (!(response instanceof Uint8Array)) throw new Error(JSON.stringify(response));
  return decodeReminderFireResponse(response);
}

test("a Daemon's connect pushes an overdue reminder of an Agent that never started, and firing it schedules the next", async () => {
  published.length = 0;
  const frames = await push();

  expect(new Set(frames.map((frame) => frame.channel))).toEqual(
    new Set([daemonControlChannel(fixture.workspaceId, fixture.computerId)]),
  );
  const snapshot = frames.find((frame) => frame.sync.agentId === fixture.neverStartedAgentId);
  if (!snapshot) throw new Error("the never-started Agent was not pushed");
  expect(snapshot.sync).toMatchObject({
    operation: "snapshot",
    protocolMajor: 1,
    workspaceId: fixture.workspaceId,
    computerId: fixture.computerId,
    agentId: fixture.neverStartedAgentId,
  });
  expect(snapshot.sync.jobs).toEqual([
    expect.objectContaining({
      reminderId: fixture.overdueReminderId,
      ownerAgentId: fixture.neverStartedAgentId,
      version: 1,
    }),
  ]);

  // What the Daemon does with an overdue job: fire it at once, at the version the snapshot carried.
  const accepted = await fireResult({
    reminderId: fixture.overdueReminderId,
    version: 1,
    requestId: "cold-agent-fire",
  });
  expect(accepted).toMatchObject({ result: "accepted", fired: true });

  // The server owns the next cycle: one upsert, one higher version, the next real occurrence.
  const upserts = published.filter(
    (sync) => sync.operation === "upsert" && sync.agentId === fixture.neverStartedAgentId,
  );
  expect(upserts).toHaveLength(1);
  const nextJob = upserts[0]!.jobs[0]!;
  expect(nextJob).toMatchObject({
    reminderId: fixture.overdueReminderId,
    ownerAgentId: fixture.neverStartedAgentId,
    version: 2,
  });
  expect(nextJob.fireAt).toBe(nextOccurrence("every:1d", "UTC", overdue, now).toISOString());
  expect(new Date(nextJob.fireAt).getTime()).toBeGreaterThan(now.getTime());

  const row = await db.reminder.findUnique({ where: { id: fixture.overdueReminderId } });
  expect(row).toMatchObject({ status: "scheduled", version: 2 });
  expect(row?.fireAt.toISOString()).toBe(nextJob.fireAt);
});

test("a pushed snapshot collides with the Daemon's own request at one version, so the reminder fires once", async () => {
  published.length = 0;
  const pushed = await push();
  const pushedJob = pushed
    .find((frame) => frame.sync.agentId === fixture.rotatedAgentId)!
    .sync.jobs.find((job) => job.reminderId !== fixture.overdueReminderId)!;

  // The Daemon also asks for this Agent's snapshot itself; both frames describe one revision.
  const asked = decodeReminderSync(
    await reminders.snapshotForDaemon({
      protocolMajor: 1,
      requestId: "daemon-asked",
      workspaceId: fixture.workspaceId,
      computerId: fixture.computerId,
      agentId: fixture.rotatedAgentId,
    }),
  );
  const askedJob = asked.jobs.find((job) => job.reminderId === pushedJob.reminderId)!;
  expect(askedJob.version).toBe(pushedJob.version);
  expect(askedJob.fireAt).toBe(pushedJob.fireAt);

  // Two snapshots, one reminder: the version fences the fire, so only the first is accepted.
  const first = await fireResult({
    reminderId: pushedJob.reminderId,
    version: askedJob.version,
    requestId: "collision-first",
    agentId: fixture.rotatedAgentId,
  });
  const second = await fireResult({
    reminderId: pushedJob.reminderId,
    version: askedJob.version,
    requestId: "collision-second",
    agentId: fixture.rotatedAgentId,
  });
  expect(first).toMatchObject({ result: "accepted", fired: true });
  expect(second.result).toBe("obsolete");
  expect(
    await db.reminderEvent.count({
      where: { reminderId: pushedJob.reminderId, type: "fired" },
    }),
  ).toBe(1);
  expect(await db.reminder.findUnique({ where: { id: pushedJob.reminderId } })).toMatchObject({
    status: "fired",
    version: 2,
  });
});

test("only the connecting Computer's Workspace and membership are pushed, and one out-of-scope Agent cannot silence the rest", async () => {
  const frames = await push();
  const agents = frames.map((frame) => frame.sync.agentId).sort();
  expect(agents).toEqual([fixture.neverStartedAgentId, fixture.rotatedAgentId].sort());
  expect(agents).not.toContain(fixture.outsiderAgentId);
  expect(agents).not.toContain(fixture.otherComputerAgentId);
  expect(agents).not.toContain(fixture.otherWorkspaceAgentId);

  // The out-of-scope Agent the push skipped is exactly what the daemon-authorized path refuses:
  // nothing was silenced, it was never in scope. The Daemon's own request for it is refused.
  await expect(
    reminders.snapshotForDaemon({
      protocolMajor: 1,
      requestId: "outsider-asked",
      workspaceId: fixture.workspaceId,
      computerId: fixture.computerId,
      agentId: fixture.outsiderAgentId,
    }),
  ).rejects.toThrow("reminder snapshot is not authorized");
});
