import { expect, test } from "bun:test";
import type { TeamMemoryHead } from "@lrm/coforge-sdk/agent";
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
