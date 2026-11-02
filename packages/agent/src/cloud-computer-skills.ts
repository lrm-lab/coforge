import { cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Image / entrypoint sets this on CoForge cloud-computer containers only. */
export const COFORGE_CLOUD_COMPUTER_ENV = "COFORGE_CLOUD_COMPUTER";

export function isCloudComputerSkillsEnabled(
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): boolean {
  const value = environment[COFORGE_CLOUD_COMPUTER_ENV];
  return value === "1" || value === "true";
}

export function cloudComputerWorkspaceRoot(
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): string {
  const root =
    environment.WORKSPACE?.trim() || environment.COFORGE_WORKSPACE?.trim() || "/workspace";
  return resolve(root);
}

/** Container-shared skills (also bind-mounted to /root/.pi/agent/skills on the image). */
export function cloudComputerSharedSkillsDirectory(
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): string {
  return join(cloudComputerWorkspaceRoot(environment), "skills");
}

/** Per-Agent skills on the cloud computer persistent volume. */
export function cloudComputerAgentSkillsDirectory(
  agentId: string,
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): string {
  if (!STABLE_ID.test(agentId)) {
    throw new Error("workspace and Agent IDs must be stable path-safe identifiers");
  }
  return join(cloudComputerWorkspaceRoot(environment), "agent-skills", agentId);
}

/** Extra Pi skill roots for cloud-computer sessions (empty when gate is off). */
export function cloudComputerAdditionalSkillPaths(options: {
  agentId?: string;
  environment?: Readonly<Record<string, string | undefined>>;
}): string[] {
  const environment = options.environment ?? Bun.env;
  if (!isCloudComputerSkillsEnabled(environment)) return [];
  const paths = [cloudComputerSharedSkillsDirectory(environment)];
  if (options.agentId && STABLE_ID.test(options.agentId)) {
    paths.push(cloudComputerAgentSkillsDirectory(options.agentId, environment));
  }
  return paths;
}

/**
 * Ensures the persistent Agent skills directory exists, migrates a legacy
 * `<agentWs>/.pi/skills` tree into it once, and best-effort bind-mounts so
 * naive writes to `.pi/skills` also land on the volume. No-op when the cloud
 * gate is off (non-cloud-computer).
 */
export async function prepareCloudComputerAgentSkills(options: {
  agentId: string;
  agentWorkspaceDirectory: string;
  environment?: Readonly<Record<string, string | undefined>>;
}): Promise<{ enabled: boolean; directory: string; bound: boolean }> {
  const environment = options.environment ?? Bun.env;
  const legacy = join(resolve(options.agentWorkspaceDirectory), ".pi", "skills");
  if (!isCloudComputerSkillsEnabled(environment)) {
    return { enabled: false, directory: legacy, bound: false };
  }

  const directory = cloudComputerAgentSkillsDirectory(options.agentId, environment);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await migrateLegacyAgentSkills(legacy, directory);
  // Shared container skills are also visible through the Agent `.pi/skills` root
  // (bind-mounted below), so the default Pi loader finds them without runner changes.
  await seedSharedSkillsInto(directory, environment);
  const bound = tryBindMount(directory, legacy);
  if (!bound) {
    await mkdir(legacy, { recursive: true, mode: 0o700 });
    await seedSharedSkillsInto(legacy, environment);
  }
  return { enabled: true, directory, bound };
}

async function seedSharedSkillsInto(
  destination: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const shared = cloudComputerSharedSkillsDirectory(environment);
  let entries: string[];
  try {
    entries = await readdir(shared);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const from = join(shared, name);
    const to = join(destination, name);
    try {
      const stat = await lstat(from);
      if (!stat.isDirectory()) continue;
      await lstat(join(from, "SKILL.md"));
    } catch {
      continue;
    }
    try {
      await lstat(to);
      continue; // Agent-specific or earlier seed wins
    } catch {
      // copy shared skill into the Agent-visible tree
    }
    await cp(from, to, { recursive: true, verbatimSymlinks: true });
  }
}

async function migrateLegacyAgentSkills(legacy: string, persistent: string): Promise<void> {
  let legacyStat;
  try {
    legacyStat = await lstat(legacy);
  } catch {
    return;
  }
  if (!legacyStat.isDirectory() || legacyStat.isSymbolicLink()) return;
  if (await isBindMountOf(legacy, persistent)) return;

  let entries: string[];
  try {
    entries = await readdir(legacy);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const from = join(legacy, name);
    const to = join(persistent, name);
    try {
      await lstat(to);
      continue; // persistent already has this skill
    } catch {
      // copy then remove source entry
    }
    await cp(from, to, { recursive: true, verbatimSymlinks: true });
    await rm(from, { recursive: true, force: true });
  }
}

async function isBindMountOf(target: string, source: string): Promise<boolean> {
  if (process.platform !== "linux") return false;
  const result = spawnSync("findmnt", ["-n", "-o", "SOURCE,TARGET", target], {
    encoding: "utf8",
  });
  if (result.status !== 0) return false;
  const line = result.stdout.trim();
  return line.includes(source) || line.includes(resolve(source));
}

function tryBindMount(source: string, target: string): boolean {
  if (process.platform !== "linux") return false;
  try {
    const sourceResolved = resolve(source);
    const targetResolved = resolve(target);
    spawnSync("mkdir", ["-p", targetResolved], { stdio: "ignore" });
    // If something already occupies the target as a non-empty real tree, clear it
    // only when empty-after-migration; otherwise refuse to mount over data.
    const probe = spawnSync("findmnt", ["-n", targetResolved], { encoding: "utf8" });
    if (probe.status === 0 && probe.stdout.trim()) {
      return probe.stdout.includes(sourceResolved);
    }
    const mounted = spawnSync("mount", ["--bind", sourceResolved, targetResolved], {
      encoding: "utf8",
    });
    return mounted.status === 0;
  } catch {
    return false;
  }
}

/** Prepare durable skill roots and return Pi additionalSkillPaths (empty off-gate). */
export async function prepareCloudComputerSessionSkillPaths(options: {
  agentId?: string;
  agentWorkspaceDirectory: string;
  environment?: Readonly<Record<string, string | undefined>>;
}): Promise<string[]> {
  const environment = options.environment ?? Bun.env;
  if (options.agentId) {
    await prepareCloudComputerAgentSkills({
      agentId: options.agentId,
      agentWorkspaceDirectory: options.agentWorkspaceDirectory,
      environment,
    });
  }
  const paths = cloudComputerAdditionalSkillPaths({
    agentId: options.agentId,
    environment,
  });
  for (const path of paths) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  return paths;
}
