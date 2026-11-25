// Shared check runner for both local gates (`scripts/ci/local-gate.ts`) and GitHub Actions
// (`scripts/ci/validate-each.sh`, `.github/workflows/ci.yml`), so local and CI run the exact same
// commands and flags:
// 1. `oxlint --deny-warnings` on changed source files (grouped by workspace `.oxlintrc.json`).
// 2. `tsc --noEmit` across every changed workspace and all transitive downstream `workspace:*`
//    dependents (with SDK/Prisma/i18n codegen when needed).
// 3. Script-contract and library suite checks (`validate-each`).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { sanitizedStdio } from "./safe-stdio";

export type WorkspaceInfo = {
  dir: string;
  name: string;
  hasTypecheck: boolean;
  hasBuild: boolean;
  workspaceDeps: string[];
};

const LINTABLE_EXT = /\.(?:ts|tsx|js|jsx|mjs|mts|cjs)$/;
const GENERATED_SEGMENT = /(?:^|\/)(?:generated|gen|paraglide)\/|(?:^|\/)routeTree\.gen\.ts$/;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Discovers all workspace packages under `apps/*` and `packages/*` and their `workspace:*` edges. */
export function discoverWorkspaces(root: string): WorkspaceInfo[] {
  const dirs: string[] = [];
  for (const parent of ["packages", "apps"]) {
    const base = join(root, parent);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = join(base, entry.name, "package.json");
      if (existsSync(pkgPath)) dirs.push(`${parent}/${entry.name}`);
    }
  }

  const rawList = dirs.map((dir) => {
    const pkg = readJson<{
      name?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }>(join(root, dir, "package.json"));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const workspaceDeps = Object.entries(allDeps)
      .filter(([, version]) => typeof version === "string" && version.startsWith("workspace:"))
      .map(([dep]) => dep);
    return {
      dir,
      name: pkg.name ?? dir,
      hasTypecheck: Boolean(pkg.scripts?.typecheck),
      hasBuild: Boolean(pkg.scripts?.build),
      workspaceDeps,
    };
  });

  return rawList.sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * Given `changedPaths` (repo-relative), returns the directly touched workspaces plus all
 * transitive downstream workspaces that depend on them via `workspace:*`.
 */
export function downstreamWorkspaces(root: string, changedPaths: string[]): WorkspaceInfo[] {
  const workspaces = discoverWorkspaces(root);
  const byName = new Map(workspaces.map((ws) => [ws.name, ws]));
  const dependents = new Map<string, Set<string>>();
  for (const ws of workspaces) {
    for (const depName of ws.workspaceDeps) {
      const dep = byName.get(depName);
      if (!dep) continue;
      const set = dependents.get(dep.dir) ?? new Set<string>();
      set.add(ws.dir);
      dependents.set(dep.dir, set);
    }
  }

  const queue: string[] = [];
  const seen = new Set<string>();
  for (const path of changedPaths) {
    const owner = workspaces.find((ws) => path.startsWith(`${ws.dir}/`) || path === ws.dir);
    if (owner && !seen.has(owner.dir)) {
      seen.add(owner.dir);
      queue.push(owner.dir);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const downstream of dependents.get(current) ?? []) {
      if (!seen.has(downstream)) {
        seen.add(downstream);
        queue.push(downstream);
      }
    }
  }

  return workspaces.filter((ws) => seen.has(ws.dir));
}

function runCommand(cmd: string[], cwd: string): boolean {
  const result = Bun.spawnSync(cmd, { cwd, stdio: sanitizedStdio({ detachStdin: true }) });
  return result.exitCode === 0;
}

/** Runs `tsc --noEmit` (with SDK/Prisma/i18n codegen when needed) on `workspaces`. */
export function runWorkspaceTypechecks(root: string, workspaces: WorkspaceInfo[]): boolean {
  const targets = workspaces.filter((ws) => ws.hasTypecheck);
  if (targets.length === 0) return true;

  const needsSdk = targets.some(
    (ws) => ws.dir === "packages/coforge-sdk" || ws.workspaceDeps.includes("@lrm/coforge-sdk"),
  );
  if (needsSdk && !runCommand(["bun", "run", "--cwd", "packages/coforge-sdk", "generate"], root)) {
    return false;
  }

  if (targets.some((ws) => ws.dir === "apps/web")) {
    if (!runCommand(["bun", "run", "--cwd", "apps/web", "db:generate"], root)) return false;
    if (!runCommand(["bun", "run", "--cwd", "apps/web", "generate-i18n"], root)) return false;
  }

  let ok = true;
  for (const ws of targets) {
    console.log(`typecheck: ${ws.dir}`);
    if (!runCommand(["bun", "run", "--cwd", ws.dir, "typecheck"], root)) ok = false;
  }
  return ok;
}

/**
 * Runs `oxlint --deny-warnings` on `paths`, grouped by the nearest workspace `.oxlintrc.json`
 * (`apps/web`, `apps/docs`, or repo root), so warnings fail identically locally and in CI.
 */
export function lintFilesStrict(root: string, paths: string[]): boolean {
  const groups = new Map<string, string[]>();
  const configDirs = ["apps/web", "apps/docs"];

  for (const rawPath of paths) {
    const rel = rawPath.startsWith(`${root}/`) ? relative(root, rawPath) : rawPath;
    if (!LINTABLE_EXT.test(rel) || GENERATED_SEGMENT.test(rel)) continue;
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    const owner = configDirs.find((dir) => rel.startsWith(`${dir}/`)) ?? ".";
    const list = groups.get(owner) ?? [];
    list.push(owner === "." ? rel : rel.slice(owner.length + 1));
    groups.set(owner, list);
  }

  if (groups.size === 0) return true;

  let ok = true;
  const fallbackBin = join(import.meta.dir, "../../packages/coforge/node_modules/.bin/oxlint");
  for (const [owner, files] of groups) {
    const cwd = owner === "." ? root : join(root, owner);
    const localBin = join(cwd, "node_modules/.bin/oxlint");
    const rootBin = join(root, "node_modules/.bin/oxlint");
    const oxlintBin = existsSync(localBin) ? localBin : existsSync(rootBin) ? rootBin : fallbackBin;
    if (!existsSync(oxlintBin)) continue;
    if (!runCommand([process.execPath, "--bun", oxlintBin, "--deny-warnings", ...files], cwd))
      ok = false;
  }
  return ok;
}

/** Runs `test` + `check` (and `build` for libraries when present) for each suite in `names`. */
export function runValidateEach(
  root: string,
  kind: "scripts" | "libraries",
  names: string[],
): boolean {
  const failed: string[] = [];
  for (const name of names) {
    console.log(`::group::${name}`);
    let passed = false;
    if (kind === "scripts") {
      passed =
        runCommand(["bun", "run", `test:${name}`], root) &&
        runCommand(["bun", "run", `check:${name}`], root);
    } else {
      const dir = `packages/${name}`;
      const pkg = readJson<{ scripts?: Record<string, string> }>(join(root, dir, "package.json"));
      passed =
        runCommand(["bun", "run", "--cwd", dir, "test"], root) &&
        runCommand(["bun", "run", "--cwd", dir, "check"], root) &&
        (!pkg.scripts?.build || runCommand(["bun", "run", "--cwd", dir, "build"], root));
    }
    console.log("::endgroup::");
    if (!passed) {
      failed.push(name);
      console.error(`::error::${name} failed`);
    }
  }
  if (failed.length > 0) {
    console.error(`::error::Failed: ${failed.join(" ")}`);
    return false;
  }
  return true;
}

function diffFiles(root: string, base: string, head: string): string[] {
  const result = Bun.spawnSync(["git", "diff", "--name-only", "--no-renames", "-z", base, head], {
    cwd: root,
    stdout: "pipe",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error(`git diff failed between ${base} and ${head}`);
  return result.stdout.toString().split("\0").filter(Boolean);
}

if (import.meta.main) {
  const root = join(import.meta.dir, "../..");
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "--lint-range") {
    const [base, head = "HEAD"] = args;
    if (!base) throw new Error("usage: run-checks.ts --lint-range <base> [head]");
    const files = diffFiles(root, base, head);
    process.exit(lintFilesStrict(root, files) ? 0 : 1);
  }
  if (mode === "--lint-files") {
    process.exit(lintFilesStrict(root, args) ? 0 : 1);
  }
  if (mode === "--downstream-typecheck") {
    const [base, head = "HEAD"] = args;
    if (!base) throw new Error("usage: run-checks.ts --downstream-typecheck <base> [head]");
    const files = diffFiles(root, base, head);
    const affected = downstreamWorkspaces(root, files);
    process.exit(runWorkspaceTypechecks(root, affected) ? 0 : 1);
  }
  if (mode === "--validate-each") {
    const [kind, json] = args;
    if ((kind !== "scripts" && kind !== "libraries") || !json) {
      throw new Error("usage: run-checks.ts --validate-each scripts|libraries '<json-array>'");
    }
    const names = JSON.parse(json) as string[];
    process.exit(runValidateEach(root, kind, names) ? 0 : 1);
  }
  console.error(
    "usage: run-checks.ts --lint-range <base> [head] | --lint-files <files...> | --downstream-typecheck <base> [head] | --validate-each scripts|libraries '<json>'",
  );
  process.exit(2);
}
