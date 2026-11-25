import { expect, test } from "bun:test";

import { type Step, parse } from "./workflow-helpers";

const ci = await parse("ci.yml");

test("Daemon uses three shards with one shared timings input and one static check", async () => {
  const daemon = ci.jobs.daemon;
  const matrix = daemon.strategy.matrix.part;
  expect(matrix).toEqual(["1/3", "2/3", "3/3"]);
  expect(daemon.strategy["fail-fast"]).toBe(false);
  const tests = (daemon.steps as Step[]).find((step) => step.name === "Run tests")!;
  expect(tests.run).toBe(
    [
      "mise run test:daemon -- --shard=${{ matrix.part }}",
      "--timings=../../scripts/ci/daemon-test-timings-1.json",
      "--timings=../../scripts/ci/daemon-test-timings-2.json",
    ].join(" "),
  );
  const check = (daemon.steps as Step[]).find((step) => step.run === "mise run check:daemon");
  expect(check?.if).toBe("matrix.part == '1/3'");
  for (const part of [1, 2]) {
    const timings = await Bun.file(`scripts/ci/daemon-test-timings-${part}.json`).json();
    expect(timings.version).toBe(1);
    expect(Object.values(timings.files).some((duration) => Number(duration) > 0)).toBe(true);
  }
});
