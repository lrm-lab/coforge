import { describe, expect, test } from "bun:test";
import {
  extractFnMap,
  judgeFunctions,
  nameStats,
  p95,
  parseLogWindow,
  type FnStat,
  type NamedStat,
} from "./perf-regression-check.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_G = "g".repeat(64);

function finished(fn: string, status: number, duration_ms: number) {
  return JSON.stringify({ event: "server_fn.finished", fn, status, duration_ms });
}

function stat(count: number, p95ms: number, failures5xx = 0): NamedStat {
  return { name: "fn", count, p95: p95ms, failures5xx };
}

describe("parseLogWindow", () => {
  test("collects finished calls with status and duration", () => {
    const stats = parseLogWindow(
      [
        finished(HASH_A, 200, 120),
        finished(HASH_A, 503, 80),
        '{"event":"server_fn.running","fn":"x"}',
        '{"event":"server_fn.aborted","fn":"x"}',
        "not json at all",
        "",
      ].join("\n"),
    );
    const a = stats.get(HASH_A)!;
    expect(a.count).toBe(2);
    expect(a.durations).toEqual([120, 80]);
    expect(a.failures5xx).toBe(1);
    expect(stats.has("x")).toBe(false);
  });

  test("counts server_fn.failed as a 5xx-class failure without a duration", () => {
    const stats = parseLogWindow(
      JSON.stringify({ event: "server_fn.failed", fn: HASH_B, duration_ms: 40 }),
    );
    const b = stats.get(HASH_B)!;
    expect(b.count).toBe(1);
    expect(b.failures5xx).toBe(1);
    expect(b.durations).toEqual([]);
  });
});

describe("p95", () => {
  test("nearest-rank over sorted durations", () => {
    expect(p95([])).toBeNull();
    expect(p95([5])).toBe(5);
    expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
    expect(p95([300, 100, 200])).toBe(300);
  });
});

describe("nameStats", () => {
  test("merges hashes that share a name and marks unmapped hashes", () => {
    const raw = new Map<string, FnStat>([
      [HASH_A, { count: 2, durations: [10, 20], failures5xx: 0 }],
      [HASH_B, { count: 1, durations: [30], failures5xx: 1 }],
    ]);
    const named = nameStats(raw, { [HASH_A]: "alpha", [HASH_B]: "alpha" });
    expect(named.get("alpha")).toMatchObject({ count: 3, failures5xx: 1 });
    expect(named.get("alpha")!.p95).toBe(30);
    const unknown = nameStats(
      new Map([[HASH_G, { count: 1, durations: [1], failures5xx: 0 }]]),
      {},
    );
    expect(unknown.has(`(unknown ${HASH_G.slice(0, 12)})`)).toBe(true);
  });
});

describe("extractFnMap", () => {
  test("pairs export names with their 64-hex ids", () => {
    const bundle = [
      `const alpha_createServerFn_handler = createServerRpc({ id: "${HASH_A}" });`,
      `const beta_createServerFn_handler = createServerRpc({ id: "${HASH_B}", method: "GET" });`,
      "unrelated()",
    ].join("\n");
    expect(extractFnMap(bundle)).toEqual({ [HASH_A]: "alpha", [HASH_B]: "beta" });
  });
});

describe("judgeFunctions", () => {
  const window = (entries: Record<string, NamedStat>) => new Map(Object.entries(entries));

  test("flags p95 doubling with a >=100ms floor", () => {
    const result = judgeFunctions(
      window({ alpha: { ...stat(40, 200), name: "alpha" } }),
      window({ alpha: { ...stat(40, 350), name: "alpha" } }),
      30,
    );
    expect(result.judged).toBe(1);
    expect(result.regressions).toHaveLength(0); // +150ms but only 1.75x? no: 350>=400 fails
    const doubled = judgeFunctions(
      window({ alpha: { ...stat(40, 200), name: "alpha" } }),
      window({ alpha: { ...stat(40, 450), name: "alpha" } }),
      30,
    );
    expect(doubled.regressions[0]).toMatchObject({ name: "alpha", rule: "p95" });
  });

  test("does not flag a doubling under the 100ms floor", () => {
    // 50→140 doubles and then some, but the +90ms absolute gain is under the floor.
    const result = judgeFunctions(
      window({ alpha: { ...stat(40, 50), name: "alpha" } }),
      window({ alpha: { ...stat(40, 140), name: "alpha" } }),
      30,
    );
    expect(result.regressions).toHaveLength(0);
  });

  test("flags 5xx rate up >=1pp with >=5 new failures", () => {
    const result = judgeFunctions(
      window({ beta: { name: "beta", count: 40, p95: 100, failures5xx: 0 } }),
      window({ beta: { name: "beta", count: 40, p95: 110, failures5xx: 6 } }),
      30,
    );
    expect(result.regressions[0]).toMatchObject({ name: "beta", rule: "5xx", newRate: 15 });
  });

  test("requires >=30 calls in both windows", () => {
    const result = judgeFunctions(
      window({
        alpha: { ...stat(40, 200), name: "alpha" },
        gamma: { ...stat(0, 0), name: "gamma" },
      }),
      window({
        alpha: { ...stat(40, 900), name: "alpha" },
        gamma: { ...stat(35, 900), name: "gamma" },
      }),
      30,
    );
    expect(result.judged).toBe(1);
    expect(result.insufficient).toEqual(["gamma"]);
    expect(result.regressions.map((r) => r.name)).toEqual(["alpha"]);
  });
});
