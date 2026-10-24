import { describe, expect, test } from "bun:test";
import {
  CAST_TIMING,
  castArrived,
  castEntered,
  initialCast,
  stageCapacity,
  stepCast,
  waitingCount,
  type CastInput,
  type CastState,
} from "#src/features/agents/busy-agents-cast";

// A fixed random source: 0.5 picks the middle of every range and adds no tie-break noise.
const half = () => 0.5;
const NONE = new Set<string>();

function input(overrides: Partial<CastInput> = {}): CastInput {
  return { busy: [], capacity: 4, now: 0, held: NONE, reduced: false, ...overrides };
}

const ids = (state: CastState) => state.members.map((member) => member.id);
const phases = (state: CastState) => state.members.map((member) => [member.id, member.phase]);

/** Runs the cast forward to `until`, one step per second, finishing every entrance and exit at
 * once, as the stage does when an animation ends. */
function run(state: CastState, base: Omit<CastInput, "now">, from: number, until: number) {
  let next = state;
  for (let now = from; now <= until; now += 1_000) {
    next = stepCast(next, { ...base, now }, half);
    for (const member of next.members) {
      if (member.phase === "entering") next = castEntered(next, member.id, now);
      if (member.phase === "leaving") next = castArrived(next, member.id, now);
    }
  }
  return next;
}

describe("stageCapacity", () => {
  test("fits one mascot per 34px, at least three and at most five", () => {
    expect(stageCapacity(60)).toBe(3);
    expect(stageCapacity(140)).toBe(4);
    expect(stageCapacity(170)).toBe(5);
    expect(stageCapacity(600)).toBe(5);
  });
});

describe("stepCast", () => {
  test("the first step puts the most relevant busy Agents straight on stage", () => {
    const state = stepCast(initialCast(), input({ busy: ["a", "b", "c", "d", "e", "f"] }), half);
    expect(phases(state)).toEqual([
      ["a", "on"],
      ["b", "on"],
      ["c", "on"],
      ["d", "on"],
    ]);
    expect(waitingCount(state.members, ["a", "b", "c", "d", "e", "f"])).toBe(2);
  });

  test("fewer busy Agents than room puts every one of them on stage and none waiting", () => {
    const state = stepCast(initialCast(), input({ busy: ["a", "b"] }), half);
    expect(ids(state)).toEqual(["a", "b"]);
    expect(waitingCount(state.members, ["a", "b"])).toBe(0);
  });

  test("an Agent that stops leaves the stage and never comes back while it stays stopped", () => {
    let state = stepCast(initialCast(), input({ busy: ["a", "b"] }), half);
    state = stepCast(state, input({ busy: ["b"], now: 1_000 }), half);
    expect(phases(state)).toEqual([
      ["a", "leaving"],
      ["b", "on"],
    ]);
    state = castArrived(state, "a", 2_000);
    state = run(state, { busy: ["b"], capacity: 4, held: NONE, reduced: false }, 3_000, 120_000);
    expect(ids(state)).toEqual(["b"]);
  });

  test("nobody rotates off while no one is waiting", () => {
    let state = stepCast(initialCast(), input({ busy: ["a", "b"] }), half);
    state = stepCast(state, input({ busy: ["a", "b"], now: CAST_TIMING.stayMs[1] * 3 }), half);
    expect(phases(state)).toEqual([
      ["a", "on"],
      ["b", "on"],
    ]);
  });

  test("an Agent past its stay makes room for one waiting, unless the viewer is holding it", () => {
    const busy = ["a", "b", "c", "d", "e"];
    let state = stepCast(initialCast(), input({ busy }), half);
    const late = CAST_TIMING.stayMs[1] + 1;
    const held = stepCast(
      state,
      input({ busy, now: late, held: new Set(["a", "b", "c", "d"]) }),
      half,
    );
    expect(held.members.every((member) => member.phase === "on")).toBe(true);
    state = stepCast(state, input({ busy, now: late }), half);
    expect(state.members.filter((member) => member.phase === "leaving")).toHaveLength(1);
  });

  test("one Agent at a time leaves, and the next comes out only after a gap", () => {
    const busy = ["a", "b", "c", "d", "e"];
    let state = stepCast(initialCast(), input({ busy }), half);
    const late = CAST_TIMING.stayMs[1] + 1;
    state = stepCast(state, input({ busy, now: late }), half);
    const leaving = state.members.find((member) => member.phase === "leaving")!.id;
    state = castArrived(state, leaving, late + 500);
    state = stepCast(state, input({ busy, now: late + 600 }), half);
    expect(state.members.some((member) => member.phase === "entering")).toBe(false);
    state = stepCast(state, input({ busy, now: late + 500 + CAST_TIMING.afterLeaveMs[1] }), half);
    expect(state.members.find((member) => member.phase === "entering")?.id).toBe("e");
  });

  test("a newly busy Agent comes out before the ones that were already waiting", () => {
    const busy = ["a", "b", "c", "d", "e"];
    let state = stepCast(initialCast(), input({ busy }), half);
    const late = CAST_TIMING.stayMs[1] + 1;
    const withNew = ["n", ...busy];
    state = stepCast(state, input({ busy: withNew, now: late }), half);
    const leaving = state.members.find((member) => member.phase === "leaving")!.id;
    state = castArrived(state, leaving, late + 500);
    state = stepCast(state, input({ busy: withNew, now: late + 500 + CAST_TIMING.gapMs[1] }), half);
    expect(state.members.find((member) => member.phase === "entering")?.id).toBe("n");
  });

  test("an Agent that went idle and is busy again counts as newly busy", () => {
    const busy = ["a", "b", "c", "d", "e", "f"];
    let state = stepCast(initialCast(), input({ busy }), half);
    // "f" waits; it stops, then everyone else keeps going while it is gone a while.
    state = stepCast(state, input({ busy: ["a", "b", "c", "d", "e"], now: 1_000 }), half);
    expect(state.seen.has("f")).toBe(false);
    // "e" waits too and has been seen; "f" returns busy as the least relevant.
    const late = CAST_TIMING.stayMs[1] + 1;
    state = stepCast(state, input({ busy, now: late }), half);
    const leaving = state.members.find((member) => member.phase === "leaving")!.id;
    state = castArrived(state, leaving, late + 500);
    state = stepCast(state, input({ busy, now: late + 500 + CAST_TIMING.gapMs[1] }), half);
    expect(state.members.find((member) => member.phase === "entering")?.id).toBe("f");
  });

  test("over time every busy Agent gets a turn on stage, recently shown ones going to the back", () => {
    const busy = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const shown = new Set<string>();
    let state = stepCast(initialCast(), input({ busy }), half);
    for (let now = 1_000; now <= 600_000; now += 1_000) {
      state = stepCast(state, input({ busy, now }), half);
      for (const member of state.members) {
        shown.add(member.id);
        if (member.phase === "entering") state = castEntered(state, member.id, now);
        if (member.phase === "leaving") state = castArrived(state, member.id, now);
      }
    }
    expect([...shown].sort()).toEqual(busy);
  });

  test("a narrower stage sends the least relevant Agents off", () => {
    const busy = ["a", "b", "c", "d", "e"];
    let state = stepCast(initialCast(), input({ busy, capacity: 5 }), half);
    state = stepCast(state, input({ busy, capacity: 3, now: 1_000 }), half);
    expect(phases(state)).toEqual([
      ["a", "on"],
      ["b", "on"],
      ["c", "on"],
      ["d", "leaving"],
      ["e", "leaving"],
    ]);
  });

  test("never more Agents on stage, leaving ones included, than the stage holds", () => {
    const busy = ["a", "b", "c", "d", "e", "f", "g"];
    let state = stepCast(initialCast(), input({ busy, capacity: 3 }), half);
    for (let now = 1_000; now <= 300_000; now += 1_000) {
      state = stepCast(state, input({ busy, capacity: 3, now }), half);
      expect(state.members.length).toBeLessThanOrEqual(3);
      for (const member of state.members)
        if (member.phase === "entering") state = castEntered(state, member.id, now);
      if (now % 7_000 === 0)
        for (const member of state.members)
          if (member.phase === "leaving") state = castArrived(state, member.id, now);
    }
  });

  test("with reduced motion the stage holds the most relevant Agents still and never rotates", () => {
    const busy = ["a", "b", "c", "d", "e"];
    let state = stepCast(initialCast(), input({ busy, reduced: true }), half);
    state = stepCast(state, input({ busy, reduced: true, now: 600_000 }), half);
    expect(phases(state)).toEqual([
      ["a", "on"],
      ["b", "on"],
      ["c", "on"],
      ["d", "on"],
    ]);
    state = stepCast(
      state,
      input({ busy: ["b", "c", "d", "e"], reduced: true, now: 601_000 }),
      half,
    );
    expect(ids(state)).toEqual(["b", "c", "d", "e"]);
  });
});
