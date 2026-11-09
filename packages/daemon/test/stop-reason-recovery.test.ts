import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  STALLED_RESTART_LIMIT_ERROR,
  STOP_REASON_RECOVERY,
  STOP_RECOVERY,
  stopNeedsPerson,
} from "@lrm/coforge-sdk/internal";
import {
  LAUNCH_FAILURE_REASON,
  NON_RETRYABLE_LAUNCH_FAILURE_REASONS,
} from "#src/agent-runtime/launch-failure";

/**
 * Every reason an Agent can stop for is classified in the SDK's `STOP_REASON_RECOVERY` (task
 * #731), so the web never silently shows nothing for a stop a person has to clear. The runtime
 * reasons are read from the files that write them, so a new `errorReason: "…"` there fails here
 * until it is classified.
 */
const runtimeSources = ["runtime-error-rules.ts", "runtime-error-classification.ts"].map((file) =>
  readFileSync(join(import.meta.dir, "../src/agent-runtime", file), "utf8"),
);
const runtimeReasons = [
  ...new Set(
    runtimeSources.flatMap((source) =>
      [...source.matchAll(/errorReason: (?:\w+ \? )?"([a-z_]+)"(?: : "([a-z_]+)")?/g)].flatMap(
        (m) => [m[1]!, ...(m[2] ? [m[2]] : [])],
      ),
    ),
  ),
];
const launchReasons = Object.values(LAUNCH_FAILURE_REASON);
const produced = [...launchReasons, ...runtimeReasons, STALLED_RESTART_LIMIT_ERROR.errorReason];

test("every stop reason the Daemon can produce has a recovery", () => {
  expect(runtimeReasons).toContain("billing_exhausted");
  expect(runtimeReasons).toContain("input_too_large");
  expect(produced.filter((reason) => !Object.hasOwn(STOP_REASON_RECOVERY, reason))).toEqual([]);
});

test("the table names no reason the Daemon never produces", () => {
  expect(Object.keys(STOP_REASON_RECOVERY).filter((reason) => !produced.includes(reason))).toEqual(
    [],
  );
});

test("a launch failure no retry can fix waits for a person", () => {
  for (const reason of NON_RETRYABLE_LAUNCH_FAILURE_REASONS)
    expect(stopNeedsPerson(reason)).toBe(true);
  expect(STOP_REASON_RECOVERY.input_too_large).toBe(STOP_RECOVERY.RESET_SESSION);
  expect(STOP_REASON_RECOVERY.rate_limited).toBe(STOP_RECOVERY.AUTOMATIC);
});

test("a provider that hung needs no person: the Daemon kills it and the next turn may work", () => {
  expect(STOP_REASON_RECOVERY.provider_timeout).toBe(STOP_RECOVERY.AUTOMATIC);
  expect(stopNeedsPerson("provider_timeout")).toBe(false);
});
