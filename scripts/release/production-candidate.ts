#!/usr/bin/env bun
/**
 * Checks that a production publication names exactly what staging already published
 * (docs/release/staging-to-production.md): a full source commit and a staging version published
 * from that commit. A Computer's stable production version may differ from its staging version.
 * Production rebuilds the commit against its own feed, so the
 * staging feed is the evidence that this commit passed the release gates and was published; the
 * staging workflows publish only from `main` and only after those gates.
 *
 *   computer   a stable production version; staging's `latest` names `stagingVersion`, or that
 *              same version when no distinct staging version is supplied
 *   installer  the version `crates/installer/Cargo.toml` holds at the commit; the installer
 *              pointer moves on its own (`pointer_only`), so it is not compared
 *
 * `withoutStaging` skips the staging comparison and checks the commit and version for shape
 * alone (and the installer's Cargo.toml version). It exists for a production release Frank
 * approved without a staging publication; the workflows expose it as an explicit input that the
 * run title names.
 *
 * Reads only the public staging feed; it holds no credential.
 */
import { readFile } from "node:fs/promises";

import { manifestObjectKey, LATEST_OBJECT_KEY } from "./publish";
import { installerManifestKey, installerVersionFromCargoToml } from "./installer-feed";
import { isValidReleaseVersion } from "./build-release";

export type ReleaseTrack = "computer" | "installer";

export interface ProductionCandidate {
  track: ReleaseTrack;
  version: string;
  commit: string;
  stagingFeedUrl: string;
  /** Computer version holding the staging evidence; defaults to the production version. */
  stagingVersion?: string;
  /** The installer track's `crates/installer/Cargo.toml` at `commit`. */
  cargoToml?: string;
  /** Check shape only: the release was approved without a staging publication. */
  withoutStaging?: boolean;
}

export interface CandidateDependencies {
  fetch?: (url: string) => Promise<Response>;
}

const FULL_COMMIT = /^[0-9a-f]{40}$/;
const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

async function readStagingObject(
  feedUrl: string,
  key: string,
  fetch: (url: string) => Promise<Response>,
): Promise<string> {
  const url = `${feedUrl.replace(/\/+$/, "")}/${key}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`staging ${key}: HTTP ${response.status}`);
  return response.text();
}

export async function verifyProductionCandidate(
  candidate: ProductionCandidate,
  deps: CandidateDependencies = {},
): Promise<void> {
  const fetch = deps.fetch ?? ((url: string) => globalThis.fetch(url));
  const { track, version, commit, stagingFeedUrl } = candidate;
  if (!FULL_COMMIT.test(commit)) {
    throw new Error(`commit must be a full commit, 40 lowercase hex characters: ${commit}`);
  }
  if (!STABLE_VERSION.test(version)) {
    throw new Error(`version must be a stable major.minor.patch version: ${version}`);
  }
  if (candidate.withoutStaging && candidate.stagingVersion !== undefined) {
    throw new Error("cannot combine a staging version with without-staging");
  }
  if (track !== "computer" && candidate.stagingVersion !== undefined) {
    throw new Error("a separate staging version is only supported for Computer candidates");
  }

  if (track === "installer") {
    const crateVersion = installerVersionFromCargoToml(candidate.cargoToml ?? "");
    if (crateVersion !== version) {
      throw new Error(
        `crates/installer/Cargo.toml at ${commit} holds ${crateVersion}, not the candidate ${version}`,
      );
    }
  }
  if (candidate.withoutStaging) return;

  const stagingVersion = candidate.stagingVersion ?? version;
  if (!isValidReleaseVersion(stagingVersion)) {
    throw new Error(`invalid staging version: ${stagingVersion}`);
  }
  let manifestKey: string;
  if (track === "computer") {
    const latest = (await readStagingObject(stagingFeedUrl, LATEST_OBJECT_KEY, fetch)).trim();
    if (latest !== stagingVersion) {
      throw new Error(`staging latest is ${latest}, not the candidate ${stagingVersion}`);
    }
    manifestKey = manifestObjectKey(stagingVersion);
  } else {
    manifestKey = installerManifestKey(version);
  }

  const manifest = JSON.parse(await readStagingObject(stagingFeedUrl, manifestKey, fetch)) as {
    version?: unknown;
    commit?: unknown;
  };
  if (manifest.version !== stagingVersion || manifest.commit !== commit) {
    throw new Error(
      `staging ${manifestKey} was published as ${String(manifest.version)} from ${String(manifest.commit)}, not ${stagingVersion} from ${commit}`,
    );
  }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const withoutStaging = args.includes("--without-staging");
  const stagingVersion = args
    .find((arg) => arg.startsWith("--staging-version="))
    ?.slice("--staging-version=".length);
  const [track, version, commit, stagingFeedUrl, cargoTomlPath] = args.filter(
    (arg) => arg !== "--without-staging" && !arg.startsWith("--staging-version="),
  );
  if ((track !== "computer" && track !== "installer") || !version || !commit || !stagingFeedUrl) {
    console.error(
      "usage: production-candidate.ts [--without-staging] [--staging-version=<version>] <computer|installer> <version> <commit> <staging-feed-url> [cargo-toml]",
    );
    process.exit(2);
  }
  try {
    await verifyProductionCandidate({
      track,
      version,
      commit,
      stagingFeedUrl,
      stagingVersion,
      cargoToml: cargoTomlPath ? await readFile(cargoTomlPath, "utf8") : undefined,
      withoutStaging,
    });
    console.log(
      withoutStaging
        ? `${track} ${version} from ${commit}: approved without a staging publication`
        : `staging published ${track} ${stagingVersion ?? version} from ${commit}` +
            (stagingVersion && stagingVersion !== version ? `; production version ${version}` : ""),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
