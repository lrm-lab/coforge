import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError } from "../cli-error";

export type AgentProfile = {
  schemaVersion: 1;
  serverUrl: string;
  workspaceId: string;
  workspaceSlug: string;
  agentId: string;
  agentName: string;
  credentialId: string;
  apiKey: string;
  createdAt: string;
};

export type PendingLogin = {
  serverUrl: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  interval: number;
  workspace: string;
  agent: string;
};

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CREDENTIAL_FILE = "credential.json";
const PENDING_FILE = "pending.json";
const CURSOR_FILE = "inbox-cursor";

export function isValidProfileSlug(value: string): boolean {
  return SLUG.test(value);
}

export function defaultProfileSlug(workspaceSlug: string, agentName: string): string {
  return `${workspaceSlug}-${agentName}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

export function agentHome(env: Record<string, string | undefined>): string {
  return env.COFORGE_AGENT_HOME?.trim() || join(homedir(), ".coforge", "agent");
}

function storeUnavailable(): CliError {
  return new CliError({
    code: "PROFILE_STORE_UNAVAILABLE",
    message: "The Agent profile directory is unavailable.",
    retryable: false,
  });
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isProfile(value: unknown): value is AgentProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Record<string, unknown>;
  return (
    profile.schemaVersion === 1 &&
    ["serverUrl", "workspaceId", "workspaceSlug", "agentId", "agentName", "credentialId"].every(
      (key) => typeof profile[key] === "string" && profile[key],
    ) &&
    typeof profile.apiKey === "string" &&
    profile.apiKey.length > 0 &&
    typeof profile.createdAt === "string"
  );
}

function isPending(value: unknown): value is PendingLogin {
  if (!value || typeof value !== "object") return false;
  const pending = value as Record<string, unknown>;
  return (
    [
      "serverUrl",
      "deviceCode",
      "userCode",
      "verificationUri",
      "expiresAt",
      "workspace",
      "agent",
    ].every((key) => typeof pending[key] === "string" && pending[key]) &&
    typeof pending.interval === "number" &&
    Number.isFinite(pending.interval)
  );
}

export function profileStore(env: Record<string, string | undefined>) {
  const root = join(agentHome(env), "profiles");
  const directoryOf = (slug: string) => {
    if (!isValidProfileSlug(slug))
      throw new CliError({
        code: "PROFILE_INVALID",
        message: `"${slug}" is not a valid profile name; use letters, digits, ".", "_" and "-".`,
        retryable: false,
      });
    return join(root, slug);
  };

  async function writePrivate(slug: string, name: string, text: string): Promise<void> {
    try {
      const directory = directoryOf(slug);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const temporary = join(directory, `.${name}.${crypto.randomUUID()}.tmp`);
      try {
        await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, join(directory, name));
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw storeUnavailable();
    }
  }

  async function readText(slug: string, name: string): Promise<string | undefined> {
    try {
      return await readFile(join(directoryOf(slug), name), "utf8");
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (isMissing(error)) return undefined;
      throw storeUnavailable();
    }
  }

  async function readJson<T>(
    slug: string,
    name: string,
    guard: (value: unknown) => value is T,
  ): Promise<T | undefined> {
    const text = await readText(slug, name);
    if (text === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!guard(parsed))
      throw new CliError({
        code: "PROFILE_CORRUPT",
        message: `The ${name} of profile "${slug}" is unreadable.`,
        retryable: false,
        suggestedNextAction: `Run \`coforge agent login --profile ${slug}\` again.`,
      });
    return parsed;
  }

  async function remove(slug: string, name: string): Promise<void> {
    try {
      await rm(join(directoryOf(slug), name), { force: true });
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw storeUnavailable();
    }
  }

  async function listWithFile(name: string): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (error) {
      if (isMissing(error)) return [];
      throw storeUnavailable();
    }
    const found: string[] = [];
    for (const entry of entries.sort())
      if (isValidProfileSlug(entry) && (await readText(entry, name)) !== undefined)
        found.push(entry);
    return found;
  }

  return {
    pathOf: (slug: string) => directoryOf(slug),
    credentialPathOf: (slug: string) => join(directoryOf(slug), CREDENTIAL_FILE),
    readProfile: (slug: string) => readJson(slug, CREDENTIAL_FILE, isProfile),
    readProfileIgnoreCorrupt: async (slug: string): Promise<AgentProfile | undefined> => {
      try {
        return await readJson(slug, CREDENTIAL_FILE, isProfile);
      } catch (error) {
        if (error instanceof CliError && error.code === "PROFILE_CORRUPT") return undefined;
        throw error;
      }
    },
    writeProfile: (slug: string, profile: AgentProfile) =>
      writePrivate(slug, CREDENTIAL_FILE, `${JSON.stringify(profile, null, 2)}\n`),
    removeProfile: (slug: string) => remove(slug, CREDENTIAL_FILE),
    readPending: (slug: string) => readJson(slug, PENDING_FILE, isPending),
    writePending: (slug: string, pending: PendingLogin) =>
      writePrivate(slug, PENDING_FILE, `${JSON.stringify(pending, null, 2)}\n`),
    removePending: (slug: string) => remove(slug, PENDING_FILE),
    readCursor: async (slug: string) => (await readText(slug, CURSOR_FILE))?.trim() || undefined,
    writeCursor: (slug: string, cursor: string) => writePrivate(slug, CURSOR_FILE, `${cursor}\n`),
    removeCursor: (slug: string) => remove(slug, CURSOR_FILE),
    listProfiles: () => listWithFile(CREDENTIAL_FILE),
    listPendingLogins: () => listWithFile(PENDING_FILE),
  };
}

export type ProfileStore = ReturnType<typeof profileStore>;

export type ExternalSession = { slug: string; path: string; profile: AgentProfile };
