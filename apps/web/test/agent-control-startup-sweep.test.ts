import { expect, test } from "bun:test";
import { AgentControlStartupSweep } from "#src/server/agents/agent-control-startup-sweep.server";

function sweep(options: {
  pages: { ids: string[]; next?: { deadlineAtMs: number; id: string } }[];
  locked?: boolean;
  failOn?: string;
}) {
  const asked: { now: number; limit: number; after: unknown }[] = [];
  const settled: string[] = [];
  const pages = [...options.pages];
  const instance = new AgentControlStartupSweep({
    store: {
      listStartupCandidates: async (now, limit, after) => {
        asked.push({ now, limit, after });
        const page = pages.shift() ?? { ids: [] };
        return { ids: page.ids, next: page.next };
      },
    },
    timeout: {
      settle: async (id) => {
        if (id === options.failOn) throw new Error("boom");
        settled.push(id);
        return "failed";
      },
    },
    lock: { acquire: async () => options.locked !== false },
    clock: () => 5_000,
  });
  return { instance, asked, settled };
}

test("a tick without the lock does no work", async () => {
  const f = sweep({ pages: [{ ids: ["a"] }], locked: false });
  await f.instance.tick();
  expect(f.asked).toHaveLength(0);
});

test("a tick settles each candidate in order and follows the cursor to the next batch", async () => {
  const f = sweep({
    pages: [{ ids: ["a", "b"], next: { deadlineAtMs: 10, id: "b" } }, { ids: ["c"] }],
  });
  await f.instance.tick();
  expect(f.settled).toEqual(["a", "b", "c"]);
  expect(f.asked.map((call) => call.limit)).toEqual([50, 50]);
  expect(f.asked[0]).toMatchObject({ now: 5_000, after: undefined });
  expect(f.asked[1]!.after).toEqual({ deadlineAtMs: 10, id: "b" });
});

test("an Agent that cannot be settled does not stop the others", async () => {
  const f = sweep({ pages: [{ ids: ["a", "bad", "c"] }], failOn: "bad" });
  const original = console.error;
  const logged: string[] = [];
  console.error = (line: string) => void logged.push(line);
  try {
    await f.instance.tick();
  } finally {
    console.error = original;
  }
  expect(f.settled).toEqual(["a", "c"]);
  expect(JSON.parse(logged[0]!)).toMatchObject({
    event: "agent_control_startup_sweep:agent_failed",
    agent_id: "bad",
  });
});

test("one tick reads at most four batches however many candidates there are", async () => {
  const endless = Array.from({ length: 10 }, (_, index) => ({
    ids: [`a${index}`],
    next: { deadlineAtMs: index, id: `a${index}` },
  }));
  const f = sweep({ pages: endless });
  await f.instance.tick();
  expect(f.asked).toHaveLength(4);
});

test("the next tick resumes where the last one stopped and starts over after a full pass", async () => {
  const f = sweep({
    pages: [
      { ids: ["a"], next: { deadlineAtMs: 1, id: "a" } },
      { ids: ["b"], next: { deadlineAtMs: 2, id: "b" } },
      { ids: ["c"], next: { deadlineAtMs: 3, id: "c" } },
      { ids: ["d"], next: { deadlineAtMs: 4, id: "d" } },
      { ids: ["e"] },
    ],
  });
  await f.instance.tick();
  expect(f.settled).toEqual(["a", "b", "c", "d"]);
  await f.instance.tick();
  expect(f.asked[4]!.after).toEqual({ deadlineAtMs: 4, id: "d" });
  expect(f.settled).toEqual(["a", "b", "c", "d", "e"]);
  await f.instance.tick();
  expect(f.asked[5]!.after).toBeUndefined();
});
