import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { attestRetainedRuntime } from "./retained-runtime";

const first = `sha256:${"a".repeat(64)}`;
const second = `sha256:${"b".repeat(64)}`;
const sourceCommit = "c".repeat(40);

test("runtime attestation accepts reordered duplicate IDs and emits only a digest", () => {
  const proof = attestRetainedRuntime({
    expected: `${first},${second}`,
    actual: `${second}\n${first},${first}`,
    sourceCommit,
  });
  expect(proof.retainedConfigured).toBe(2);
  expect(proof.sourceCommit).toBe(sourceCommit);
  expect(proof.retainedImagesSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(proof)).not.toContain(first);
  expect(proof).toEqual(
    attestRetainedRuntime({
      expected: `${second} ${first}`,
      actual: `${first},${second}`,
      sourceCommit,
    }),
  );
});

for (const actual of [first, `${first},sha256:${"d".repeat(64)}`, "", "malformed"])
  test(`runtime attestation rejects missing, changed or invalid configuration: ${actual.slice(0, 12)}`, () => {
    expect(() =>
      attestRetainedRuntime({ expected: `${first},${second}`, actual, sourceCommit }),
    ).toThrow();
  });

test("runtime attestation rejects an empty expectation or unbound source", () => {
  expect(() => attestRetainedRuntime({ expected: "", actual: first, sourceCommit })).toThrow();
  expect(() =>
    attestRetainedRuntime({ expected: first, actual: first, sourceCommit: "main" }),
  ).toThrow();
});

test("the workflow rejects live configuration mismatches before reporting success", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/deploy-staging.yml", import.meta.url),
    "utf8",
  );
  const step = workflow
    .split("      - name: Verify running Web cloud image protection")[1]!
    .split("      - name:")[0]!;
  const script = step
    .split("        run: |\n")[1]!
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
  const directory = await mkdtemp(join(tmpdir(), "coforge-runtime-proof-"));
  try {
    await symlink(resolve(import.meta.dir, "../..", "scripts"), join(directory, "scripts"), "dir");
    for (const [actual, actualPaused, expectedPaused, success] of [
      [`${second},${first}`, "false", "false", true],
      [first, "false", "false", false],
      ["", "false", "false", false],
      [`${second},${first}`, "true", "true", true],
      [`${second},${first}`, "false", "true", false],
      [`${second},${first}`, "true", "false", false],
    ] as const) {
      const child = Bun.spawn(
        ["bash", "-c", `ssh() { printf '%s\n' "$ACTUAL_JSON"; }\n${script}`],
        {
          cwd: directory,
          env: {
            ...process.env,
            SSH_DIR: "fixture",
            DEPLOY_SSH_USER: "fixture",
            DEPLOY_SSH_HOST: "fixture",
            ACTUAL_JSON: JSON.stringify({ retainedIds: actual, updatesPaused: actualPaused }),
            EXPECTED_CLOUD_IMAGE_UPDATES_PAUSED: expectedPaused,
            EXPECTED_RETAINED_CLOUD_IMAGE_IDS: `${first},${second}`,
            GITHUB_SHA: sourceCommit,
            GITHUB_STEP_SUMMARY: join(directory, "summary"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      expect((await child.exited) === 0).toBe(success);
      expect(stdout + stderr).not.toContain(first);
      if (success) expect(JSON.parse(stdout).retainedConfigured).toBe(2);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime attestation verifies maintenance mode together with retained identities", () => {
  const common = { expected: first, actual: first, sourceCommit };
  expect(
    attestRetainedRuntime({ ...common, expectedPaused: "true", actualPaused: "true" })
      .updatesPaused,
  ).toBe(true);
  for (const actualPaused of ["false", "", "yes"])
    expect(() =>
      attestRetainedRuntime({ ...common, expectedPaused: "true", actualPaused }),
    ).toThrow();
  expect(() =>
    attestRetainedRuntime({ ...common, expectedPaused: "false", actualPaused: "true" }),
  ).toThrow();
  expect(() =>
    attestRetainedRuntime({ ...common, expectedPaused: "yes", actualPaused: "true" }),
  ).toThrow();
  expect(
    attestRetainedRuntime({
      expected: "",
      actual: "",
      sourceCommit,
      expectedPaused: "true",
      actualPaused: "true",
    }).retainedConfigured,
  ).toBe(0);
});
