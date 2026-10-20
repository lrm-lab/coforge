// The file size ratchet, and the git change model the hard rules share. scripts/ci/hard-rules.ts
// runs the ratchet on the commit being made (`.githooks/pre-commit`) and on CI's commit range. It
// blocks a file over the token limit unless the file was already over it at the base (HEAD, or the
// range's base) and did not grow: a ratchet that lets oversized files shrink but stops new ones and
// growth. Sizes are the staged blobs' (the index git is committing from, `GIT_INDEX_FILE`
// included) or the range head's, never the working tree's. Files the staged (or head)
// `.gitattributes` marks `linguist-generated`, and binary files, are not written by agents and are
// skipped. See docs/agents/git-hooks/size-limit.md.

const MAX_FILE_TOKENS = 5_000;
/** The estimate the limit is stated in: one token per four bytes. */
const BYTES_PER_TOKEN = 4;
const MAX_FILE_BYTES = MAX_FILE_TOKENS * BYTES_PER_TOKEN;
/** Git's own binary heuristic: a NUL byte within the first 8000 bytes. */
const BINARY_PROBE_BYTES = 8000;

type StagedFile = {
  path: string;
  stagedBytes: number;
  /** The base blob it replaces (for a rename or copy, the source path's); undefined when new. */
  head?: { path: string; bytes: number };
};

type SizeViolation = StagedFile & { reason: "new" | "crossed" | "grew" };

/** The change judged: the index against HEAD (a commit being made), or one commit against
 * another (CI's range, from its merge base). */
export type ChangeSource = { kind: "staged" } | { kind: "range"; base: string; head: string };

function sizeViolation(file: StagedFile): SizeViolation | undefined {
  if (file.stagedBytes <= MAX_FILE_BYTES) return undefined;
  if (file.head === undefined) return { ...file, reason: "new" };
  if (file.head.bytes <= MAX_FILE_BYTES) return { ...file, reason: "crossed" };
  if (file.stagedBytes > file.head.bytes) return { ...file, reason: "grew" };
  return undefined;
}

const count = (value: number) => value.toLocaleString("en-US");

/** How to resolve a size violation, with the limit it enforces. */
export const SIZE_FIX = `The limit is ${count(MAX_FILE_TOKENS)} tokens, estimated as bytes / ${BYTES_PER_TOKEN} (${count(MAX_FILE_BYTES)} bytes). Split each file into smaller ones; a file already over the limit may only stay the same size or shrink. Mark a file \`linguist-generated\` in .gitattributes only if a tool genuinely produces it (lockfile, codegen, data).`;

/** What is wrong with a violating file: its size and why; `base` names where a rename's source
 * path was. */
export function describeViolation(violation: SizeViolation, base: string): string {
  const size = `${count(Math.ceil(violation.stagedBytes / BYTES_PER_TOKEN))} tokens`;
  const head = violation.head;
  // Bytes, not tokens: two sizes a few bytes apart can round to the same token count.
  const growth = head
    ? `grew from ${count(head.bytes)} to ${count(violation.stagedBytes)} bytes${head.path === violation.path ? "" : ` (${head.path} at ${base})`}`
    : "";
  const why =
    violation.reason === "new"
      ? "new file over the limit"
      : violation.reason === "crossed"
        ? `crossed the limit: ${growth}`
        : `already over the limit and ${growth}`;
  return `${size}, ${why}`;
}

/** Runs git with paths printed verbatim (`core.quotePath=false`) and returns its stdout. */
export function git(args: string[], stdin?: string): Buffer {
  const result = Bun.spawnSync(["git", "-c", "core.quotePath=false", ...args], {
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout;
}

/** What staged content is compared with: HEAD, or the empty tree before the first commit. */
function stagedBase(): string {
  const hasHead = Bun.spawnSync(["git", "rev-parse", "--verify", "-q", "HEAD^{commit}"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return hasHead.exitCode === 0
    ? "HEAD"
    : git(["hash-object", "-t", "tree", "--stdin"], "").toString().trim();
}

/** The git command that diffs `source` with `flags`: staged against `stagedBase()`
 * (`diff-index --cached`), or head against base (`diff-tree -r`). */
export function diffArgs(source: ChangeSource, ...flags: string[]): string[] {
  return source.kind === "staged"
    ? ["diff-index", "--cached", ...flags, stagedBase()]
    : ["diff-tree", "-r", ...flags, source.base, source.head];
}

/** Where the exemption lists (`.gitattributes`, `skills-lock.json`) are read from: the change's
 * base, so a change cannot exempt itself. In a range, the merge base it is judged from. Staged,
 * the base CI will judge it from: HEAD's merge base with origin/main, else with its upstream, else
 * HEAD, so neither `--amend` nor a list committed locally just before exempts anything early (with
 * no origin/main and no upstream, they can until CI); before the first commit, the empty tree. */
export function policyRevision(source: ChangeSource): string {
  if (source.kind === "range") return source.base;
  const base = stagedBase();
  if (base !== "HEAD") return base;
  // origin/main first: a pull request is judged from main, not from its branch's upstream.
  for (const upstream of ["origin/main", "@{upstream}"]) {
    const mergeBase = Bun.spawnSync(["git", "merge-base", "HEAD", upstream], { stderr: "ignore" });
    if (mergeBase.exitCode === 0) return mergeBase.stdout.toString().trim();
  }
  return base;
}

const GITLINK_MODE = "160000";
const NULL_OID = /^0+$/;

type RawChange = {
  path: string;
  oid: string;
  head?: { path: string; oid: string };
};

/** The additions, modifications, renames and type changes the change makes, from `diffArgs` as
 * `--raw -z`. Rename detection has no limit (`-l0`), so a large change cannot turn a renamed
 * oversized file into a new one. Copy detection stays off, so a copy is a new file: duplicating
 * an oversized file adds oversized content. Deletions and submodules are not files this check
 * sizes. */
function changes(source: ChangeSource): RawChange[] {
  const args = diffArgs(source, "--raw", "-z", "-M", "-l0", "--no-abbrev", "--diff-filter=AMRT");
  const fields = git(args).toString().split("\0");
  const changes: RawChange[] = [];
  for (let i = 0; i < fields.length; i++) {
    const meta = fields[i]!;
    if (!meta.startsWith(":")) continue;
    // :<src mode> <dst mode> <src oid> <dst oid> <status>, then one path or, for a rename, two.
    const [srcMode, dstMode, srcOid, dstOid, status] = meta.slice(1).split(" ");
    const twoPaths = status!.startsWith("R");
    const srcPath = fields[++i]!;
    const dstPath = twoPaths ? fields[++i]! : srcPath;
    if (dstMode === GITLINK_MODE) continue;
    const hasSource = !NULL_OID.test(srcOid!) && srcMode !== GITLINK_MODE;
    changes.push({
      path: dstPath,
      oid: dstOid!,
      head: hasSource ? { path: srcPath, oid: srcOid! } : undefined,
    });
  }
  return changes;
}

function blobSizes(oids: string[]): Map<string, number> {
  const unique = [...new Set(oids)];
  const sizes = new Map<string, number>();
  if (unique.length === 0) return sizes;
  const input = `${unique.join("\n")}\n`;
  const lines = git(["cat-file", "--batch-check=%(objectname) %(objectsize)"], input).toString();
  for (const line of lines.split("\n")) {
    const [oid, size] = line.split(" ");
    if (oid && size && /^\d+$/.test(size)) sizes.set(oid, Number(size));
  }
  return sizes;
}

/** Paths the base's `.gitattributes` (`policyRevision`) marks `linguist-generated` (set, or
 * `=true`). */
function generatedPaths(paths: string[], source: ChangeSource): Set<string> {
  const generated = new Set<string>();
  if (paths.length === 0) return generated;
  const from = `--source=${policyRevision(source)}`;
  const input = `${paths.join("\0")}\0`;
  const output = git(["check-attr", from, "-z", "--stdin", "linguist-generated"], input);
  const fields = output.toString().split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const value = fields[i + 2];
    if (value === "set" || value === "true") generated.add(fields[i]!);
  }
  return generated;
}

async function isBinaryBlob(oid: string): Promise<boolean> {
  const child = Bun.spawn(["git", "cat-file", "blob", oid], { stdout: "pipe", stderr: "ignore" });
  const reader = child.stdout.getReader();
  let read = 0;
  try {
    while (read < BINARY_PROBE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const probe = value.subarray(0, BINARY_PROBE_BYTES - read);
      if (probe.includes(0)) return true;
      read += probe.length;
    }
    return false;
  } finally {
    await reader.cancel();
    child.kill();
    await child.exited;
  }
}

/** The files the change may not add or grow, in the order git lists them. */
export async function sizeViolations(source: ChangeSource): Promise<SizeViolation[]> {
  const changed = changes(source);
  const sizes = blobSizes(
    changed.flatMap((change) => (change.head ? [change.oid, change.head.oid] : [change.oid])),
  );
  const sizeOf = (oid: string) => {
    const size = sizes.get(oid);
    if (size === undefined) throw new Error(`git cat-file reported no size for ${oid}`);
    return size;
  };
  const candidates: { violation: SizeViolation; oid: string }[] = [];
  for (const change of changed) {
    const violation = sizeViolation({
      path: change.path,
      stagedBytes: sizeOf(change.oid),
      head: change.head && { path: change.head.path, bytes: sizeOf(change.head.oid) },
    });
    if (violation) candidates.push({ violation, oid: change.oid });
  }
  const generated = generatedPaths(
    candidates.map(({ violation }) => violation.path),
    source,
  );
  const violations: SizeViolation[] = [];
  for (const { violation, oid } of candidates) {
    if (generated.has(violation.path) || (await isBinaryBlob(oid))) continue;
    violations.push(violation);
  }
  return violations;
}
