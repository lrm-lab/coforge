import { expect, test } from "bun:test";

test("loadCollectorRunMetadata deduplicates run ids and reads distinct runs concurrently", async () => {
  const { loadCollectorRunMetadata } =
    await import("#src/server/records/weekly-report-collect-run-metadata.server");
  const runIds = ["run-a", "run-a", "run-b", "run-c"];
  const metadata = new Map([
    ["run-a", { reportId: "report-a", userId: "user-a" }],
    ["run-b", { reportId: "report-b", userId: "user-b" }],
    ["run-c", { reportId: "report-c", userId: "user-c" }],
  ]);
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const pause = () => new Promise((resolve) => setTimeout(resolve, 2));
  const db = {
    weeklyReportCollectRun: {
      findFirst: async ({ where }: { where: { id: string } }) => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await pause();
        active -= 1;
        return metadata.get(where.id) ?? null;
      },
    },
  };

  const result = await loadCollectorRunMetadata(db as never, {
    workspaceId: "ws-1",
    runIds,
  });

  expect(calls).toBe(3);
  expect(maxActive).toBeGreaterThan(1);
  expect(result.get("run-a")).toEqual({ reportId: "report-a", userId: "user-a" });
  expect(result.get("run-c")).toEqual({ reportId: "report-c", userId: "user-c" });
});
