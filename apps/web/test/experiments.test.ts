import { expect, test } from "bun:test";
import { announceFeaturesChanged } from "#src/server/experiments/features-signal.server";
import { decodeWorkspaceFeaturesChangedEvent } from "#src/features/workspaces/workspace-realtime";

import { EXPERIMENTS, Experiments } from "#src/server/experiments/experiments.server";
import type { ExperimentsRepository } from "#src/server/experiments/experiments.server";

const workspace = { workspaceId: "w1", workspaceSlug: "w" };

function setup(flags: readonly string[]) {
  const stored = new Map<string, Record<string, boolean>>();
  const repository: ExperimentsRepository = {
    read: async (workspaceId) => stored.get(workspaceId) ?? {},
    write: async (workspaceId, key, enabled) => {
      stored.set(workspaceId, { ...stored.get(workspaceId), [key]: enabled });
    },
  };
  const experiments = new Experiments(repository, async (flag) => flags.includes(flag));
  return { experiments, stored };
}

test("the registry names each experiment's flag and whether a change needs a reload", () => {
  expect(EXPERIMENTS.taskConversations).toEqual({ flag: "task-conversations", reload: false });
});

test("a Workspace whose flag is off lists nothing and can enable nothing", async () => {
  const { experiments, stored } = setup([]);
  expect(await experiments.list(workspace)).toEqual([]);
  expect(await experiments.enabled("taskConversations", workspace)).toBeFalse();
  await expect(
    experiments.set(workspace, "owner", "taskConversations", true),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(stored.size).toBe(0);
});

test("a visible experiment starts off, and is on only once an owner or admin switched it on", async () => {
  const { experiments } = setup(["task-conversations"]);
  expect(await experiments.list(workspace)).toEqual([
    { key: "taskConversations", enabled: false, reload: false },
  ]);
  expect(await experiments.set(workspace, "admin", "taskConversations", true)).toEqual({
    key: "taskConversations",
    enabled: true,
    reload: false,
  });
  expect(await experiments.enabled("taskConversations", workspace)).toBeTrue();
  expect(
    await experiments.enabled("taskConversations", { ...workspace, workspaceId: "w2" }),
  ).toBeFalse();
});

test("a member cannot switch an experiment, and nothing is written", async () => {
  const { experiments, stored } = setup(["task-conversations"]);
  for (const role of ["member", undefined])
    await expect(experiments.set(workspace, role, "taskConversations", true)).rejects.toMatchObject(
      { code: "ACCESS_DENIED" },
    );
  expect(stored.size).toBe(0);
});

test("a Workspace's choice does nothing once its flag goes off", async () => {
  const off = new Experiments(
    { read: async () => ({ taskConversations: true }), write: async () => {} },
    async () => false,
  );
  expect(await off.enabled("taskConversations", workspace)).toBeFalse();
});

test("stored keys the registry no longer knows are ignored", async () => {
  const experiments = new Experiments(
    { read: async () => ({ retiredThing: true }), write: async () => {} },
    async () => true,
  );
  expect(await experiments.list(workspace)).toEqual([
    { key: "taskConversations", enabled: false, reload: false },
  ]);
});

test("a switch is announced to every page of the Workspace, and a failed signal is not an error", async () => {
  const published: { channel: string; data: unknown }[] = [];
  await announceFeaturesChanged(
    {
      publishJson: async (channel: string, data: unknown) => {
        published.push({ channel, data });
      },
    },
    "w1",
  );
  expect(published).toEqual([
    {
      channel: "chat:workspace:w1",
      data: { type: "workspace.features.changed.v1", workspaceId: "w1" },
    },
  ]);
  expect(decodeWorkspaceFeaturesChangedEvent(published[0]!.data)).toEqual({
    type: "workspace.features.changed.v1",
    workspaceId: "w1",
  });
  expect(decodeWorkspaceFeaturesChangedEvent({ type: "message.available.v1" })).toBeUndefined();
  await announceFeaturesChanged(
    {
      publishJson: async () => {
        throw new Error("down");
      },
    },
    "w1",
  );
});
