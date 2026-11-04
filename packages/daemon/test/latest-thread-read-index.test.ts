import { expect, test } from "bun:test";
import { LatestThreadReadIndex } from "#src/daemon-runtime/latest-thread-read-index";

test("indexes the latest reviewed thread and updates it incrementally", () => {
  const index = new LatestThreadReadIndex();
  const targets = new Map([
    ["#general:11111111", { readOrder: 2, reviewedSeq: 1 }],
    ["#general:22222222", { readOrder: 4, reviewedSeq: 1 }],
    ["#general:33333333", { readOrder: 3, reviewedSeq: 0 }],
  ]);

  expect(index.get("agent-1", "#general", targets)).toEqual({
    target: "#general:22222222",
    order: 4,
  });

  index.record("agent-1", "#general:44444444", { readOrder: 5, reviewedSeq: 8 });
  expect(index.get("agent-1", "#general", targets)).toEqual({
    target: "#general:44444444",
    order: 5,
  });
});

test("clearing an Agent drops its cached view so the next read reloads durable state", () => {
  const index = new LatestThreadReadIndex();
  const targets = new Map([["#general:11111111", { readOrder: 2, reviewedSeq: 1 }]]);

  expect(index.get("agent-1", "#general", targets)?.target).toBe("#general:11111111");
  targets.set("#general:22222222", { readOrder: 3, reviewedSeq: 1 });
  index.clear("agent-1");

  expect(index.get("agent-1", "#general", targets)?.target).toBe("#general:22222222");
});
