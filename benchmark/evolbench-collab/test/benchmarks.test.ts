import { describe, expect, test } from "bun:test";
import { profileFor, reminderForEpisode } from "../src/benchmarks";
import { summarizeArm } from "../src/report";
import type { AttemptRow } from "../src/types";

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
