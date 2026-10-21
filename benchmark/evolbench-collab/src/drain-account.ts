import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { OpenVikingEvaluatorResult } from "../../../apps/web/src/server/openviking/typed-session-extract.server";
import { sanitizeDiagnostic } from "../../public-channel-memory/src/sanitize";
import type { OvUsers } from "../../public-channel-memory/src/ov";
import type { ManifestEpisode } from "./types";

export type SharedDrainAccount = {
  accountId: string;
  users: OvUsers;
};

/** Cold episodes drain into this shared corpus account. The file is read at runtime and is not committed. */
export async function loadSharedDrainAccount(
  path: string | null,
): Promise<SharedDrainAccount | null> {
  if (!path) return null;
  const raw = (await Bun.file(path).json()) as {
    accountId?: string;
    adminUserId?: string;
    adminKey?: string;
  };
  if (!raw.accountId || !raw.adminUserId || !raw.adminKey) {
    throw new Error(`drain account file ${path} is missing fields`);
  }
  console.log(
    sanitizeDiagnostic(`drain redirect: cold episodes drain to shared account ${raw.accountId}`),
  );
  return {
    accountId: raw.accountId,
    users: {
      adminUserId: raw.adminUserId,
      adminKey: raw.adminKey,
    },
  };
}

/** Warm resume rebinds this account instead of minting one. An explicit id wins over the recorded file. */
export async function warmReuseAccountId(explicit: string, statePath: string): Promise<string> {
  const trimmed = explicit.trim();
  if (trimmed.length > 0) return trimmed;
  try {
    return (await Bun.file(statePath).text()).trim();
  } catch {
    return "";
  }
}

export async function stageEpisodeFiles(
  episode: ManifestEpisode,
  workDir: string,
  refsRoot: string,
): Promise<void> {
  if (episode.stageFiles.length === 0) return;
  const root = resolve(refsRoot);
  for (const file of episode.stageFiles) {
    if (!file.src || !file.dst || isAbsolute(file.src) || isAbsolute(file.dst)) {
      throw new Error("invalid stage_files path for " + episode.episodeId);
    }
    const source = resolve(root, file.src);
    const target = resolve(workDir, file.dst);
    if (relative(root, source).startsWith("..") || relative(workDir, target).startsWith("..")) {
      throw new Error("stage_files path escapes its root for " + episode.episodeId);
    }
    if (!(await Bun.file(source).exists())) {
      throw new Error("missing reference file for " + episode.episodeId + ": " + file.src);
    }
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, Bun.file(source));
  }
}

/** Unanimous external signal for a drain commit. `status` is the runner's own completion check. */
export function drainEvaluatorResults(
  mode: string,
  status: string,
  episodeId: string,
): OpenVikingEvaluatorResult[] | undefined {
  if (mode !== "status") return undefined;
  const passed = status === "success";
  return [
    {
      binding_id: "run-completion",
      signal_kind: "acceptance",
      signal: passed ? "pass" : "fail",
      evidence_ref: `episode:${episodeId}:final-output-${passed ? "present" : "empty"}`,
    },
  ];
}
