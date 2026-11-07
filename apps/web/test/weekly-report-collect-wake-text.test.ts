import { expect, test } from "bun:test";

test("buildCollectSynthesizerWakeText includes status board and ready packs", async () => {
  const { buildCollectSynthesizerWakeText } =
    await import("#src/server/records/weekly-report-collect-orchestrate.server");
  const text = buildCollectSynthesizerWakeText({
    reportId: "report-1",
    runId: "run-1",
    slots: [
      {
        computerLabel: "ubuntu",
        status: "ready",
        packMarkdown: "## Evidence\n- shipped feature",
        failureReason: null,
      },
      {
        computerLabel: "mac",
        status: "failed",
        packMarkdown: null,
        failureReason: "auth expired",
      },
    ],
  });
  expect(text).toContain("reportId=report-1");
  expect(text).toContain("- ubuntu: ready");
  expect(text).toContain("- mac: failed: auth expired");
  expect(text).toContain("### Pack · ubuntu");
  expect(text).toContain("shipped feature");
  expect(text).toContain("[weekly-report-suggestion]");
  expect(text).toContain("采集包应已按作者过滤");
  expect(text).not.toContain("用户调整要求");
});

test("buildCollectorWakeBody requires owner-scoped harvest and lists identity hints", async () => {
  const { buildCollectorWakeBody } =
    await import("#src/server/records/weekly-report-collect-dispatch.server");
  const text = buildCollectorWakeBody({
    runId: "run-1",
    reportId: "report-1",
    slotId: "slot-1",
    windowStart: new Date("2026-09-14T00:00:00.000Z"),
    windowEnd: new Date("2026-09-21T00:00:00.000Z"),
    scanPaths: ["/home/jian40/Coforge"],
    ownerUsername: "lijiannankai-95827c9b",
    ownerDisplayName: "Li Jian",
    ownerGitHubLogin: "lijiannankai",
  });
  expect(text).toContain("只采集本报告作者本人的工作");
  expect(text).toContain("ownerUsername=lijiannankai-95827c9b");
  expect(text).toContain("ownerDisplayName=Li Jian");
  expect(text).toContain("ownerGitHubLogin=lijiannankai");
  expect(text).toContain("- /home/jian40/Coforge");
});

test("buildCollectSynthesizerWakeText forwards user revision guidance", async () => {
  const { buildCollectSynthesizerWakeText } =
    await import("#src/server/records/weekly-report-collect-orchestrate.server");
  const text = buildCollectSynthesizerWakeText({
    reportId: "report-1",
    runId: "run-1",
    userGuidance: "刚才整理的周报太细碎了，帮我抽取的更概括一些",
    slots: [
      {
        computerLabel: "ubuntu",
        status: "ready",
        packMarkdown: "## Evidence\n- shipped feature",
        failureReason: null,
      },
    ],
  });
  expect(text).toContain("## 用户调整要求");
  expect(text).toContain("刚才整理的周报太细碎了，帮我抽取的更概括一些");
});

test("buildCollectSynthesizerWakeText includes active habits and open threads", async () => {
  const { buildCollectSynthesizerWakeText } =
    await import("#src/server/records/weekly-report-collect-orchestrate.server");
  const text = buildCollectSynthesizerWakeText({
    reportId: "report-1",
    runId: "run-1",
    memoryPrompt: {
      writingHabits: ["先写结果"],
      openThreads: [{ title: "采集服务", status: "done" }],
    },
    slots: [],
  });
  expect(text).toContain("## 写作习惯");
  expect(text).toContain("- 先写结果");
  expect(text).toContain("- 采集服务：上周已完成");
  expect(text).not.toContain("提交次数");
});
