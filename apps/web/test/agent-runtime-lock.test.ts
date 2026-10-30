import { describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PostgresAgentRuntimeLock } from "#src/server/agents/agent-runtime-lock.server";

describe("PostgresAgentRuntimeLock", () => {
  test("uses one checked-out connection for a parameterized session lock", async () => {
    const events: string[] = [];
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const client = Object.assign(new EventEmitter(), {
      query: async (text: string, values: unknown[]) => {
        queries.push({ text, values });
        events.push(text.includes("unlock") ? "unlock" : "lock");
        return { rows: text.includes("unlock") ? [{ unlocked: true }] : [] };
      },
      release: (destroy = false) => events.push(destroy ? "destroy" : "release"),
    });
    const lock = new PostgresAgentRuntimeLock({
      connect: async () => client as never,
    } as never);

    const result = await lock.run("agent-'unsafe", async () => {
      events.push("callback");
      return "done";
    });

    expect(result).toBe("done");
    expect(events).toEqual(["lock", "callback", "unlock", "release"]);
    expect(queries).toEqual([
      {
        text: "SELECT pg_advisory_lock(hashtextextended($1, 0))",
        values: ["agent-'unsafe"],
      },
      {
        text: "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked",
        values: ["agent-'unsafe"],
      },
    ]);
  });

  test("unlocks and releases the connection when the callback fails", async () => {
    const events: string[] = [];
    const client = Object.assign(new EventEmitter(), {
      query: async (text: string) => {
        events.push(text.includes("unlock") ? "unlock" : "lock");
        return { rows: text.includes("unlock") ? [{ unlocked: true }] : [] };
      },
      release: () => events.push("release"),
    });
    const lock = new PostgresAgentRuntimeLock({
      connect: async () => client as never,
    } as never);

    await expect(
      lock.run("agent-1", async () => {
        events.push("callback");
        throw new Error("mutation failed");
      }),
    ).rejects.toThrow("mutation failed");
    expect(events).toEqual(["lock", "callback", "unlock", "release"]);
  });

  test("a connection lost while the lock is held is logged, not thrown, and destroyed", async () => {
    const events: string[] = [];
    const client = Object.assign(new EventEmitter(), {
      query: async (text: string) => {
        if (text.includes("unlock")) throw new Error("Connection terminated unexpectedly");
        return { rows: [] };
      },
      release: (destroy = false) => events.push(destroy ? "destroy" : "release"),
    });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const lock = new PostgresAgentRuntimeLock({
      connect: async () => client as never,
    } as never);
    try {
      await expect(
        lock.run("agent-1", async () => {
          client.emit("error", new Error("Connection terminated unexpectedly"));
        }),
      ).rejects.toThrow("Connection terminated unexpectedly");
      expect(events).toEqual(["destroy"]);
      expect(client.listenerCount("error")).toBe(0);
      expect(JSON.parse(String(errors.mock.calls[0]?.[0]))).toEqual({
        event: "agent_runtime_lock:connection_lost",
        agent_id: "agent-1",
        error_type: "Error",
      });
    } finally {
      errors.mockRestore();
    }
  });
});
