import { expect, test } from "bun:test";
import { LaunchPhaseTiming } from "#src/daemon-runtime/launch-phase-timing";
import { captureDaemonLogs } from "./log-capture";

test("a launch logs each phase once with its elapsed and since-previous times", async () => {
  const { records } = await captureDaemonLogs(async () => {
    const timing = new LaunchPhaseTiming({
      agentId: "agent-a",
      launchId: "launch-a",
      provider: "kiro",
    });
    timing.phase("admitted");
    timing.phase("config");
    // A second arrival of the same phase is not news.
    timing.phase("config");
    timing.phase("provider_session");
    timing.phase("session_reported");
    timing.phase("first_activity");
  });
  const phases = records.filter((record) => record.properties.event === "agent_launch:phase");
  expect(phases.map((record) => record.properties.phase)).toEqual([
    "admitted",
    "config",
    "provider_session",
    "session_reported",
    "first_activity",
  ]);
  for (const record of phases) {
    expect(record.properties.agent_id).toBe("agent-a");
    expect(record.properties.launch_id).toBe("launch-a");
    expect(record.properties.provider).toBe("kiro");
    expect(typeof record.properties.elapsed_ms).toBe("number");
    expect(typeof record.properties.since_previous_ms).toBe("number");
  }
});
