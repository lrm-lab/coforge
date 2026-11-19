import { expect, test } from "bun:test";
import { type Tree, treeViolations } from "./tree-rules";
import { useTestRepo } from "../git-hooks/test-repo";

const tree = (files: Record<string, string>): Tree => ({
  paths: Object.keys(files),
  read: (wanted) =>
    new Map(wanted.flatMap((path) => (path in files ? [[path, files[path]!]] : []))),
});
const found = (files: Record<string, string>, added: string[] = []) =>
  treeViolations(tree(files), added, []).map((v) => `${v.rule} ${v.location}: ${v.found}`);

const FEATURES = "apps/web/src/features";
const SERVER = "apps/web/src/server";

test("every module directory needs a map line, and every map line a directory", () => {
  const files = {
    [`${FEATURES}/AGENTS.md`]: "- `features/a/` — one.\n- `features/gone/`, `features/b/` — two.\n",
    [`${FEATURES}/a/x.ts`]: "",
    [`${FEATURES}/b/x.ts`]: "",
    [`${FEATURES}/c/x.ts`]: "",
    [`${FEATURES}/loose.ts`]: "",
    [`${SERVER}/AGENTS.md`]: "- `server/db/` — the database.\n",
    [`${SERVER}/db/x.ts`]: "",
    [`${SERVER}/new/x.ts`]: "",
  };

  expect(found(files)).toEqual([
    `module-map ${FEATURES}/AGENTS.md: ${FEATURES}/c/ has no line in the map`,
    `module-map ${FEATURES}/AGENTS.md: the map names features/gone/, which does not exist`,
    `module-map ${SERVER}/AGENTS.md: ${SERVER}/new/ has no line in the map`,
  ]);
});

test("a directory named in prose or inside another line's text counts; a loose file does not need one", () => {
  const files = {
    [`${SERVER}/AGENTS.md`]:
      "- `server/http/`, `server/install/` — origins.\nSee also `server/auth/`.\n",
    [`${SERVER}/http/x.ts`]: "",
    [`${SERVER}/install/x.ts`]: "",
    [`${SERVER}/auth/x.ts`]: "",
    [`${SERVER}/redis-keys.server.ts`]: "",
  };

  expect(found(files)).toEqual([]);
});

test("the module map and documentation index apply only where the repository has the rules", () => {
  expect(found({ "docs/a.md": "x", "README.md": "# Repo\n", [`${FEATURES}/z/x.ts`]: "" })).toEqual(
    [],
  );
});

test("README must link each entry directly under docs/, and AGENTS.md each nested AGENTS.md", () => {
  const files = {
    "AGENTS.md": "# Rules\n",
    "README.md": "[a](docs/a.md) [b](docs/b/README.md) [dir](docs/d/) [web](apps/web/AGENTS.md)\n",
    "docs/a.md": "",
    "docs/b/README.md": "",
    "docs/d/x.md": "",
    "docs/e.md": "",
    "docs/f/x.md": "",
    "apps/web/AGENTS.md": "[ok](src/server/AGENTS.md)\n",
    "apps/web/src/server/AGENTS.md": "- `server/records/` — records.\n",
    "apps/web/src/server/records/AGENTS.md": "",
    "apps/web/src/lib/AGENTS.md": "",
    "apps/docs/AGENTS.md": "",
  };

  expect(found(files)).toEqual([
    "docs-index README.md: docs/e.md is not linked from the documentation index",
    "docs-index README.md: docs/f is not linked from the documentation index",
    "docs-index apps/web/src/server/records/AGENTS.md: no link from README.md or an ancestor AGENTS.md",
    "docs-index apps/web/src/lib/AGENTS.md: no link from README.md or an ancestor AGENTS.md",
    "docs-index apps/docs/AGENTS.md: no link from README.md or an ancestor AGENTS.md",
  ]);
});

test("a link in code does not index, and a link from a descendant or a sibling does not either", () => {
  const files = {
    "AGENTS.md": "# Rules\n",
    "README.md": "`[a](docs/a.md)`\n",
    "docs/a.md": "",
    "x/AGENTS.md": "[y](y/AGENTS.md)\n",
    "x/y/AGENTS.md": "[x](../AGENTS.md)\n",
    "x/z/AGENTS.md": "[y](../y/AGENTS.md)\n",
  };

  expect(found(files)).toEqual([
    "docs-index README.md: docs/a.md is not linked from the documentation index",
    "docs-index x/AGENTS.md: no link from README.md or an ancestor AGENTS.md",
    "docs-index x/z/AGENTS.md: no link from README.md or an ancestor AGENTS.md",
  ]);
});

test("a package.json depending on next, or a Next.js directive in the Web app, is blocked", () => {
  const files = {
    "package.json": JSON.stringify({ dependencies: { react: "1" } }),
    "apps/web/package.json": JSON.stringify({ devDependencies: { next: "15" } }),
    "apps/b/package.json": JSON.stringify({
      peerDependencies: { "next-themes": "1" },
      name: "next",
    }),
    "apps/c/package.json": "not json",
  };

  expect(
    treeViolations(tree(files), [], ["apps/web/src/a.ts"]).map((v) => `${v.location}: ${v.found}`),
  ).toEqual([
    "apps/web/src/a.ts: a Next.js server directive or data function",
    "apps/web/package.json: devDependencies depends on next",
  ]);
});

test("an added docs/adr file or docs/architecture.md is blocked; an existing one is not added", () => {
  expect(
    found({}, [
      "docs/adr/0001.md",
      "docs/architecture.md",
      "docs/architecture/x.md",
      "docs/adrenaline.md",
    ]),
  ).toEqual([
    "no-decision-docs docs/adr/0001.md: a decision log or architecture document",
    "no-decision-docs docs/architecture.md: a decision log or architecture document",
  ]);
});

test("any tracked file under docs/research/ is blocked across the whole tree", () => {
  expect(
    found({
      "docs/research/README.md": "# Research\n",
      "docs/research/nested/audit.md": "# Audit\n",
      "docs/research-notes.md": "# Not under docs/research/\n",
      "docs/agents/reference-cli-research/README.md": "# Reference guide\n",
    }),
  ).toEqual([
    "no-research-docs docs/research/README.md: a research or audit note under docs/research/",
    "no-research-docs docs/research/nested/audit.md: a research or audit note under docs/research/",
  ]);
});

const repo = useTestRepo();

test("a commit with a Next.js directive, a next dependency or a new ADR is blocked, and a clean one passes", () => {
  repo.seed({ "README.md": "# Repo\n" });
  repo.write({
    "apps/web/src/a.ts": `export async function f() {\n  "use server";\n}\n`,
    "apps/web/src/b.ts": "export const getServerSideProps = 1;\n",
    "apps/web/package.json": JSON.stringify({ dependencies: { next: "15" } }),
    "docs/adr/0001-x.md": "# ADR\n",
  });

  const blocked = repo.commitAll();

  expect(blocked.exitCode).not.toBe(0);
  expect(blocked.stderr).toContain("no-nextjs (3)");
  expect(blocked.stderr).toContain("apps/web/src/a.ts");
  expect(blocked.stderr).toContain("apps/web/src/b.ts");
  expect(blocked.stderr).toContain("apps/web/package.json: dependencies depends on next");
  expect(blocked.stderr).toContain("no-decision-docs (1)");

  repo.ok("reset", "-q");
  repo.write({ "apps/web/src/a.ts": "export const a = 1;\n" });
  repo.ok(
    "rm",
    "-q",
    "--cached",
    "-r",
    "--ignore-unmatch",
    "apps/web/src/b.ts",
    "apps/web/package.json",
    "docs/adr",
  );
  expect(repo.range(repo.head()).stderr).toBe("");
});

test("range mode judges the tree at the head", () => {
  const base = repo.seed({ "README.md": "# Repo\n" });
  repo.seed({ "apps/web/src/a.ts": `"use server";\n` });

  const result = repo.range(base);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("no-nextjs");
  expect(result.stderr).toContain("apps/web/src/a.ts");
});

test("a commit or range leaving any file under docs/research/ is blocked until removed", () => {
  const base = repo.seed({ "README.md": "# Repo\n", "docs/research/old.md": "# Old\n" });

  repo.write({ "README.md": "# Updated\n" });
  const blocked = repo.commitAll();
  expect(blocked.exitCode).not.toBe(0);
  expect(blocked.stderr).toContain("no-research-docs (1)");
  expect(blocked.stderr).toContain("docs/research/old.md");

  repo.seed({ "README.md": "# Still has research\n" });
  const rangeBlocked = repo.range(base);
  expect(rangeBlocked.exitCode).toBe(1);
  expect(rangeBlocked.stderr).toContain("no-research-docs (1)");
  expect(rangeBlocked.stderr).toContain("docs/research/old.md");

  repo.ok("rm", "-q", "docs/research/old.md");
  expect(repo.commitAll()).toMatchObject({ exitCode: 0, stderr: "" });
  expect(repo.range(base).stderr).toBe("");
});
