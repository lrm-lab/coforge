import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RuntimeVersionUnsupportedError } from "#src/contract";
import { assertDshVersion, dshVersionFromOutput, DSH_ACP_VERSION } from "#src/dsh/version";
import { createDshLaunchContents, DSH_INSTRUCTIONS_PLUGIN } from "#src/dsh/launch-contents";

test("DSH accepts only its verified preview and fails closed on unknown versions", async () => {
  for (const version of [undefined, "", "0.2.1", "0.2.1-rc.1", "0.2.1-rc.3", "garbage"])
    await expect(assertDshVersion(["fixture"], async () => version)).rejects.toBeInstanceOf(
      RuntimeVersionUnsupportedError,
    );
  await expect(assertDshVersion(["fixture"], async () => DSH_ACP_VERSION)).resolves.toBeUndefined();
  await expect(
    assertDshVersion(["fixture"], async () => {
      throw new Error("probe unavailable");
    }),
  ).rejects.toBeInstanceOf(RuntimeVersionUnsupportedError);
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
