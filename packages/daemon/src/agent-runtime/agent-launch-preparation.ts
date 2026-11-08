import { mkdir } from "node:fs/promises";
import type { AgentRuntimeConfig, AgentSession, AgentSessionOptions } from "@coforge/agent";
import { evalDisablesHostPiInjection, isMemoryAgentRuntime } from "@coforge/agent";
import { prepareCloudComputerAgentSkills } from "@coforge/agent/cloud-computer-skills";
import { isMemoryAgentToolProfile } from "@lrm/coforge-sdk/agent";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { CodeAgentProviderFactory } from "@lrm/coforge-anvil";
import {
  buildCoforgeAgentInstructions,
  type AgentLaunchIdentity,
} from "#src/code-agent/agent-instructions";
import { installAssignedSkills, type AssignedSkillPack } from "#src/code-agent/assigned-skills";
import { agentEnvironment, usableAgentEnvironment } from "#src/code-agent/environment";
import { resolveGitHookInjectionForLaunch } from "#src/code-agent/git-hooks";
import { seedAgentMemory } from "./agent-memory-seed";
import {
  MemoryConversationSessions,
  type ConversationSessionStore,
} from "./memory-conversation-sessions";

/** What one launch names before a provider is asked: the workspace it runs in, the identity it
 * reports, and the native Session it resumes or starts. */
export type AgentLaunchInput = Readonly<{
  agentId: string;
  config: AgentRuntimeConfig;
  agentWorkspaceDirectory: string;
  sessionId?: string;
  sessionMode?: AgentSessionOptions["sessionMode"];
  environment?: Readonly<Record<string, string>>;
  runtimeId?: string;
  onSessionId?: AgentSessionOptions["onSessionId"];
  assignedSkillPacks?: readonly AssignedSkillPack[];
  identity?: AgentLaunchIdentity;
}>;

export type AgentLaunchPreparationPorts = Readonly<{
  createProvider: CodeAgentProviderFactory;
  resolveGitHooks: typeof resolveGitHookInjectionForLaunch;
  conversationStore?: (agentId: string) => ConversationSessionStore;
}>;

/**
 * Everything a launch must do before its provider is asked for a session: make the workspace,
 * seed the Memory an Agent starts from, install the skills it was assigned, probe the git hooks
 * against the PATH its own git calls will search, and assemble the options that name it.
 *
 * Split out of `AgentProcessManager.start`, which reads as launch ordering and process ownership;
 * this half only describes a launch.
 */
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
    assignedSkillPacks = [],
    identity,
  } = input;
  await mkdir(agentWorkspaceDirectory, { recursive: true, mode: 0o700 });
  const disableHostPiInjection =
    isMemoryAgentToolProfile(config.toolProfile) ||
    evalDisablesHostPiInjection(environment) ||
    evalDisablesHostPiInjection();
  if (!disableHostPiInjection) {
    await seedAgentMemory(agentWorkspaceDirectory, {
      name: identity?.name,
      displayName: identity?.displayName,
    });
    // Cloud-computer only: migrate/bind Agent skills onto /workspace/agent-skills/<id>.
    // No-op when COFORGE_CLOUD_COMPUTER is unset (non-cloud-computer).
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
  // Probed against the same PATH the Agent's own git calls will search.
  const gitHooks: Awaited<ReturnType<typeof resolveGitHookInjectionForLaunch>> =
    await ports.resolveGitHooks(
      agentEnvironment(environment, Bun.env, process.platform, {
        envVars: config.envVars,
        provider: config.provider,
      }).PATH,
    );
  const options: AgentSessionOptions = {
    agentId,
    ...(runtimeId ? { runtimeId } : {}),
    agentWorkspaceDirectory,
    ...(isMemoryAgentRuntime(config) ? { memoryControlSession: true } : {}),
    instructions: buildCoforgeAgentInstructions({
      agentWorkspaceDirectory,
      agentId,
      identity,
      toolProfile: config.toolProfile,
      capabilities: {
        memoryDisposition: config.provider === RUNTIME_PROVIDER.COFORGE,
        cloudDesktop: Boolean(environment?.DISPLAY),
      },
    }),
    sessionId,
    sessionMode,
    onSessionId,
    // The provider reads this map too (adapter path lookups); it gets the same environment
    // the process will, without the names the shared rule refuses. An Agent with no stored
    // environment keeps the configuration it was started with, field for field.
    runtime: config.envVars
      ? { ...config, envVars: usableAgentEnvironment(config.envVars, config.provider) }
      : config,
    environment,
    gitHooks,
  };
  return options;
}

/** Asks the provider for the session those options describe, wrapping it for Memory Agents. */
export async function createAgentSession(
  input: AgentLaunchInput,
  options: AgentSessionOptions,
  ports: AgentLaunchPreparationPorts,
): Promise<AgentSession> {
  const provider = ports.createProvider(input.config.provider);
  let session = await provider.createAgentSession(options);
  if (isMemoryAgentRuntime(input.config))
    session = new MemoryConversationSessions({
      primary: session,
      options,
      create: (options) => provider.createAgentSession(options),
      store: ports.conversationStore?.(input.agentId),
    });
  return session;
}
