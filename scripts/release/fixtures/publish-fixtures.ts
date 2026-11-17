import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildReleaseTree, type ReleaseInputs, type ReleaseTree } from "../build-release";
import type { CompileFn } from "../publish";

const temporaryDirectories: string[] = [];

export async function removeTemporaryDirectories(): Promise<void> {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
}

export async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

// `windows-x64` sorts after "manifest.json", which is what makes the manifest-last upload order
// load-bearing: with only POSIX targets (all sorting before `m`) `tree.files` already ends with
// the manifest, and reverting publish.ts to upload in plain `tree.files` order passes every test
// here. Compilation is stubbed, so the extra target costs nothing.
export const TEST_TARGETS = ["linux-x64", "linux-arm64", "windows-x64"];

export function fixtureArtifacts(): Record<string, { computer: Uint8Array }> {
  const artifacts: Record<string, { computer: Uint8Array }> = {};
  for (const target of TEST_TARGETS) {
    artifacts[target] = {
      computer: Buffer.from(`#!/bin/sh\n# unified computer for ${target}\n`),
    };
  }
  return artifacts;
}

/** A small, distinct fixture standing in for the real ~1.8 MB `photon_rs_bg.wasm` - resolving the
 * real file from the installed dependency chain is photon-wasm.test.ts's concern. */
export const FIXTURE_PHOTON_WASM = new Uint8Array(
  Buffer.from("#wasm-fixture: photon_rs_bg.wasm\n"),
);

export function stubResolvePhotonWasm(): () => Promise<Uint8Array> {
  return async () => FIXTURE_PHOTON_WASM;
}

export async function fixtureTree(version: string, outputDirectory: string): Promise<ReleaseTree> {
  const inputs: ReleaseInputs = {
    version,
    commit: "a".repeat(40),
    buildDate: new Date("2026-09-01T00:00:00.000Z").toISOString(),
    artifacts: fixtureArtifacts(),
    photonWasm: FIXTURE_PHOTON_WASM,
  };
  return buildReleaseTree(inputs, outputDirectory);
}

export function stubCompile(): CompileFn {
  const artifacts = fixtureArtifacts();
  return (async ({ target }) => {
    const fixture = artifacts[target];
    if (!fixture) throw new Error(`no fixture artifact for target: ${target}`);
    return fixture;
  }) as CompileFn;
}
