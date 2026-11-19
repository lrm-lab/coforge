import { mkdir } from "node:fs/promises";
import type { AgentRuntimeConfig, AgentSession, AgentSessionOptions } from "@coforge/agent";
import { evalDisablesHostPiInjection } from "@coforge/agent";
import { prepareCloudComputerAgentSkills } from "@coforge/agent/cloud-computer-skills";
import type { CodeAgentProviderFactory } from "@lrm/coforge-anvil";
import {
  buildCoforgeAgentInstructions,
  type AgentLaunchIdentity,
} from "#src/code-agent/agent-instructions";
import { installAssignedSkills, type AssignedSkillPack } from "#src/code-agent/assigned-skills";
import { agentEnvironment, usableAgentEnvironment } from "#src/code-agent/environment";
import { resolveGitHookInjectionForLaunch } from "#src/code-agent/git-hooks";
import { seedAgentMemory } from "./agent-memory-seed";
import { withMemoryRecovery } from "./session-memory-recovery";
export type AgentLaunchInput = Readonly<{
  agentId: string;
  config: AgentRuntimeConfig;
  agentWorkspaceDirectory: string;
  sessionId?: string;
  sessionMode?: AgentSessionOptions["sessionMode"];
  contextViewRequestLogDirectory?: string;
  environment?: Readonly<Record<string, string>>;
  runtimeId?: string;
  onSessionId?: AgentSessionOptions["onSessionId"];
  assignedSkillPacks?: readonly AssignedSkillPack[];
  identity?: AgentLaunchIdentity;
  onInstructions?: (instructions: string) => void;
}>;
export type AgentLaunchPreparationPorts = Readonly<{
  createProvider: CodeAgentProviderFactory;
  resolveGitHooks: typeof resolveGitHookInjectionForLaunch;
}>;
export function platformCriticalRules(
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  if (platform !== "win32") return [];
  return [
    "Windows PowerShell: use a multiline single-quoted here-string (not POSIX `<<'EOF'`):\n@'\n...\n'@ | coforge message send --target '#channel'",
  ];
}
export async function prepareAgentLaunch(
  input: AgentLaunchInput,
  ports: AgentLaunchPreparationPorts,
): Promise<AgentSessionOptions> {
  const {
    agentId,
    config,
    agentWorkspaceDirectory,
    sessionId,
    environment,
    runtimeId,
    onSessionId,
    sessionMode,
    contextViewRequestLogDirectory,
    assignedSkillPacks = [],
    identity,
    onInstructions,
  } = input;
  await mkdir(agentWorkspaceDirectory, { recursive: true, mode: 0o700 });
  const disableHostPiInjection =
    evalDisablesHostPiInjection(environment) || evalDisablesHostPiInjection();
  if (!disableHostPiInjection) {
    await seedAgentMemory(agentWorkspaceDirectory, {
      name: identity?.name,
      displayName: identity?.displayName,
    });
    await prepareCloudComputerAgentSkills({
      agentId,
      agentWorkspaceDirectory,
      environment: { ...Bun.env, ...environment },
    });
    if (assignedSkillPacks.length > 0) {
      await installAssignedSkills({
        provider: config.provider,
        agentWorkspaceDirectory,
        packs: assignedSkillPacks,
        agentId,
        environment: { ...Bun.env, ...environment },
      });
    }
  }
  const gitHooks: Awaited<ReturnType<typeof resolveGitHookInjectionForLaunch>> =
    await ports.resolveGitHooks(
      agentEnvironment(environment, Bun.env, process.platform, {
        envVars: config.envVars,
        provider: config.provider,
      }).PATH,
    );
  const extraCriticalRules = platformCriticalRules();
  const instructions = buildCoforgeAgentInstructions({
    agentWorkspaceDirectory,
    agentId,
    identity,
    ...(extraCriticalRules.length > 0 ? { extraCriticalRules } : {}),
    capabilities: {
      cloudDesktop: Boolean(environment?.DISPLAY),
    },
  });
  onInstructions?.(instructions);
  const options: AgentSessionOptions = {
    agentId,
    ...(runtimeId ? { runtimeId } : {}),
    agentWorkspaceDirectory,
    instructions,
    sessionId,
    sessionMode,
    contextViewRequestLogDirectory,
    onSessionId,
    runtime: config.envVars
      ? { ...config, envVars: usableAgentEnvironment(config.envVars, config.provider) }
      : config,
    environment,
    gitHooks,
  };
  return options;
}
export async function createAgentSession(
  input: AgentLaunchInput,
  options: AgentSessionOptions,
  ports: AgentLaunchPreparationPorts,
): Promise<AgentSession> {
  const provider = ports.createProvider(input.config.provider);
  const session = await provider.createAgentSession(options);
  return withMemoryRecovery(session, input.agentWorkspaceDirectory);
}
