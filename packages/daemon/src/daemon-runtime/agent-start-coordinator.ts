import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import type { AgentRuntime } from "#src/agent-runtime/agent-process-manager";
import type { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import type { AgentInputDrain } from "./agent-input-drain";
import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import type { AgentLaunchCoordinator } from "./agent-launch-coordinator";
import type { AgentExitedDelivery } from "./agent-exited-delivery";
import type { LaunchFailureBackoff } from "#src/agent-runtime/launch-failure-backoff";
import type { AgentMigrationRunner } from "#src/agent-migration/migration-runner";
import type { AgentRecoveryContext } from "./runtime-launch-intent";
import type { LaunchRequest } from "./runtime-launch-types";
import type { RunnerHold } from "./shutdown-reason";
import { recoveryHasContent } from "./runtime-launch-intent";
import { agentStartupInput } from "#src/agent-runtime/agent-startup";
import { AgentPreflightError } from "./agent-preflight-error";

export type AgentStartCoordinatorPorts = {
  assertRunning(): void;
  assertAgentNotStopping(agentId: string): void;
  migrations?: AgentMigrationRunner;
  requestAppConfigSnapshot(agentId: string): void;
  inputDrain: AgentInputDrain;
  introducedAgents: Set<string>;
  agentLaunches: Map<string, Promise<AgentRuntime>>;
  agentProcessManager: AgentProcessManager;
  runnerHold: RunnerHold | undefined;
  messageAttention: AgentMessageAttentionIndex;
  wakeLaunchFailures: LaunchFailureBackoff;
  launchCoordinator: AgentLaunchCoordinator;
  exitedDelivery: AgentExitedDelivery;
  releaseSurvivingHolds(agentId: string): void;
  sessionReferences: Map<string, { sessionId?: string }>;
};

export function startAgent(
  ports: AgentStartCoordinatorPorts,
  agentId: string,
  config: AgentRuntimeConfig,
  recovery: AgentRecoveryContext | undefined,
  request: LaunchRequest,
): Promise<AgentRuntime> {
  try {
    ports.assertRunning();
    ports.assertAgentNotStopping(agentId);
    if (ports.migrations?.holds(agentId))
      throw new AgentPreflightError(
        `Agent workspace is moving to another Computer: ${agentId}`,
        "AGENT_MIGRATING",
      );
  } catch (error) {
    return Promise.reject(error);
  }
  ports.requestAppConfigSnapshot(agentId);
  const enqueueRecovery = (context: AgentRecoveryContext) =>
    ports.inputDrain.enqueue(agentId, (completion) => ({
      kind: "recovery",
      context,
      completion,
    }));
  const enqueueTurn = (text: string, introduction?: true) =>
    ports.inputDrain.enqueue(agentId, (completion) => ({
      kind: "prompt",
      text,
      introduction,
      completion,
    }));
  const { resumePrompt, introductionPrompt } = request;
  const carriesPrompt = introductionPrompt !== undefined || resumePrompt !== undefined;
  const introduction =
    introductionPrompt !== undefined &&
    !ports.introducedAgents.has(agentId) &&
    !ports.inputDrain
      .get(agentId)
      ?.items.some((item) => item.kind === "prompt" && item.introduction)
      ? introductionPrompt
      : undefined;
  // This Start's input in order: its introduction, the recovery handed over, its resume prompt.
  const enqueueStartInput = (context: AgentRecoveryContext | undefined) => {
    const introductionCompletion =
      introduction === undefined ? undefined : enqueueTurn(introduction, true);
    const recoveryCompletion = context ? enqueueRecovery(context) : undefined;
    const promptCompletion = resumePrompt === undefined ? undefined : enqueueTurn(resumePrompt);
    return {
      recoveryCompletion,
      inputs: [introductionCompletion, recoveryCompletion, promptCompletion].filter(
        (input) => input !== undefined,
      ),
    };
  };
  const existingLaunch = ports.agentLaunches.get(agentId);
  if (existingLaunch) {
    if (carriesPrompt || recoveryHasContent(recovery)) {
      const queue = ports.inputDrain.get(agentId);
      if (queue)
        queue.items = queue.items.filter((item) => {
          if (item.kind !== "startup") return true;
          item.completion.resolve();
          return false;
        });
    }
    // A launch in progress presents this start's input too.
    const { inputs } = enqueueStartInput(recovery);
    if (!inputs.length) return existingLaunch;
    const inputCompletion = Promise.all(inputs);
    // Input can be cancelled before provider creation finishes. Keep the creation promise as
    // the launch fence, while observing an early input rejection until creation settles.
    void inputCompletion.catch(() => {});
    const extendedLaunch = existingLaunch
      .then(async (runtime) => {
        await inputCompletion;
        return runtime;
      })
      .finally(() => {
        if (ports.agentLaunches.get(agentId) === extendedLaunch)
          ports.agentLaunches.delete(agentId);
      });
    ports.agentLaunches.set(agentId, extendedLaunch);
    return extendedLaunch;
  }
  const activeRuntime = ports.agentProcessManager.runtime(agentId);
  if (activeRuntime) {
    if (!recovery && !carriesPrompt)
      return Promise.reject(new Error(`Agent runtime is already active: ${agentId}`));
    // A running Agent keeps its process and session: it is handed only this start's
    // introduction, wake message and resume prompt, never its resume messages or unread summary.
    const { inputs } = enqueueStartInput(
      recovery?.wakeMessage ? { wakeMessage: recovery.wakeMessage } : undefined,
    );
    if (!inputs.length) return Promise.resolve(activeRuntime);
    ports.inputDrain.ensure(agentId);
    return Promise.all(inputs).then(() => activeRuntime);
  }

  // A brand-new process started inside the hold window would be killed seconds later by the
  // upgrade's stop. Refusing is safe: `#agentControl.replay()` re-issues the intent after the
  // restart. Launches that only extend a live runtime returned above and are untouched.
  if (ports.runnerHold !== undefined)
    return Promise.reject(new Error(`Agent launches are held for ${ports.runnerHold.reason}`));

  ports.messageAttention.clearAgent(agentId);

  // Register the launch before its first await so concurrent starts cannot mint twice.
  // Launch failure is surfaced by `launch`; the item completion is also rejected when cleared.
  // The Start's input (a resume prompt is a user's guidance when resuming a stopped Agent, sent
  // with no recovery) is queued before the launch, so any message that arrives while the process
  // is still starting queues behind it.
  const { recoveryCompletion, inputs } = enqueueStartInput(recovery);
  for (const input of inputs) void input.catch(() => {});
  // A Start carrying a prompt never gets the starter, even when it queued none of its own.
  const startupCompletion =
    !carriesPrompt && !recoveryHasContent(recovery)
      ? ports.inputDrain.enqueue(agentId, (completion) => ({
          kind: "startup",
          text: agentStartupInput(
            request.sessionMode !== "create" &&
              Boolean(request.sessionId ?? ports.sessionReferences.get(agentId)?.sessionId),
          ),
          completion,
        }))
      : undefined;
  void startupCompletion?.catch(() => {});
  const launching = ports.launchCoordinator.launchAgent(agentId, config, request);
  const launch = launching
    .then(
      async (runtime) => {
        // Any successful launch, a managed Start included, ends a wake cooldown.
        ports.wakeLaunchFailures.reset(agentId);
        ports.inputDrain.ensure(agentId);
        if (recoveryCompletion) await recoveryCompletion;
        // No recovery item was enqueued for this launch at all (so
        // `#recoverAttention` never ran), yet the session is ready — flush anything
        // AgentDeliveryQueue held across an unexpected exit now. Do not open a
        // second recovery notice: the queued startup input opens the initial turn if needed.
        else ports.releaseSurvivingHolds(agentId);
        if (startupCompletion) await startupCompletion;
        return runtime;
      },
      (error: unknown) => {
        ports.exitedDelivery.keepInputDeliveriesForNextLaunch(agentId, error);
        ports.inputDrain.close(agentId, error);
        throw error;
      },
    )
    .finally(() => {
      if (ports.agentLaunches.get(agentId) === launch) ports.agentLaunches.delete(agentId);
    });
  ports.agentLaunches.set(agentId, launch);
  return launch;
}
