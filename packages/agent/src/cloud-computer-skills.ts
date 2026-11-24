import { chmod, cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const SHARED_SKILL_ROOT_MODE = 0o2775;
const AGENT_SKILL_LEAF_MODE = 0o700;

const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const COFORGE_CLOUD_COMPUTER_ENV = "COFORGE_CLOUD_COMPUTER";

export const CLOUD_COMPUTER_ONLY_SKILL_NAMES: ReadonlySet<string> = new Set([
  "browser-login",
  "cloud-computer-overview",
]);

const CLOUD_COMPUTER_APPEND_SYSTEM_HEADING = "# CoForge 云电脑身份与能力";

export function isCloudComputerOnlySkillName(name: string): boolean {
  return CLOUD_COMPUTER_ONLY_SKILL_NAMES.has(name.trim());
}

export function isCloudComputerAppendSystemPrompt(text: string): boolean {
  return text.trimStart().startsWith(CLOUD_COMPUTER_APPEND_SYSTEM_HEADING);
}

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

export function cloudComputerSharedSkillsDirectory(
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): string {
  return join(cloudComputerWorkspaceRoot(environment), "skills");
}

export function cloudComputerAgentSkillsDirectory(
  agentId: string,
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): string {
  if (!STABLE_ID.test(agentId)) {
    throw new Error("workspace and Agent IDs must be stable path-safe identifiers");
  }
  return join(cloudComputerWorkspaceRoot(environment), "agent-skills", agentId);
}

export function cloudComputerAgentSkillsRoot(
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): string {
  return join(cloudComputerWorkspaceRoot(environment), "agent-skills");
}

export async function ensureCloudComputerSkillDirectories(options: {
  agentId?: string;
  environment?: Readonly<Record<string, string | undefined>>;
}): Promise<void> {
  const environment = options.environment ?? Bun.env;
  if (!isCloudComputerSkillsEnabled(environment)) return;
  await Promise.all([
    ensureDirectoryMode(cloudComputerSharedSkillsDirectory(environment), SHARED_SKILL_ROOT_MODE),
    ensureDirectoryMode(cloudComputerAgentSkillsRoot(environment), SHARED_SKILL_ROOT_MODE),
  ]);
  if (options.agentId && STABLE_ID.test(options.agentId)) {
    await ensureDirectoryMode(
      cloudComputerAgentSkillsDirectory(options.agentId, environment),
      AGENT_SKILL_LEAF_MODE,
    );
  }
}

async function ensureDirectoryMode(path: string, mode: number): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await chmod(path, mode).catch(() => undefined);
}

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

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function prepareCloudComputerAgentSkills(options: {
  agentId: string;
  agentWorkspaceDirectory: string;
  environment?: Readonly<Record<string, string | undefined>>;
}): Promise<{ enabled: boolean; directory: string }> {
  const environment = options.environment ?? Bun.env;
  const workspaceDir = resolve(options.agentWorkspaceDirectory);
  const dotPi = join(workspaceDir, ".pi");
  const legacy = join(dotPi, "skills");
  if (!isCloudComputerSkillsEnabled(environment)) {
    if (
      (await isRealDirectory(workspaceDir)) &&
      (await isRealDirectory(dotPi)) &&
      (await isRealDirectory(legacy))
    ) {
      await Promise.all(
        [...CLOUD_COMPUTER_ONLY_SKILL_NAMES].map((name) =>
          rm(join(legacy, name), { recursive: true, force: true }),
        ),
      );
    }
    return { enabled: false, directory: legacy };
  }

  const directory = cloudComputerAgentSkillsDirectory(options.agentId, environment);
  await ensureCloudComputerSkillDirectories({
    agentId: options.agentId,
    environment,
  });
  await migrateLegacyAgentSkills(legacy, directory);
  await seedSharedSkillsInto(directory, environment);
  await mirrorSkillsTree(directory, legacy);
  return { enabled: true, directory };
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

/** Replace `target` with a fresh copy of `source` (real trees, no softlink roots). */
async function mirrorSkillsTree(source: string, target: string): Promise<void> {
  await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true, verbatimSymlinks: true });
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
  } else {
    await ensureCloudComputerSkillDirectories({ environment });
  }
  return cloudComputerAdditionalSkillPaths({
    agentId: options.agentId,
    environment,
  });
}
