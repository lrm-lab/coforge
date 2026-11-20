import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACT_UPLOAD_MAX_BYTES, artifactPathValid } from "@lrm/coforge-sdk/agent";
import { invalidArg } from "#src/cli-error";
import { inPool } from "#src/pool";

export const STATE_FILE = ".coforge-artifact.json";

const TOOL_NAMES = new Set([".git", ".DS_Store", "node_modules", ".coforge-check"]);

export type ArtifactState = {
  artifact: string;
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

export function artifactPath(path: string): string {
  if (!artifactPathValid(path))
    throw invalidArg(
      `Not a file path inside an artifact: "${path}" (relative, / separated, no empty, ., .. or .git segment, no backslash, colon, %, ?, # or control/format character)`,
    );
  if (path === STATE_FILE)
    throw invalidArg(
      `Not a file path inside an artifact (that name is the pull's own state file): "${path}"`,
    );
  return path;
}

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

async function prepareParents(root: string, rel: string): Promise<string> {
  const segments = rel.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
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

export type LocalFile = { path: string; sha256: string; sizeBytes: number; absolute: string };

export type LocalChanges = {
  modified: string[];
  added: string[];
  deleted: string[];
};

function trackedDirectories(tracked?: ReadonlySet<string>): Set<string> {
  const dirs = new Set<string>();
  if (!tracked) return dirs;
  for (const path of tracked) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return dirs;
}

export async function scanDirectory(
  root: string,
  includeHidden: boolean,
  tracked?: ReadonlySet<string>,
): Promise<Map<string, LocalFile>> {
  const trackedDirs = trackedDirectories(tracked);
  const candidates: { path: string; absolute: string }[] = [];
  const walk = async (dir: string, prefix: string, inHiddenDir: boolean): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (prefix === "" && entry.name === STATE_FILE) continue;
      if (TOOL_NAMES.has(entry.name)) continue;
      const path = `${prefix}${entry.name}`;
      const hidden = inHiddenDir || entry.name.startsWith(".");
      if (hidden && !includeHidden) {
        if (entry.isDirectory()) {
          if (!trackedDirs.has(path)) continue;
        } else if (!tracked?.has(path)) {
          continue;
        }
      }
      const absolute = join(dir, entry.name);
      if (entry.isSymbolicLink())
        throw invalidArg(
          `${path} is a symbolic link; an artifact holds regular files only`,
          "Replace it with the file itself, or move it out of the directory.",
        );
      if (entry.isDirectory()) await walk(absolute, `${path}/`, hidden);
      else if (entry.isFile()) candidates.push({ path: artifactPath(path), absolute });
    }
  };
  await walk(root, "", false);
  const found: LocalFile[] = [];
  await inPool(candidates, 4, async ({ path, absolute }) => {
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

export async function localChanges(
  dir: string,
  state: ArtifactState,
  incomingPaths: readonly string[] = [],
): Promise<LocalChanges> {
  const tracked = new Set([...Object.keys(state.files), ...incomingPaths]);
  const local = await scanDirectory(dir, false, tracked);
  const modified: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  for (const [path, file] of local) {
    const recorded = state.files[path];
    if (recorded === undefined) added.push(path);
    else if (recorded !== file.sha256) modified.push(path);
  }
  for (const path of Object.keys(state.files)) if (!local.has(path)) deleted.push(path);
  deleted.sort();
  return { modified, added, deleted };
}

export const shellWord = (word: string): string =>
  /^[\w./@:+=-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
