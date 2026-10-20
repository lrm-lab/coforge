import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalHostIdentity } from "../src/eval-daemon";

// The names each benchmark's eval computer registered, and the daemon state directory it used,
// before the three copies of eval-daemon.ts became this module. They land in the database and on
// disk, so a run against an existing workspace must keep finding them.
const workspaceId = "0123456789abcdef-workspace";

test.each([
  ["lme", "LME Eval Host"],
  ["sb", "SB Eval Host"],
  ["pcm", "PCM Eval Host"],
])("the %s eval computer keeps its registered names and state directory", (label, displayName) => {
  expect(evalHostIdentity(label, workspaceId)).toEqual({
    name: `${label}-eval-host`,
    displayName,
    registrationIdempotencyKey: `${label}-eval-0123456789abcdef-workspace`,
    stateDirectory: join(tmpdir(), `${label}-daemon-01234567`),
  });
});
