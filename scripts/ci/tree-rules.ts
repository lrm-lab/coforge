// The hard rules judged on the whole tree a change leaves, not on its diff: the web module maps
// and the documentation index must be complete, and Next.js and docs/research/ must not exist. Pure functions of
// the tracked paths and a file reader, so the tests need no repository; hard-rules.ts supplies both.
// `no-decision-docs` judges the change's added files. See docs/agents/git-hooks/hard-rules.md.
import { dirname, posix } from "node:path";
import type { ChangeSource } from "../git-hooks/staged-file-size";
import { linkPath, markdownLinks } from "./markdown-links";

export type TreeRule =
  | "module-map"
  | "docs-index"
  | "no-nextjs"
  | "no-decision-docs"
  | "no-research-docs";
export type TreeViolation = { rule: TreeRule; location: string; found: string };
export type Tree = { paths: string[]; read: (paths: string[]) => Map<string, string> };

export const TREE_FIX: Record<TreeRule, string> = {
  "module-map":
    "Give every directory under apps/web/src/features/ and apps/web/src/server/ one line in that directory's AGENTS.md (a bullet naming `features/<name>/`), and delete a line whose directory is gone.",
  "docs-index":
    "Link every file or directory directly under docs/ from README.md, and every nested AGENTS.md from README.md or an ancestor AGENTS.md, one line saying what it covers.",
  "no-nextjs":
    'The Web app is TanStack Start: remove the `next` dependency, the `"use server"` directive or `getServerSideProps` (AGENTS.md, Toolchain).',
  "no-decision-docs":
    "This repository keeps no ADRs and no separate architecture document: record the decision in the CR description, and the maintained rules in AGENTS.md.",
  "no-research-docs":
    "This repository keeps no docs/research/ directory or research/audit notes: delete the files and record findings in the task thread, CR description, or scratch artifacts.",
};

const MAPS = [
  { dir: "apps/web/src/features", prefix: "features" },
  { dir: "apps/web/src/server", prefix: "server" },
];

/** The module directories of `dir` (the first path component of each tracked file in one). */
function subdirectories(paths: string[], dir: string): string[] {
  const names = new Set<string>();
  for (const path of paths)
    if (path.startsWith(`${dir}/`)) {
      const [name, ...rest] = path.slice(dir.length + 1).split("/");
      if (rest.length > 0) names.add(name!);
    }
  return [...names].sort();
}

/** Every module directory has a line in its map, and every map line names an existing directory. */
function moduleMap({ paths, read }: Tree): TreeViolation[] {
  const violations: TreeViolation[] = [];
  const maps = MAPS.filter(({ dir }) => paths.includes(`${dir}/AGENTS.md`));
  const files = read(maps.map(({ dir }) => `${dir}/AGENTS.md`));
  for (const { dir, prefix } of maps) {
    const location = `${dir}/AGENTS.md`;
    const text = files.get(location) ?? "";
    const modules = new Set(subdirectories(paths, dir));
    for (const name of modules)
      if (!text.includes(`\`${prefix}/${name}/\``))
        violations.push({
          rule: "module-map",
          location,
          found: `${dir}/${name}/ has no line in the map`,
        });
    // A map line opens with its backticked directories, then ` — `.
    for (const line of text.split("\n").filter((row) => row.startsWith("- `"))) {
      for (const [, name] of line
        .split(" — ")[0]!
        .matchAll(new RegExp(`\`${prefix}/([a-z0-9-]+)/\``, "g")))
        if (!modules.has(name!))
          violations.push({
            rule: "module-map",
            location,
            found: `the map names ${prefix}/${name}/, which does not exist`,
          });
    }
  }
  return violations;
}

/** The repository paths the links of `files` name, per file. */
function linkTargets(files: Map<string, string>): Map<string, Set<string>> {
  const targets = new Map<string, Set<string>>();
  for (const [path, text] of files) {
    const set = new Set<string>();
    for (const link of markdownLinks(text)) {
      const target = linkPath(path, link.target);
      if (target !== undefined) set.add(target);
    }
    targets.set(path, set);
  }
  return targets;
}

/** Whether a link in `sources` names `path` or something inside it. */
const linked = (targets: Map<string, Set<string>>, sources: string[], path: string) =>
  sources.some((source) =>
    [...(targets.get(source) ?? [])].some(
      (target) => target === path || target.startsWith(`${path}/`),
    ),
  );

/** README.md indexes what is directly under docs/, and every nested AGENTS.md is linked from the
 * README or an ancestor AGENTS.md. Applies where the root AGENTS.md states the rule. */
function docsIndex({ paths, read }: Tree): TreeViolation[] {
  if (!paths.includes("AGENTS.md") || !paths.includes("README.md")) return [];
  const agents = paths.filter((path) => path.endsWith("/AGENTS.md") || path === "AGENTS.md");
  const targets = linkTargets(read(["README.md", ...agents]));
  const violations: TreeViolation[] = [];
  const entries = new Set<string>();
  for (const path of paths)
    if (path.startsWith("docs/")) entries.add(path.split("/").slice(0, 2).join("/"));
  for (const entry of [...entries].sort())
    if (!linked(targets, ["README.md"], entry))
      violations.push({
        rule: "docs-index",
        location: "README.md",
        found: `${entry} is not linked from the documentation index`,
      });
  for (const path of agents.filter((agent) => agent !== "AGENTS.md")) {
    const ancestors = ["README.md"];
    for (let dir = posix.dirname(dirname(path)); ; dir = posix.dirname(dir)) {
      ancestors.push(dir === "." ? "AGENTS.md" : `${dir}/AGENTS.md`);
      if (dir === ".") break;
    }
    if (!linked(targets, ancestors, path))
      violations.push({
        rule: "docs-index",
        location: path,
        found: "no link from README.md or an ancestor AGENTS.md",
      });
  }
  return violations;
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/** A package.json that depends on `next`; `hits` are the files git grep found carrying
 * `"use server"` or `getServerSideProps` under apps/web/src. */
function nextjs({ paths, read }: Tree, hits: string[]): TreeViolation[] {
  const manifests = paths.filter(
    (path) => path === "package.json" || path.endsWith("/package.json"),
  );
  const violations: TreeViolation[] = hits.map((location) => ({
    rule: "no-nextjs",
    location,
    found: "a Next.js server directive or data function",
  }));
  for (const [location, text] of read(manifests)) {
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(text);
    } catch {
      continue;
    }
    for (const field of DEPENDENCY_FIELDS) {
      const section = manifest[field];
      if (typeof section === "object" && section !== null && "next" in section)
        violations.push({ rule: "no-nextjs", location, found: `${field} depends on next` });
    }
  }
  return violations;
}

/** Files the change adds under docs/adr/, or as docs/architecture.md. */
function decisionDocs(added: string[]): TreeViolation[] {
  return added
    .filter((path) => /^docs\/adr(\/|$)|^docs\/architecture\.md$/.test(path))
    .map((location) => ({
      rule: "no-decision-docs" as const,
      location,
      found: "a decision log or architecture document",
    }));
}

function researchDocs({ paths }: Tree): TreeViolation[] {
  return paths
    .filter((path) => /^docs\/research(\/|$)/.test(path))
    .map((location) => ({
      rule: "no-research-docs" as const,
      location,
      found: "a research or audit note under docs/research/",
    }));
}

export function treeViolations(
  tree: Tree,
  added: string[],
  serverDirectiveHits: string[],
): TreeViolation[] {
  return [
    ...moduleMap(tree),
    ...docsIndex(tree),
    ...nextjs(tree, serverDirectiveHits),
    ...decisionDocs(added),
    ...researchDocs(tree),
  ];
}

/** The files under apps/web/src that carry `"use server"` or `getServerSideProps`, read from the
 * index or the range head. */
export function serverDirectiveFiles(source: ChangeSource): string[] {
  const search = ["-l", "-E", `["']use server["']|getServerSideProps`];
  const args =
    source.kind === "staged"
      ? ["grep", "--cached", ...search, "--", "apps/web/src"]
      : ["grep", ...search, source.head, "--", "apps/web/src"];
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  // Exit 1 is "no match"; anything else is a git error, and a gate must not pass on it.
  if (result.exitCode > 1)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  const prefix = source.kind === "staged" ? "" : `${source.head}:`;
  return result.stdout
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(prefix.length));
}
