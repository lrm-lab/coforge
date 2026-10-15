import { describe, expect, test } from "bun:test";
import { profileFor, reminderForEpisode } from "../src/benchmarks";
import { classifyMechanism } from "../src/leak";
import { summarizeArm } from "../src/report";
import {
  episodePrompt,
  episodeTerminationReason,
  createEpisodeRuntimeDiagnostics,
} from "../src/eval-qa";
import type { AttemptRow } from "../src/types";
import type { EpisodeResult } from "../src/eval-qa";
import { TASK_AGENT_DESCRIPTION } from "../src/workspace";

test("Task role gates implementation on the current claim and verifies final submission", () => {
  for (const term of [
    "read the original channel prompt",
    "prepare analysis",
    "this episode's claim",
    "claim fails",
    "stop implementation",
    "report the blocker",
    "no intermediate progress",
    "last non-request Task channel message",
    "accepted=true",
    "--json",
    "state=sent",
    "messageId",
    "Without a receipt",
  ]) {
    expect(TASK_AGENT_DESCRIPTION).toContain(term);
  }
});

test("termination reasons preserve channel budgets and identify terminal blockers", () => {
  expect(episodeTerminationReason("deadline", true)).toBe("deadline");
  expect(episodeTerminationReason("quiet_no_offer", false)).toBe("quiet_no_offer");
  expect(episodeTerminationReason("final_settled", true)).toBe("final_settled");
  expect(
    episodeTerminationReason("deadline", true, { taskFailed: true, memoryFailed: false }),
  ).toBe("runtime_failed");
  expect(
    episodeTerminationReason("quiet_no_offer", false, { taskFailed: false, memoryFailed: true }),
  ).toBe("runtime_failed");
  expect(
    episodeTerminationReason("deadline", true, { taskFailed: false, memoryFailed: true }),
  ).toBe("deadline");
  expect(
    episodeTerminationReason("final_settled", true, { taskFailed: true, memoryFailed: true }),
  ).toBe("final_settled");
});

test("runtime diagnostics wait for terminal settlement and reset per episode", () => {
  const diagnostics = createEpisodeRuntimeDiagnostics();
  diagnostics.observe(
    "task",
    { type: "error", message: "sensitive upstream body", retryable: true },
    100,
  );
  expect(diagnostics.snapshot()).toEqual({
    runtimeErrorCount: 1,
    lastRuntimeErrorAt: 100,
    taskFailed: false,
    memoryFailed: false,
    taskRunning: false,
    memoryRunning: false,
  });
  diagnostics.observe("task", { type: "completed", status: "failed" }, 110);
  expect(diagnostics.snapshot().taskFailed).toBe(true);
  diagnostics.observe("task", { type: "progress" }, 120);
  expect(diagnostics.snapshot().taskFailed).toBe(false);
  diagnostics.observe("task", { type: "tool-end", id: "ok", isError: false }, 130);
  expect(diagnostics.snapshot().lastProgressAt).toBe(130);
  diagnostics.observe("memory", { type: "completed", status: "failed" }, 140);
  expect(diagnostics.snapshot().memoryFailed).toBe(true);
  expect(JSON.stringify(diagnostics.snapshot())).not.toContain("sensitive");
  diagnostics.reset();
  expect(diagnostics.snapshot()).toEqual({
    runtimeErrorCount: 0,
    taskFailed: false,
    memoryFailed: false,
    taskRunning: false,
    memoryRunning: false,
  });
});

describe("benchmark registry", () => {
  test("all five evol_bench manifests have profiles", () => {
    for (const benchmark of [
      "evoagentbench",
      "agentstream",
      "skilllearnbench",
      "past_bench",
      "earthbench",
    ]) {
      const profile = profileFor(benchmark);
      expect(profile.publishReminder.length).toBeGreaterThan(20);
      expect(profile.episodeTimeoutMs).toBeGreaterThan(0);
    }
  });

  test("agentstream function_calling uses the call-list contract", () => {
    expect(reminderForEpisode("agentstream", "function_calling")).toContain("Python-call list");
    expect(reminderForEpisode("agentstream", "code")).toContain("code");
    expect(reminderForEpisode("evoagentbench", "code_implementation")).toContain("fenced");
  });

  test("unknown benchmarks fall back to the generic reminder", () => {
    expect(profileFor("mystery").publishReminder).toContain("final answer");
  });

  test("only EvoAgentBench SWE uses the source patch submission contract", () => {
    const reminder = reminderForEpisode("evoagentbench", "software_engineering");
    for (const term of [
      "path specified by the task",
      "nonempty",
      "source-only",
      "patch.diff",
      "clean base",
      "TASK_COMPLETE",
      "channel send",
      "actual validation",
      "incomplete",
      "blocker",
    ]) {
      expect(reminder).toContain(term);
    }
    expect(reminder).not.toContain("complete final code");
    expect(reminderForEpisode("evoagentbench", "code_implementation")).toContain(
      "complete final code",
    );
    expect(reminderForEpisode("agentstream", "software_engineering")).toContain(
      "complete final code",
    );
  });
});

describe("episodePrompt", () => {
  test("addresses both agents so Memory can retrieve from the initial task", () => {
    const prompt = episodePrompt(
      {
        benchmark: "past_bench",
        episodeId: "e",
        taskId: "t",
        familyId: "f",
        domain: "",
        split: "test",
        role: "qa",
        order: 1,
        prompt: "Summarize the notes.",
        grader: { kind: "x" },
        stageFiles: [],
      },
      reminderForEpisode("past_bench", ""),
    );
    expect(prompt.startsWith("@task @memory Summarize the notes.")).toBe(true);
    expect(prompt).toContain("Channel note:");
  });
});

describe("classifyMechanism", () => {
  const base: EpisodeResult = {
    finalOutput: "```python\nprint(1)\n```",
    offerMessageId: "offer-1",
    citationCount: 2,
    taskMessageCount: 1,
    memoryLeakMessageIds: [],
    timedOut: false,
    elapsedMs: 1000,
    terminationReason: "final_settled",
    runtimeErrorCount: 0,
  };

  test("cited offer plus posted answer is ok", () => {
    expect(classifyMechanism(base)).toBe("ok");
  });

  test("answer without recall is no_offer; leak dominates; timeout keeps the answer", () => {
    expect(classifyMechanism({ ...base, offerMessageId: null })).toBe("no_offer");
    expect(classifyMechanism({ ...base, memoryLeakMessageIds: ["m"] })).toBe("leak");
    expect(classifyMechanism({ ...base, citationCount: 0 })).toBe("uncited_offer");
    expect(classifyMechanism({ ...base, timedOut: true })).toBe("timeout");
    expect(classifyMechanism({ ...base, finalOutput: null })).toBe("no_reply");
  });
});

describe("summarizeArm", () => {
  test("aggregates arm rows", () => {
    const row: AttemptRow = {
      run_id: "r:e:1:warm",
      benchmark: "past_bench",
      task_id: "t",
      episode_id: "e",
      family_id: "f",
      domain: "",
      arm: "warm",
      memory_policy: "read_write",
      seed: 1,
      attempt: 1,
      status: "success",
      duration_seconds: 12.5,
      work_dir: "/tmp/w",
      final_output: "answer",
      recall_state: "cited",
      recall_citations: 2,
      mechanism: "ok",
      task_message_count: 1,
      memory_leak_count: 0,
      error: null,
    };
    const summary = summarizeArm("warm", [
      row,
      { ...row, episode_id: "e2", mechanism: "no_offer", recall_state: "empty" },
    ]);
    expect(summary.episodes).toBe(2);
    expect(summary.families).toBe(1);
    expect(summary.offeredRecall).toBe(1);
    expect(summary.mechanismFails).toBe(1);
  });
});

test("a cited Hint without the Task's native disposition is a mechanism failure", () => {
  const result: EpisodeResult = {
    finalOutput: "answer",
    offerMessageId: "offer",
    citationCount: 1,
    taskMessageCount: 1,
    memoryLeakMessageIds: [],
    timedOut: false,
    elapsedMs: 1,
    terminationReason: "final_settled",
    runtimeErrorCount: 0,
    memoryHintIds: ["hint-1"],
    dispositions: [],
  };
  expect(classifyMechanism(result)).toBe("missing_disposition");
  expect(result.finalOutput).toBe("answer");
});
