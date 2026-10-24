import { existsSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { codeAgentExecutableSearchPath } from "#src/platform/code-agent-path";
import type { CodeAgentProbe } from "@lrm/coforge-anvil";

export type ExternalCodeAgentProbe = CodeAgentProbe & {
  /** Provider-specific installer locations are outside PATH; production checks them on disk while
   * tests declare their own hermetic filesystem boundary. */
  exists?(executable: string): boolean | Promise<boolean>;
};

type InstalledExecutableCandidates = (
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
) => string[];

const noInstalledExecutableCandidates: InstalledExecutableCandidates = () => [];

function homeDirectory(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return environment.HOME ?? environment.USERPROFILE;
}

function codexInstalledExecutableCandidates(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string[] {
  const home = homeDirectory(environment);
  const installDirectory = environment.CODEX_INSTALL_DIR;
  // Codex's standalone installer can target CODEX_INSTALL_DIR. The macOS Codex and ChatGPT apps
  // bundle the same CLI under Contents/Resources:
  // https://developers.openai.com/codex/app/
  const candidates = installDirectory ? [join(installDirectory, RUNTIME_PROVIDER.CODEX)] : [];
  if (home) candidates.push(join(home, ".local", "bin", RUNTIME_PROVIDER.CODEX));
  if (platform !== "darwin") return candidates;
  for (const applicationDirectory of [
    ...(home ? [join(home, "Applications")] : []),
    "/Applications",
  ])
    for (const application of ["ChatGPT.app", "Codex.app"])
      candidates.push(
        join(applicationDirectory, application, "Contents", "Resources", RUNTIME_PROVIDER.CODEX),
      );
  return candidates;
}

function openCodeInstalledExecutableCandidates(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string[] {
  const home = homeDirectory(environment);
  return home
    ? [
        join(
          home,
          ".opencode",
          "bin",
          platform === "win32" ? "opencode.exe" : RUNTIME_PROVIDER.OPENCODE,
        ),
      ]
    : [];
}

function grokInstalledExecutableCandidates(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string[] {
  const executable = platform === "win32" ? "grok.exe" : RUNTIME_PROVIDER.GROK;
  const home = homeDirectory(environment);
  return [
    ...(environment.GROK_BIN_DIR ? [join(environment.GROK_BIN_DIR, executable)] : []),
    ...(environment.GROK_HOME ? [join(environment.GROK_HOME, "bin", executable)] : []),
    ...(home ? [join(home, ".grok", "bin", executable)] : []),
  ];
}

export const externalCodeAgents = [
  {
    provider: RUNTIME_PROVIDER.CODEX,
    executable: RUNTIME_PROVIDER.CODEX,
    installedExecutableCandidates: codexInstalledExecutableCandidates,
  },
  {
    provider: RUNTIME_PROVIDER.CLAUDE_CODE,
    executable: "claude",
    installedExecutableCandidates: noInstalledExecutableCandidates,
  },
  {
    provider: RUNTIME_PROVIDER.KIRO,
    executable: "kiro-cli",
    installedExecutableCandidates: noInstalledExecutableCandidates,
  },
  {
    provider: RUNTIME_PROVIDER.CURSOR,
    executable: "cursor-agent",
    installedExecutableCandidates: noInstalledExecutableCandidates,
  },
  {
    provider: RUNTIME_PROVIDER.OPENCODE,
    executable: RUNTIME_PROVIDER.OPENCODE,
    // The official installer sets INSTALL_DIR=$HOME/.opencode/bin:
    // https://opencode.ai/v2/install
    installedExecutableCandidates: openCodeInstalledExecutableCandidates,
  },
  {
    provider: RUNTIME_PROVIDER.GROK,
    executable: RUNTIME_PROVIDER.GROK,
    // The official installer uses GROK_BIN_DIR or $HOME/.grok/bin:
    // https://x.ai/cli/install.sh
    installedExecutableCandidates: grokInstalledExecutableCandidates,
  },
  {
    provider: RUNTIME_PROVIDER.ANTIGRAVITY,
    executable: "agy",
    installedExecutableCandidates: noInstalledExecutableCandidates,
  },
] as const;

export type ExternalCodeAgentProvider = (typeof externalCodeAgents)[number]["provider"];
export type ExternalCodeAgent = (typeof externalCodeAgents)[number];

export const externalCodeAgent: Record<ExternalCodeAgentProvider, ExternalCodeAgent> =
  Object.fromEntries(externalCodeAgents.map((agent) => [agent.provider, agent])) as Record<
    ExternalCodeAgentProvider,
    ExternalCodeAgent
  >;

export async function resolveExternalCodeAgentExecutable(
  agent: ExternalCodeAgent,
  probe: ExternalCodeAgentProbe,
  searchPath: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  const resolved = await probe.resolve?.(agent.provider, agent.executable, searchPath);
  if (resolved) return resolved;
  const fromPath = probe.which(agent.executable, searchPath);
  if (fromPath) return fromPath;
  for (const candidate of agent.installedExecutableCandidates(environment, platform))
    if (await probe.exists?.(candidate)) return candidate;
  return undefined;
}

/** Resolves the executable a production Provider will launch, using the same PATH and installer
 * candidates as inventory. Provider construction is synchronous, so this host-only form uses
 * filesystem checks directly rather than the asynchronous test probe seam above. */
export function resolveHostCodeAgentExecutable(
  provider: ExternalCodeAgentProvider,
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const agent = externalCodeAgent[provider];
  const searchPath = codeAgentExecutableSearchPath(environment, platform);
  const fromPath = Bun.which(agent.executable, { PATH: searchPath });
  if (fromPath) return fromPath;
  return agent
    .installedExecutableCandidates(environment, platform)
    .find((candidate) => existsSync(candidate));
}
