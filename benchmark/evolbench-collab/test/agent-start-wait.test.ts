import { expect, test } from "bun:test";
import { waitForAgentStart } from "../src/agent-start-wait";

test("pending is polled without replacing the in-flight start request", async () => {
  const requestId = "same-launch";
  let calls = 0;
  const waits: number[] = [];
  const joined: (string | undefined)[] = [];
  await waitForAgentStart(
    "memory",
    async (id) => {
      joined.push(id);
      return {
        requestId,
        action: "start",
        phase: ++calls < 3 ? "pending" : "completed",
      };
    },
    async (ms) => {
      waits.push(ms);
    },
  );
  expect(calls).toBe(3);
  expect(joined).toEqual([undefined, requestId, requestId]);
  expect(waits).toEqual([1000, 1000]);
});

test("terminal launch failure is preserved and never retried as pending", async () => {
  let calls = 0;
  await expect(
    waitForAgentStart(
      "memory",
      async () => {
        calls++;
        return {
          requestId: "launch",
          action: "start",
          phase: "failed",
          error: "provider-rejected",
        };
      },
      async () => {},
    ),
  ).rejects.toThrow("provider-rejected");
  expect(calls).toBe(1);
});

test("a permanently pending launch stops after three bounded observations", async () => {
  let calls = 0;
  await expect(
    waitForAgentStart(
      "memory",
      async () => {
        calls++;
        return { requestId: "launch", action: "start", phase: "pending" };
      },
      async () => {},
    ),
  ).rejects.toThrow("pending after 3 observations");
  expect(calls).toBe(3);
});
