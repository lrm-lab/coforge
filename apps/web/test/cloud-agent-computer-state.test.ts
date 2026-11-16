import { describe, expect, test } from "bun:test";
import { cloudAgentComputerState } from "#src/server/agents/cloud-agent-computer.server";

const now = new Date("2026-11-16T12:00:00Z");
const settled = {
  containerReady: true,
  workPending: false,
  everConnected: true,
  lastReportedAt: new Date("2026-11-16T10:00:00Z"),
};

describe("the cloud computer's state for a new cloud Agent", () => {
  test("ready only when online, nothing pending, and Pi runs", () => {
    expect(cloudAgentComputerState(settled, { online: true, runsPi: true }, now)).toBe("ready");
  });

  test("online but Pi not reported yet is starting", () => {
    expect(cloudAgentComputerState(settled, { online: true, runsPi: false }, now)).toBe("starting");
  });

  test("online with cluster work still open (format, update, attach here) is starting", () => {
    expect(
      cloudAgentComputerState(
        { ...settled, workPending: true },
        { online: true, runsPi: true },
        now,
      ),
    ).toBe("starting");
  });

  test("not placed, or never connected, is starting", () => {
    const offline = { online: false, runsPi: false };
    expect(cloudAgentComputerState({ ...settled, containerReady: false }, offline, now)).toBe(
      "starting",
    );
    expect(cloudAgentComputerState({ ...settled, everConnected: false }, offline, now)).toBe(
      "starting",
    );
  });

  test("a container placed or attached moments ago is starting while its daemon connects", () => {
    expect(
      cloudAgentComputerState(
        { ...settled, lastReportedAt: new Date("2026-11-16T11:59:00Z") },
        { online: false, runsPi: false },
        now,
      ),
    ).toBe("starting");
  });

  test("placed, connected before, nothing pending and not online is offline", () => {
    expect(cloudAgentComputerState(settled, { online: false, runsPi: false }, now)).toBe("offline");
  });
});
