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

test("the registry names each experiment's flag, default and whether a change needs a reload", () => {
  expect(EXPERIMENTS.taskConversations).toEqual({
    flag: null,
    defaultEnabled: false,
    reload: false,
  });
  expect(EXPERIMENTS.drafts).toEqual({ flag: null, defaultEnabled: true, reload: false });
  expect(EXPERIMENTS.artifacts).toEqual({ flag: null, defaultEnabled: false, reload: false });
});

test("an experiment without a flag is offered to every Workspace, on until its choice says off", async () => {
  const { experiments, stored } = setup([]);
  expect(await experiments.enabled("drafts", workspace)).toBeTrue();
  expect(await experiments.enabled("taskConversations", workspace)).toBeFalse();
  expect(await experiments.set(workspace, "owner", "drafts", false)).toEqual({
    key: "drafts",
    enabled: false,
    reload: false,
  });
  expect(stored.get("w1")).toEqual({ drafts: false });
  expect(await experiments.enabled("drafts", workspace)).toBeFalse();
  expect(await experiments.list(workspace)).toEqual([
    { key: "taskConversations", enabled: false, reload: false },
    { key: "drafts", enabled: false, reload: false },
    { key: "artifacts", enabled: false, reload: false },
  ]);
  expect(await experiments.enabled("drafts", { ...workspace, workspaceId: "w2" })).toBeTrue();
  await experiments.set(workspace, "admin", "drafts", true);
  expect(await experiments.enabled("drafts", workspace)).toBeTrue();
});

test("a member cannot switch an unflagged experiment either", async () => {
  const { experiments, stored } = setup([]);
  await expect(experiments.set(workspace, "member", "drafts", false)).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  expect(stored.size).toBe(0);
});

test("an unflagged experiment is never looked up by flag", async () => {
  const asked: string[] = [];
  const experiments = new Experiments(
    { read: async () => ({}), write: async () => {} },
    async (flag) => {
      asked.push(flag);
      return false;
    },
  );
  await experiments.list(workspace);
  await experiments.enabled("drafts", workspace);
  const flagged = new Set<string>(
    Object.values(EXPERIMENTS).flatMap(({ flag }) => (flag === null ? [] : [flag])),
  );
  expect(asked.filter((flag) => !flagged.has(flag))).toEqual([]);
});

test("every Workspace offers every experiment; an unset one defaults to the registry default", async () => {
  const { experiments } = setup([]);
  expect(await experiments.list(workspace)).toEqual([
    { key: "taskConversations", enabled: false, reload: false },
    { key: "drafts", enabled: true, reload: false },
    { key: "artifacts", enabled: false, reload: false },
  ]);
  expect(await experiments.enabled("taskConversations", workspace)).toBeFalse();
  expect(await experiments.enabled("artifacts", workspace)).toBeFalse();
});

test("a visible experiment starts off, and is on only once an owner or admin switched it on", async () => {
  const { experiments } = setup([]);
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
  const { experiments, stored } = setup([]);
  for (const role of ["member", undefined])
    await expect(experiments.set(workspace, role, "taskConversations", true)).rejects.toMatchObject(
      { code: "ACCESS_DENIED" },
    );
  expect(stored.size).toBe(0);
});

test("a Workspace's stored choice keeps it on once its flag is gone: the flag only ever decided offering", async () => {
  const off = new Experiments(
    { read: async () => ({ taskConversations: true }), write: async () => {} },
    async () => false,
  );
  expect(await off.enabled("taskConversations", workspace)).toBeTrue();
});

test("stored keys the registry no longer knows are ignored", async () => {
  const experiments = new Experiments(
    { read: async () => ({ retiredThing: true }), write: async () => {} },
    async () => false,
  );
  expect(await experiments.list(workspace)).toEqual([
    { key: "taskConversations", enabled: false, reload: false },
    { key: "drafts", enabled: true, reload: false },
    { key: "artifacts", enabled: false, reload: false },
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
