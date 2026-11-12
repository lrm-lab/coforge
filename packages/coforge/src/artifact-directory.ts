import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACT_UPLOAD_MAX_BYTES, artifactPathValid } from "@lrm/coforge-sdk/agent";
import { invalidArg } from "#src/cli-error";
import { inPool } from "#src/pool";

/** The hidden file a pull leaves in its directory: which artifact it came from, the version it
 * holds (the base of the next push) and each file's sha256 as pulled or last pushed. */
export const STATE_FILE = ".coforge-artifact.json";

export type ArtifactState = {
  artifact: string;
  /** 0 while a pull is unfinished: the directory holds a mix, and cannot be pushed. */
  version: number;
  files: Record<string, string>;
};

export function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

const isControl = (char: string) => {
  const code = char.codePointAt(0)!;
  return code < 0x20 || code === 0x7f;
};

/**
 * A file's path in an artifact, which every local path derives from: the server's rule
 * (`artifactPathValid`), and not the pull's own state file. Whatever the server or the command
 * line names, nothing but a path of this shape is ever joined to a directory, so nothing can
 * leave it.
 */
export function artifactPath(path: string): string {
  if (!artifactPathValid(path))
    throw invalidArg(
      `Not a file path inside an artifact: "${path}" (relative, / separated, no empty, . or .. segment, no backslash, colon or control character)`,
    );
  if (path === STATE_FILE)
    throw invalidArg(
      `Not a file path inside an artifact (that name is the pull's own state file): "${path}"`,
    );
  return path;
}

/** Refuses paths that differ only by case: on a case-insensitive filesystem they are one file,
 * so a pull would silently keep only one of them. */
export function refuseCaseCollisions(paths: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const key = path.toLowerCase();
    const other = seen.get(key);
    if (other !== undefined && other !== path)
      throw invalidArg(
        `The version holds ${other} and ${path}, which differ only by case and cannot share a directory on every filesystem`,
        "Rename one of them in the artifact, then pull again.",
      );
    seen.set(key, path);
  }
}

/** A folder name made from an artifact's title, or its id when nothing usable is left. */
export function folderName(title: string, id: string): string {
  const name = Array.from(title, (char) =>
    isControl(char) || '\\/:*?"<>|'.includes(char) ? "-" : char,
  )
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim();
  return /^[-\s.]*$/.test(name) ? id : name;
}

/** The state file in `dir`, or none; a damaged one is an error rather than a fresh start. */
export async function readState(dir: string): Promise<ArtifactState | undefined> {
  const file = Bun.file(join(dir, STATE_FILE));
  if (!(await file.exists())) return undefined;
  const damaged = () =>
    invalidArg(
      `${join(dir, STATE_FILE)} is damaged`,
      "Pull the artifact again into an empty directory.",
    );
  let value: unknown;
  try {
    value = await file.json();
  } catch {
    throw damaged();
  }
  const state = value as Partial<ArtifactState> | null;
  if (
    !state ||
    typeof state.artifact !== "string" ||
    !Number.isSafeInteger(state.version) ||
    (state.version as number) < 0 ||
    !state.files ||
    typeof state.files !== "object" ||
    !Object.values(state.files).every((hash) => typeof hash === "string")
  )
    throw damaged();
  return state as ArtifactState;
}

export async function writeState(dir: string, state: ArtifactState): Promise<void> {
  await Bun.write(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

/** What `dir` is before a pull: a directory that is missing, empty or this artifact's own pull,
 * with that pull's state; anything else is refused. */
export async function pullTarget(
  dir: string,
  artifact: string,
): Promise<ArtifactState | undefined> {
  const info = await lstat(dir).catch(() => undefined);
  if (!info) return undefined;
  if (!info.isDirectory()) throw invalidArg(`${dir} is not a directory`);
  if ((await readdir(dir)).length === 0) return undefined;
  const state = await readState(dir);
  if (state?.artifact !== artifact)
    throw invalidArg(
      `${dir} is not empty and is not a pull of this artifact`,
      "Name an empty or new directory with --dir.",
    );
  return state;
}

/** Makes the directories above `rel` inside `root`, refusing any that is a symbolic link or a
 * file, so the path stays inside `root`. */
async function prepareParents(root: string, rel: string): Promise<string> {
  const segments = rel.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    // Another writer may make the directory between the check and the mkdir: EEXIST is fine
    // when what is there is a real directory, which the second look confirms.
    await mkdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw invalidArg(`Cannot write ${rel}: ${segment} is a symbolic link or not a directory`);
  }
  return join(root, rel);
}

export async function writeInside(root: string, rel: string, bytes: Uint8Array): Promise<void> {
  const target = await prepareParents(root, artifactPath(rel));
  const info = await lstat(target).catch(() => undefined);
  if (info && (info.isSymbolicLink() || info.isDirectory()))
    throw invalidArg(`Cannot write ${rel}: it is a symbolic link or a directory`);
  await Bun.write(target, bytes);
}

/** Removes a regular file `rel` under `root`, when it is one. */
export async function removeInside(root: string, rel: string): Promise<void> {
  const segments = artifactPath(rel).split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    const info = await lstat(current).catch(() => undefined);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) return;
  }
  const target = join(root, rel);
  const info = await lstat(target).catch(() => undefined);
  if (info?.isFile()) await rm(target);
}

export async function existsInside(root: string, rel: string): Promise<boolean> {
  return (await lstat(join(root, rel)).catch(() => undefined)) !== undefined;
}

/** One file of a directory to push. */
export type LocalFile = { path: string; sha256: string; sizeBytes: number; absolute: string };

/**
 * The regular files of `root`, by path. Hidden ones (a leading `.`, a directory's too) are left
 * out unless asked for, and the state file always. A symbolic link or a file over the upload limit
 * is refused, so nothing is sent from outside the directory or past what the server takes.
 */
export async function scanDirectory(
  root: string,
  includeHidden: boolean,
): Promise<Map<string, LocalFile>> {
  const candidates: { path: string; absolute: string }[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (prefix === "" && entry.name === STATE_FILE) continue;
      if (entry.name.startsWith(".") && !includeHidden) continue;
      const absolute = join(dir, entry.name);
      if (entry.isSymbolicLink())
        throw invalidArg(
          `${path} is a symbolic link; an artifact holds regular files only`,
          "Replace it with the file itself, or move it out of the directory.",
        );
      if (entry.isDirectory()) await walk(absolute, `${path}/`);
      else if (entry.isFile()) candidates.push({ path: artifactPath(path), absolute });
    }
  };
  await walk(root, "");
  const found: LocalFile[] = [];
  await inPool(candidates, 4, async ({ path, absolute }) => {
    // The size is checked before the bytes are read, so a huge file is refused, not loaded.
    const { size } = await lstat(absolute);
    if (size > ARTIFACT_UPLOAD_MAX_BYTES)
      throw invalidArg(
        `${path} is ${size} bytes, over the ${ARTIFACT_UPLOAD_MAX_BYTES} an artifact file may be`,
      );
    const bytes = new Uint8Array(await Bun.file(absolute).arrayBuffer());
    found.push({ path, sha256: sha256Hex(bytes), sizeBytes: bytes.byteLength, absolute });
  });
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return new Map(found.map((file) => [file.path, file]));
}

/** A word as a shell takes it literally: bare when plain, else in single quotes. */
export const shellWord = (word: string): string =>
  /^[\w./@:+=-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
