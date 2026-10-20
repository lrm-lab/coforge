// The pre-commit size check (`.githooks/pre-commit` runs it from the repository being committed).
// It blocks a staged file over the token limit unless the file was already over it at HEAD and did
// not grow: a ratchet that lets oversized files shrink but stops new ones and growth. Sizes are the
// staged blobs' (the index git is committing from, `GIT_INDEX_FILE` included), never the working
// tree's. Files the staged `.gitattributes` marks `linguist-generated`, and binary files, are not
// written by agents and are skipped; so is an agent-written file it marks `size-limit=off` because
// it cannot be split. See docs/agents/git-hooks.md.
//
// usage: bun scripts/git-hooks/staged-file-size.ts   (exit 1 lists the blocked files on stderr)

export const MAX_FILE_TOKENS = 5_000;
/** The estimate the limit is stated in: one token per four bytes. */
export const BYTES_PER_TOKEN = 4;
export const MAX_FILE_BYTES = MAX_FILE_TOKENS * BYTES_PER_TOKEN;
/** Git's own binary heuristic: a NUL byte within the first 8000 bytes. */
const BINARY_PROBE_BYTES = 8000;

export type StagedFile = {
  path: string;
  stagedBytes: number;
  /** The HEAD blob it replaces (for a rename or copy, the source path's); undefined when new. */
  head?: { path: string; bytes: number };
};

export type SizeViolation = StagedFile & { reason: "new" | "crossed" | "grew" };

/** Why `file` may not be committed, or undefined when it may. */
export function sizeViolation(file: StagedFile): SizeViolation | undefined {
  if (file.stagedBytes <= MAX_FILE_BYTES) return undefined;
  if (file.head === undefined) return { ...file, reason: "new" };
  if (file.head.bytes <= MAX_FILE_BYTES) return { ...file, reason: "crossed" };
  if (file.stagedBytes > file.head.bytes) return { ...file, reason: "grew" };
  return undefined;
}

export function tokens(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

const count = (value: number) => value.toLocaleString("en-US");

export function formatViolations(violations: SizeViolation[]): string {
  const lines = violations.map((violation) => {
    const size = `${count(tokens(violation.stagedBytes))} tokens`;
    const head = violation.head;
    // Bytes, not tokens: two sizes a few bytes apart can round to the same token count.
    const growth = head
      ? `grew from ${count(head.bytes)} to ${count(violation.stagedBytes)} bytes${head.path === violation.path ? "" : ` (${head.path} at HEAD)`}`
      : "";
    const why =
      violation.reason === "new"
        ? "new file over the limit"
        : violation.reason === "crossed"
          ? `crossed the limit: ${growth}`
          : `already over the limit and ${growth}`;
    return `  ${violation.path}: ${size}, ${why}`;
  });
  return [
    `Commit blocked: ${violations.length === 1 ? "1 staged file exceeds" : `${violations.length} staged files exceed`} the ${count(MAX_FILE_TOKENS)}-token limit (tokens = bytes / ${BYTES_PER_TOKEN}, so ${count(MAX_FILE_BYTES)} bytes).`,
    "",
    ...lines,
    "",
    "Split the file into smaller ones. A file already over the limit may be committed only at or below its HEAD size.",
    "Only if a file is genuinely generated (lockfile, codegen, data), mark it `linguist-generated` in .gitattributes.",
    "See docs/agents/git-hooks.md.",
  ].join("\n");
}

function git(args: string[], stdin?: string): string {
  const result = Bun.spawnSync(["git", ...args], {
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

const GITLINK_MODE = "160000";
const NULL_OID = /^0+$/;

type RawChange = {
  path: string;
  oid: string;
  head?: { path: string; oid: string };
};

/** The staged additions, modifications, renames and type changes against HEAD (the empty tree
 * before the first commit), from `git diff-index --raw -z`. Rename detection has no limit
 * (`-l0`), so a large commit cannot turn a renamed oversized file into a new one. Copy detection
 * stays off, so a copy is a new file: duplicating an oversized file adds oversized content.
 * Deletions and submodules are not files this check sizes. */
function stagedChanges(): RawChange[] {
  const hasHead = Bun.spawnSync(["git", "rev-parse", "--verify", "-q", "HEAD^{commit}"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const base =
    hasHead.exitCode === 0 ? "HEAD" : git(["hash-object", "-t", "tree", "--stdin"], "").trim();
  const fields = git([
    "diff-index",
    "--cached",
    "--raw",
    "-z",
    "-M",
    "-l0",
    "--no-abbrev",
    "--diff-filter=AMRT",
    base,
  ]).split("\0");
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
  const lines = git(
    ["cat-file", "--batch-check=%(objectname) %(objectsize)"],
    `${unique.join("\n")}\n`,
  );
  for (const line of lines.split("\n")) {
    const [oid, size] = line.split(" ");
    if (oid && size && /^\d+$/.test(size)) sizes.set(oid, Number(size));
  }
  return sizes;
}

/** Paths the staged `.gitattributes` exempts: `linguist-generated` set (or `=true`), or
 * `size-limit=off` (any other `size-limit` value, or none, leaves a file checked). */
function exemptPaths(paths: string[]): Set<string> {
  const exempt = new Set<string>();
  if (paths.length === 0) return exempt;
  const fields = git(
    ["check-attr", "--cached", "-z", "--stdin", "linguist-generated", "size-limit"],
    `${paths.join("\0")}\0`,
  ).split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [path, attribute, value] = [fields[i]!, fields[i + 1], fields[i + 2]];
    const generated = attribute === "linguist-generated" && (value === "set" || value === "true");
    if (generated || (attribute === "size-limit" && value === "off")) exempt.add(path);
  }
  return exempt;
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

/** The staged files that may not be committed, in the order git lists them. */
export async function stagedSizeViolations(): Promise<SizeViolation[]> {
  const changes = stagedChanges();
  const sizes = blobSizes(
    changes.flatMap((change) => (change.head ? [change.oid, change.head.oid] : [change.oid])),
  );
  const sizeOf = (oid: string) => {
    const size = sizes.get(oid);
    if (size === undefined) throw new Error(`git cat-file reported no size for ${oid}`);
    return size;
  };
  const candidates: { violation: SizeViolation; oid: string }[] = [];
  for (const change of changes) {
    const violation = sizeViolation({
      path: change.path,
      stagedBytes: sizeOf(change.oid),
      head: change.head && { path: change.head.path, bytes: sizeOf(change.head.oid) },
    });
    if (violation) candidates.push({ violation, oid: change.oid });
  }
  const exempt = exemptPaths(candidates.map(({ violation }) => violation.path));
  const violations: SizeViolation[] = [];
  for (const { violation, oid } of candidates) {
    if (exempt.has(violation.path) || (await isBinaryBlob(oid))) continue;
    violations.push(violation);
  }
  return violations;
}

if (import.meta.main) {
  const violations = await stagedSizeViolations();
  if (violations.length > 0) {
    console.error(formatViolations(violations));
    process.exit(1);
  }
}
