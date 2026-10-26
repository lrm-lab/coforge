import { expect, test } from "bun:test";
import { GrokConnection } from "#src/grok/connection";
import { exitingTree } from "./fixtures/acp-drain";
import { fixtureGrokHost } from "./fixtures/grok-host";

test.each([0, 100])(
  "Grok: a response written after %d notifications and just before the process exits is delivered",
  async (notifications) => {
    const updates: string[] = [];
    const connection = new GrokConnection(
      ["unused"],
      ".",
      {},
      { ...fixtureGrokHost, processTreeSpawner: { spawn: () => exitingTree(notifications, {}) } },
      (method) => updates.push(method),
      () => ({ outcome: { outcome: "cancelled" } }),
    );
    try {
      await connection.connection.agent.request("authenticate", { methodId: "m" });
      expect(updates).toEqual(Array(notifications).fill("session/update"));
      await connection.connection.closed;
    } finally {
      await connection.dispose();
    }
  },
);
