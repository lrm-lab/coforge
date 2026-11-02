import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RuntimeStartFailedError, RuntimeVersionUnsupportedError } from "#src/contract";
import { assertDshVersion, dshVersionFromOutput, DSH_ACP_VERSION } from "#src/dsh/version";
import { createDshLaunchContents, DSH_INSTRUCTIONS_PLUGIN } from "#src/dsh/launch-contents";

test("DSH accepts the verified 0.2.1 preview line and fails closed outside it", async () => {
  for (const version of [
    undefined,
    "",
    "0.2.0",
    "0.2.1-rc.1",
    "0.2.1-alpha.5",
    "0.2.2-alpha.2",
    "0.3.0",
    "garbage",
  ])
    await expect(assertDshVersion(["fixture"], async () => version)).rejects.toBeInstanceOf(
      RuntimeVersionUnsupportedError,
    );
  for (const version of [DSH_ACP_VERSION, "0.2.1-rc.5", "0.2.1"])
    await expect(assertDshVersion(["fixture"], async () => version)).resolves.toBeUndefined();
  // A CLI that cannot start at all is a start failure, not a version judgement.
  await expect(
    assertDshVersion(["fixture"], async () => {
      throw new Error("probe unavailable");
    }),
  ).rejects.toBeInstanceOf(RuntimeStartFailedError);
  const startFailure = new RuntimeStartFailedError(
    "DeepSeek Harness exited 1 when asked for its version",
    "No version is set for shim: node",
  );
  await expect(
    assertDshVersion(["fixture"], async () => {
      throw startFailure;
    }),
  ).rejects.toBe(startFailure);
  expect(dshVersionFromOutput("0.2.1-rc.2\n")).toBe(DSH_ACP_VERSION);
  expect(dshVersionFromOutput("unexpected output 0.2.1-rc.2")).toBeUndefined();
});

test("DSH patch loads the local literal plugin and keeps native internal orchestration", () => {
  const instructions = "literal {{x}} {{model}} {{{nested}}}\n中文";
  const patch = JSON.parse(createDshLaunchContents(instructions, "/private/plugin.mjs").patch);
  const inserted = patch.flatMap((entry: { insert?: unknown[] }) => entry.insert ?? []);
  expect(inserted).toEqual([
    { id: "coforge-instructions", name: "/private/plugin.mjs", config: { instructions } },
  ]);
  const disabled = patch
    .filter((entry: { disabled?: boolean }) => entry.disabled)
    .map((entry: { id: string }) => entry.id);
  expect(disabled).toEqual(["tool-plugin-manager", "plugin-manager", "plan-mode"]);
  expect(
    patch.find((entry: { id?: string }) => entry.id === "system-prompt").config.personaPrefix,
  ).toBe("");
});

test("bundled DSH plugin registers literal instructions and rejects invalid instructions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anvil-dsh-plugin-"));
  try {
    const path = join(directory, "instructions.mjs");
    await Bun.write(path, DSH_INSTRUCTIONS_PLUGIN);
    const plugin = await import(pathToFileURL(path).href);
    const sections: unknown[] = [];
    const ctx = { systemPrompt: { section: (section: unknown) => sections.push(section) } };
    const instructions = "{{x}} {{model}} {{bad-name}} {{{nested}}}\n中文";
    plugin.apply(ctx, { instructions });
    expect(sections).toEqual([
      { name: "coforge:instructions", order: 0, text: instructions, interpolate: false },
    ]);
    for (const invalid of [undefined, null, 1, {}, true])
      expect(() => plugin.apply(ctx, { instructions: invalid })).toThrow(
        "DSH CoForge instructions must be a string",
      );
    expect(sections).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
