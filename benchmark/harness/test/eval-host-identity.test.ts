import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalHostIdentity } from "../src/eval-host-identity";

// The names each benchmark's eval computer registered, and the daemon state directory it used,
// before the three copies of eval-daemon.ts became this module. They land in the database and on
// disk, so a run against an existing workspace must keep finding them.
const workspaceId = "0123456789abcdef-workspace";

test.each([
  [
    "lme",
    "lme-eval-host",
    "LME Eval Host",
    "lme-eval-0123456789abcdef-workspace",
    "lme-daemon-01234567",
  ],
  [
    "sb",
    "sb-eval-host",
    "SB Eval Host",
    "sb-eval-0123456789abcdef-workspace",
    "sb-daemon-01234567",
  ],
  [
    "pcm",
    "pcm-eval-host",
    "PCM Eval Host",
    "pcm-eval-0123456789abcdef-workspace",
    "pcm-daemon-01234567",
  ],
])(
  "the %s eval computer keeps its registered names and state directory",
  (label, name, displayName, registrationIdempotencyKey, stateDirectory) => {
    expect(evalHostIdentity(label, workspaceId)).toEqual({
      name,
      displayName,
      registrationIdempotencyKey,
      stateDirectory: join(tmpdir(), stateDirectory),
    });
  },
);
