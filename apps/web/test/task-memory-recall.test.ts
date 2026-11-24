import { expect, spyOn, test } from "bun:test";
import type { TeamMemoryHead, TeamMemoryResult } from "@lrm/coforge-sdk/agent";
import { recallTaskMemory } from "#src/server/tasks/task-memory-recall.server";

const task = { title: "Recover production rollout", description: "Verify the approved version" };
const entry: TeamMemoryHead = {
  id: "00000000-0000-4000-8000-000000000001",
  authorAgentId: "00000000-0000-4000-8000-000000000002",
  title: "Production rollout",
  content: "The change was approved.",
  source: "Task acceptance",
  applicability: "production",
  kind: "decision",
  revision: 3,
  status: "active",
  updatedAt: "2026-11-18T00:00:00.000Z",
};

test("task recall requests the current project plus Workspace notes and retains evidence IDs", async () => {
  const project = { id: "00000000-0000-4000-8000-000000000003" };
  const result = await recallTaskMemory({ ...task, project }, async (search) => {
    expect(search).toMatchObject({
      operation: "search",
      projectId: project.id,
      includeWorkspace: true,
      query: "Recover production rollout Verify the approved version",
    });
    return { status: "ok", entries: [entry] };
  });
  expect(result).toEqual([
    {
      id: entry.id,
      revision: 3,
      title: entry.title,
      content: entry.content,
      source: entry.source,
      applicability: entry.applicability,
    },
  ]);
});

test("recall remains optional and bounded when the backend is unavailable or stalled", async () => {
  expect(
    await recallTaskMemory(task, async () => {
      throw new Error("unavailable");
    }),
  ).toEqual([]);
  const stalled = Promise.withResolvers<never>();
  expect(await recallTaskMemory(task, () => stalled.promise, 5)).toEqual([]);
});

test("recall keeps both versions of a conflict at the end of the task budget", async () => {
  const ranked = Array.from({ length: 6 }, (_, index) => ({
    ...entry,
    id: crypto.randomUUID(),
    title: `Rollout decision ${index + 1}`,
  }));
  const approval = ranked[4]!;
  const objection = ranked[5]!;
  const result = await recallTaskMemory(task, async () => ({
    status: "ok",
    entries: [
      ...ranked.slice(0, 4),
      {
        ...approval,
        relations: [{ kind: "conflicts_with", id: objection.id, revision: objection.revision }],
      },
      objection,
    ],
  }));
  expect(result.map(({ id }) => id)).toEqual([
    ...ranked.slice(0, 3).map(({ id }) => id),
    approval.id,
    objection.id,
  ]);
  expect(result[3]?.conflictsWith).toEqual([{ id: objection.id, revision: objection.revision }]);
});

test("recall keeps the first five in order when there are no conflicts", async () => {
  const ranked = Array.from({ length: 6 }, () => ({ ...entry, id: crypto.randomUUID() }));
  const result = await recallTaskMemory(task, async () => ({ status: "ok", entries: ranked }));
  expect(result.map(({ id }) => id)).toEqual(ranked.slice(0, 5).map(({ id }) => id));
});

test("recall includes multiple conflicting versions when all of them fit", async () => {
  const ranked = Array.from({ length: 6 }, () => ({ ...entry, id: crypto.randomUUID() }));
  const approval = ranked[0]!;
  const objections = [ranked[1]!, ranked[5]!];
  const result = await recallTaskMemory(task, async () => ({
    status: "ok",
    entries: [
      {
        ...approval,
        relations: objections.map(({ id, revision }) => ({ kind: "conflicts_with", id, revision })),
      },
      ...ranked.slice(1),
    ],
  }));
  expect(result.map(({ id }) => id)).toEqual([
    ...ranked.slice(0, 4).map(({ id }) => id),
    objections[1]!.id,
  ]);
});

test("recall reports a match, a miss, a timeout and a search failure without task text", async () => {
  const logged = spyOn(console, "info").mockImplementation(() => {});
  try {
    await recallTaskMemory(task, async () => ({ status: "ok", entries: [entry] }));
    await recallTaskMemory(task, async () => ({ status: "ok", entries: [] }));
    await recallTaskMemory(task, () => Promise.withResolvers<TeamMemoryResult>().promise, 5);
    await recallTaskMemory(task, async () => {
      throw new Error(task.description);
    });
    const logs = logged.mock.calls.map(([line]) => JSON.parse(line));
    expect(logs.map(({ outcome }) => outcome)).toEqual(["hit", "miss", "timeout", "error"]);
    expect(logs.map(({ count }) => count)).toEqual([1, 0, 0, 0]);
    expect(JSON.stringify(logs)).not.toContain(task.description);
    expect(JSON.stringify(logs)).not.toContain(task.title);
  } finally {
    logged.mockRestore();
  }
});
