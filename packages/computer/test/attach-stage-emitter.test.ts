import { expect, test } from "bun:test";
import { attachStageEmitter } from "#src/cli/login-setup-commands";

/** `attach --json` stage evidence (task #417): stages go to stderr as one JSON line each so
 * stdout keeps only the final result, and outside `--json` there is no stage output. */

test("outside --json the emitter is absent, so no stage output reaches either stream", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const emit = attachStageEmitter({ stderr: (line) => stderr.push(line) }, false);
  emit?.("started");
  emit?.("polling");
  expect(stdout).toEqual([]);
  expect(stderr).toEqual([]);
  expect(emit).toBeUndefined();
});

test("in --json each stage is one JSON line on stderr, never stdout", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const emit = attachStageEmitter({ stderr: (line) => stderr.push(line) }, true);
  emit?.("started", { approveUrl: "https://x/a", userCode: "AB-CD" });
  emit?.("polling");
  emit?.("registered", { computerId: "c", workspaceSlug: "w" });
  emit?.("saved", { configPath: "/tmp/registration.json" });
  // stdout carries nothing; stderr has one parseable JSON document per stage, in order.
  expect(stdout).toEqual([]);
  expect(stderr.map((line) => JSON.parse(line).stage)).toEqual([
    "started",
    "polling",
    "registered",
    "saved",
  ]);
  expect(JSON.parse(stderr[0]!).approveUrl).toBe("https://x/a");
  expect(JSON.parse(stderr[3]!).configPath).toBe("/tmp/registration.json");
});
