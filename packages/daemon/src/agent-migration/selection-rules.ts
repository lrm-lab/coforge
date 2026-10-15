import { isAbsolute, normalize, posix, relative, resolve, sep } from "node:path";
import { AGENT_MEMORY_FILE, AGENT_WORK_DIRECTORY } from "#src/agent-runtime/agent-workspace-path";

/**
 * The rules deciding which workspace paths an Agent migration carries, apart from the walk that
 * applies them. They follow the reference Computer's migration as shipped in Raft Computer 1.0.47
 * (darwin-arm64, release 38026b19-199f-4f13-b044-de5a8f9b5b50, binary sha256
 * 34bb347a1f4c58b1bb6a2851f78079a4e7a742b7e832430478619ae8e59604e9, observed 2026-10-14):
 * regenerable directories are skipped at any depth, an ignore file in the workspace root lists
 * literal paths to leave behind, and the memory index and the ignore file always move. Unlike the
 * reference, which uploads them, secrets stay on the source Computer.
 */

export const AGENT_MIGRATION_IGNORE_FILE = ".coforgemigrateignore";

/** Where the target writes a migration's commit marker; never carried on to a later move. */
export const AGENT_MIGRATION_COMMIT_DIRECTORY = ".coforge-migration";

/**
 * What a new workspace's ignore file starts with. The Agent's code in `work/` stays behind by
 * default and is cloned again on the target; the Agent or its owner removes the line to carry it.
 */
export const AGENT_MIGRATION_IGNORE_SEED = `# Paths an Agent migration leaves on this Computer, one per line, relative to the workspace.
# Remove "${AGENT_WORK_DIRECTORY}" to carry your code, including uncommitted changes, to the new Computer.
${AGENT_WORK_DIRECTORY}
`;

export const ALWAYS_MOVED: ReadonlySet<string> = new Set([
  AGENT_MEMORY_FILE,
  AGENT_MIGRATION_IGNORE_FILE,
]);

export type RegenerableCategory = "thirdPartyDependencies" | "caches" | "buildArtifacts";

const REGENERABLE: Record<RegenerableCategory, readonly string[]> = {
  thirdPartyDependencies: [
    ".nox",
    ".pnpm-store",
    ".terraform",
    ".tox",
    ".venv",
    "bower_components",
    "node_modules",
    "vendor",
  ],
  caches: [
    ".cache",
    ".dart_tool",
    ".gradle",
    ".mypy_cache",
    ".parcel-cache",
    ".pytest_cache",
    ".ruff_cache",
    ".turbo",
    "__pycache__",
  ],
  buildArtifacts: [".next", ".nuxt", ".svelte-kit", "dist", "target"],
};

const CATEGORY_BY_NAME = new Map<string, RegenerableCategory>(
  (Object.keys(REGENERABLE) as RegenerableCategory[]).flatMap((category) =>
    REGENERABLE[category].map((name) => [name, category] as const),
  ),
);

/** The category of a directory a migration skips because tools can rebuild it, if any. */
export function regenerableCategory(directoryName: string): RegenerableCategory | undefined {
  return CATEGORY_BY_NAME.get(directoryName);
}

/** Directories that hold machine credentials, matched by name at any depth. */
const CREDENTIAL_DIRECTORIES = new Set([".aws", ".gnupg", ".ssh"]);

/** Names that look like secrets, matched against every path segment. */
const SECRET_NAME_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /(?:^|[._-])secrets?(?:[._-]|$)/i,
  /(?:^|[._-])credentials?(?:[._-]|$)/i,
  /(?:^|[._-])tokens?(?:[._-]|$)/i,
];

/** Whether a file or directory name marks a secret the migration leaves on the source. */
export function isSecretName(name: string): boolean {
  return (
    CREDENTIAL_DIRECTORIES.has(name) || SECRET_NAME_PATTERNS.some((pattern) => pattern.test(name))
  );
}

/** Ignore-file lines with these characters are globs, which the format does not support. */
const GLOB_CHARACTERS = /[*?[\]!]/;

/**
 * The ignore file's literal paths as workspace-relative POSIX paths. Blank lines, `#` comments,
 * globs, paths outside the workspace and the always-moved files are dropped.
 */
export function parseIgnoredPaths(text: string, root: string): Set<string> {
  const ignored = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || GLOB_CHARACTERS.test(line)) continue;
    const absolute = isAbsolute(line) ? normalize(line) : resolve(root, line);
    const path = relative(root, absolute).split(sep).join(posix.sep).replace(/\/+$/, "");
    if (!path || path === ".." || path.startsWith("../") || isAbsolute(path)) continue;
    if (!ALWAYS_MOVED.has(path)) ignored.add(path);
  }
  return ignored;
}

/** Characters and forms no workspace-relative path may hold: NUL, backslashes, a drive prefix. */
function hasForeignPathForm(path: string) {
  return path.includes("\0") || path.includes("\\") || /^[A-Za-z]:/.test(path);
}

/**
 * Whether `path` is a plain workspace-relative POSIX path: not empty, not absolute, and with no
 * empty, `.` or `..` segment, so it can only name something inside the workspace.
 */
export function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || hasForeignPathForm(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Whether a symlink in `directory` may move with the workspace: its target must be relative and
 * resolve to a path strictly inside the workspace root, never the root itself.
 */
export function isWorkspaceSymlinkTarget(
  root: string,
  directory: string,
  linkTarget: string,
): boolean {
  if (!linkTarget || isAbsolute(linkTarget) || hasForeignPathForm(linkTarget)) return false;
  return resolve(directory, linkTarget).startsWith(root + sep);
}
