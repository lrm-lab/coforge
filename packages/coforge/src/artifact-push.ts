import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentArtifactFile, AgentArtifactRequest } from "@lrm/coforge-sdk/agent";
import {
  artifactPath,
  existsInside,
  readState,
  refuseCaseCollisions,
  removeInside,
  scanDirectory,
  shellWord,
  sha256Hex,
  writeState,
  type ArtifactState,
  type LocalFile,
} from "#src/artifact-directory";
import type {
  ArtifactDirectoryDraft,
  ArtifactDirectoryInvocation,
  ArtifactDirectoryTransport,
} from "#src/artifact-directory-args";
import type { ArtifactReadAnswer } from "#src/artifact-format";
import { formatTelling, type TellingAnswer } from "#src/artifact-follow-format";
import { asJson, pullFile, requireCall } from "#src/artifact-transfer";
import { CliError, invalidArg, withOutputMode } from "#src/cli-error";
import { invalidArgument } from "#src/command-help/index";
import { inPool } from "#src/pool";

type PushCheckHint = {
  status: string;
  skipReason?: string;
};

type SaveAnswer = TellingAnswer & {
  status?: string;
  unchanged?: boolean;
  titleChanged?: { from: string };
  number?: number;
  merged?: string[];
  missing?: string[];
  url?: string | null;
  check?: PushCheckHint;
};

function formatPushCheckHint(
  check: PushCheckHint | undefined,
  artifactId: string,
  version: number,
): string[] {
  if (!check) return [];
  if (check.status === "pending") {
    return [
      `Publish check: pending. Wait for findings and screenshots: coforge artifact check ${artifactId} --rev ${version} --wait`,
    ];
  }
  if (check.status === "skipped" && check.skipReason === "unchanged_files" && version > 1) {
    return [
      `Publish check: skipped (files unchanged from v${version - 1}). Read previous check: coforge artifact check ${artifactId} --rev ${version - 1}`,
    ];
  }
  if (check.status === "skipped" && check.skipReason === "workspace_daily_cap") {
    return ["Publish check: skipped (workspace reached its 24-hour publish check limit)."];
  }
  if (check.status === "skipped") {
    return [`Publish check: skipped (${check.skipReason ?? "unknown"}).`];
  }
  return [];
}

type PushRequest = Extract<AgentArtifactRequest, { operation: "push"; artifact: string }>;
type CreateRequest = Extract<AgentArtifactRequest, { operation: "push"; artifact?: undefined }>;

const toManifest = (files: LocalFile[]): AgentArtifactFile[] =>
  files.map(({ path, sha256 }) => ({ path, sha256 }));

export async function runPush(
  invocation: ArtifactDirectoryInvocation,
  draft: Extract<ArtifactDirectoryDraft, { operation: "push" }>,
  transport: ArtifactDirectoryTransport,
  cwd: string,
): Promise<unknown> {
  const dir = resolve(cwd, draft.dir);
  const info = await lstat(dir).catch(() => undefined);
  if (!info?.isDirectory()) throw invalidArg(`${draft.dir} is not a directory`);
  const state = await readState(dir);
  if (state && draft.target !== undefined)
    throw invalidArg(
      `${draft.dir} already holds artifact ${state.artifact}: --target would make a second one`,
      "Leave --target out to push to that artifact, or name another directory.",
    );
  if (state?.version === 0)
    throw invalidArg(
      "This directory holds an unfinished pull",
      `Pull again: coforge artifact pull ${state.artifact} --dir ${shellWord(draft.dir)}`,
    );
  const entry = draft.entry === undefined ? undefined : artifactPath(draft.entry);
  const deletes = (draft.delete ?? []).map(artifactPath);
  for (const path of deletes)
    if (await existsInside(dir, path))
      throw invalidArg(
        `--delete ${path}: the file is still in the directory`,
        "Remove the file first, then push with --delete.",
      );
  const tracked = state ? new Set(Object.keys(state.files)) : undefined;
  const local = await scanDirectory(dir, draft.includeHidden === true, tracked);
  const settings = {
    ...(draft.title === undefined ? {} : { title: draft.title }),
    ...(draft.description === undefined ? {} : { description: draft.description }),
  };
  const idempotencyKey = crypto.randomUUID();

  if (!state) {
    const created = await createFromDirectory(
      draft,
      local,
      entry,
      settings,
      idempotencyKey,
      transport,
    );
    const hashes = Object.fromEntries([...local.values()].map((file) => [file.path, file.sha256]));
    await writeState(dir, { artifact: created.id, version: created.currentVersion, files: hashes });
    return asJson(
      invocation,
      created,
      [
        `Created artifact "${created.title}" (id ${created.id}, name ${created.name}), version ${created.currentVersion}, from ${local.size} file${local.size === 1 ? "" : "s"}.`,
        ...(created.url ? [`Open: ${created.url}`] : []),
        ...formatPushCheckHint(created.check, created.id, created.currentVersion),
        ...formatTelling(created.id, created),
        `Read it: coforge artifact read ${created.id}`,
        `Send changes later: coforge artifact push ${shellWord(draft.dir)}`,
      ].join("\n"),
    );
  }

  const changed = [...local.values()].filter((file) => state.files[file.path] !== file.sha256);
  const settingsChanged =
    Object.keys(settings).length > 0 || entry !== undefined || draft.label !== undefined;
  if (changed.length === 0 && deletes.length === 0 && !settingsChanged)
    return asJson(
      invocation,
      { status: "nothing" },
      `Nothing to push: no file differs from version ${state.version}.`,
    );
  const request: PushRequest = {
    operation: "push",
    artifact: state.artifact,
    baseVersion: state.version,
    idempotencyKey,
    ...(changed.length > 0 ? { files: toManifest(changed) } : {}),
    ...(deletes.length > 0 ? { delete: deletes } : {}),
    ...(entry === undefined ? {} : { entry }),
    ...settings,
    ...(draft.note === undefined ? {} : { note: draft.note }),
    ...(draft.label === undefined ? {} : { label: draft.label }),
  };
  let answer: SaveAnswer;
  try {
    answer = (await sendManifest(request, changed, transport)) as SaveAnswer;
  } catch (error) {
    throw baseMoved(error, state, draft.dir);
  }
  if (answer.status === "nothing" && answer.titleChanged)
    return asJson(
      invocation,
      answer,
      `Renamed from "${answer.titleChanged.from}": only the title changed, so no new version was made. The directory is still at version ${state.version}.`,
    );
  if (answer.status === "nothing")
    return asJson(
      invocation,
      answer,
      [
        `Nothing was sent: the artifact already holds what this push names. The directory is still at version ${state.version}.`,
        `If others changed the artifact since, bring their files in: coforge artifact pull ${state.artifact} --dir ${shellWord(draft.dir)}`,
      ].join("\n"),
    );
  const version = answer.number ?? state.version;
  const files = { ...state.files };
  for (const file of changed) files[file.path] = file.sha256;
  for (const path of deletes) delete files[path];
  let next: ArtifactState = { artifact: state.artifact, version, files };
  const merged = answer.merged ?? [];
  if (merged.length > 0) next = await bringMerged(dir, next, transport);
  await writeState(dir, next);
  const pushed = [
    changed.length > 0
      ? `${changed.length} changed (${changed.map((f) => f.path).join(", ")})`
      : "",
    deletes.length > 0 ? `${deletes.length} deleted (${deletes.join(", ")})` : "",
  ].filter(Boolean);
  const message = [
    `${answer.status === "replayed" ? "Already pushed as" : "Pushed"} version ${version}${pushed.length ? `: ${pushed.join("; ")}` : ""}.`,
    ...(answer.url ? [`Open: ${answer.url}`] : []),
    ...formatPushCheckHint(answer.check, state.artifact, version),
    ...(merged.length > 0
      ? [
          `Merged with what others saved since version ${state.version}: ${merged.join(", ")}. Their files are now in the directory.`,
        ]
      : []),
    ...formatTelling(state.artifact, answer),
  ].join("\n");
  return asJson(invocation, answer, message);
}

type Created = TellingAnswer & {
  id: string;
  name: string;
  title: string;
  currentVersion: number;
  url?: string | null;
  check?: PushCheckHint;
};

async function createFromDirectory(
  draft: Extract<ArtifactDirectoryDraft, { operation: "push" }>,
  local: Map<string, LocalFile>,
  entryOption: string | undefined,
  settings: { title?: string; description?: string },
  idempotencyKey: string,
  transport: ArtifactDirectoryTransport,
): Promise<Created> {
  const command = "artifact push";
  const { target } = draft;
  if (target === undefined)
    throw new CliError({
      code: "TARGET_REQUIRED",
      message:
        "A new artifact needs a home: pass --target with the conversation you are working in ('#channel', or '@name' for a DM). Nothing was pushed.",
      retryable: false,
    });
  const title = settings.title?.trim();
  if (!title)
    throw invalidArgument(command, "--title is required to make an artifact from a directory");
  if (local.size === 0)
    throw invalidArg(
      `${draft.dir} has no files to push`,
      "Hidden files (a leading .) are left out unless you pass --include-hidden.",
    );
  const only = local.size === 1 ? [...local.keys()][0] : undefined;
  const entry = entryOption ?? (local.has("index.html") ? "index.html" : only);
  if (!entry)
    throw invalidArgument(
      command,
      `--entry is required: name the file the artifact opens at (${[...local.keys()].slice(0, 5).join(", ")})`,
    );
  if (!local.has(entry)) throw invalidArg(`--entry ${entry} is not a file in ${draft.dir}`);
  const files = [...local.values()];
  const request: CreateRequest = {
    operation: "push",
    title,
    target,
    ...(settings.description === undefined ? {} : { description: settings.description.trim() }),
    files: toManifest(files),
    entry,
    idempotencyKey,
  };
  return (await sendManifest(request, files, transport)) as Created;
}

/**
 * Sends a manifest save; when the server lacks bytes it names (`missing`), uploads each and sends
 * the very same request again, so its idempotency key still holds.
 */
async function sendManifest(
  request: AgentArtifactRequest,
  files: LocalFile[],
  transport: ArtifactDirectoryTransport,
): Promise<unknown> {
  const send = requireCall(transport.artifact, "request");
  for (let attempt = 0; ; attempt += 1) {
    const answer = (await send(request)) as SaveAnswer;
    if (answer?.status !== "missing" || !Array.isArray(answer.missing)) return answer;
    if (attempt >= 2)
      throw new CliError({
        code: "ARTIFACT_MISSING",
        message:
          "The server still lacks bytes this save names after they were uploaded; nothing was written.",
        retryable: false,
      });
    const upload = requireCall(transport.artifactUpload, "upload");
    await inPool(answer.missing, 4, async (hash) => {
      const file = files.find((candidate) => candidate.sha256 === hash);
      if (!file)
        throw new CliError({
          code: "ARTIFACT_MISSING",
          message: `The server asked for bytes (${hash}) that no file in this push has`,
          retryable: false,
        });
      const bytes = new Uint8Array(await Bun.file(file.absolute).arrayBuffer());
      if (sha256Hex(bytes) !== hash)
        throw invalidArg(`${file.path} changed while it was being pushed`, "Run the push again.");
      await upload(hash, bytes);
    });
  }
}

const pullAdvice = (artifact: string, dir: string) =>
  [
    `Pull the newest version into a fresh directory (coforge artifact pull ${artifact} --dir <new dir>), redo your change on it, and push from there.`,
    ...(dir === "." ? [] : [`Your edits stay in ${dir}.`]),
  ].join(" ");

/** A refusal because the artifact moved on: which files and settings clashed, and what to do. */
function baseMoved(error: unknown, state: ArtifactState, dir: string): unknown {
  if (!(error instanceof CliError) || !error.message.includes("artifact-base-moved")) return error;
  const { files, settings } = clashes(error.details);
  return withOutputMode(error, error.outputMode, {
    message: [
      error.message,
      ...(files.length > 0 ? [`Files that clashed: ${files.join(", ")}`] : []),
      ...(settings.length > 0 ? [`Settings that clashed: ${settings.join(", ")}`] : []),
      "Nothing was written.",
    ].join("\n"),
    retryable: false,
    suggestedNextAction: pullAdvice(state.artifact, dir),
  });
}

/** What the refusal's details name: `files` and `settings`, each one name a line. */
function clashes(details: unknown): { files: string[]; settings: string[] } {
  const lines = (value: unknown) =>
    typeof value === "string" ? value.split("\n").filter(Boolean) : [];
  const record = (details && typeof details === "object" ? details : {}) as Record<string, unknown>;
  return { files: lines(record.files), settings: lines(record.settings) };
}

/** After a merge, the directory lacks what others saved: the state becomes the file list of the
 * version the server now holds, taking the files that differ from it and dropping the ones it no
 * longer lists. */
async function bringMerged(
  dir: string,
  state: ArtifactState,
  transport: ArtifactDirectoryTransport,
): Promise<ArtifactState> {
  const answer = (await requireCall(
    transport.artifact,
    "request",
  )({
    operation: "read",
    artifact: state.artifact,
    version: state.version,
  })) as ArtifactReadAnswer;
  if (!answer.files) return state;
  // Two names one folder on this disk would hold as one file are refused, as a pull does.
  refuseCaseCollisions(answer.files.map((file) => file.path));
  const listed = answer.files.map((file) => ({
    path: artifactPath(file.path),
    sha256: file.sha256,
  }));
  await inPool(
    listed.filter((file) => state.files[file.path] !== file.sha256),
    4,
    (file) => pullFile(transport, dir, state.artifact, state.version, file),
  );
  const held = new Set(listed.map((file) => file.path));
  for (const path of Object.keys(state.files)) if (!held.has(path)) await removeInside(dir, path);
  return {
    ...state,
    files: Object.fromEntries(listed.map((file) => [file.path, file.sha256])),
  };
}
