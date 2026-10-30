import { expect, test } from "bun:test";

import { EXPERIMENTS, Experiments } from "#src/server/experiments/experiments.server";
import type { ExperimentsRepository } from "#src/server/experiments/experiments.server";

const workspace = { workspaceId: "w1", workspaceSlug: "w" };

function setup(flags: readonly string[]) {
  const stored = new Map<string, Record<string, boolean>>();
  const repository: ExperimentsRepository = {
    read: async (userId) => stored.get(userId) ?? {},
    write: async (userId, key, enabled) => {
      stored.set(userId, { ...stored.get(userId), [key]: enabled });
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
  expect(await experiments.list("u1", workspace)).toEqual([]);
  expect(await experiments.enabled("taskConversations", "u1", workspace)).toBeFalse();
  await expect(experiments.set("u1", workspace, "taskConversations", true)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect(stored.size).toBe(0);
});

test("a visible experiment starts off, and is on only when the user turned it on", async () => {
  const { experiments } = setup(["task-conversations"]);
  expect(await experiments.list("u1", workspace)).toEqual([
    { key: "taskConversations", enabled: false, reload: false },
  ]);
  expect(await experiments.set("u1", workspace, "taskConversations", true)).toEqual({
    key: "taskConversations",
    enabled: true,
    reload: false,
  });
  expect(await experiments.enabled("taskConversations", "u1", workspace)).toBeTrue();
  expect(await experiments.enabled("taskConversations", "u2", workspace)).toBeFalse();
});

test("a user's choice does nothing once the Workspace's flag goes off", async () => {
  const off = new Experiments(
    { read: async () => ({ taskConversations: true }), write: async () => {} },
    async () => false,
  );
  expect(await off.enabled("taskConversations", "u1", workspace)).toBeFalse();
});

test("stored keys the registry no longer knows are ignored", async () => {
  const experiments = new Experiments(
    { read: async () => ({ retiredThing: true }), write: async () => {} },
    async () => true,
  );
  expect(await experiments.list("u1", workspace)).toEqual([
    { key: "taskConversations", enabled: false, reload: false },
  ]);
});
