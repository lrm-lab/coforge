export { FileBindingStore } from "#src/supervisor/binding-store";
export {
  WORKSPACE_HEALTH_CRASH_WINDOW_MS,
  WORKSPACE_HEALTH_DEGRADED_THRESHOLD,
  WorkspaceHealthJournal,
  workspaceDegradedMessage,
  workspaceHealthJournalPath,
  workspaceHealthRecoveryCommand,
  workspaceParkedDescription,
  workspaceParkedMessage,
  workspaceParkedRecovery,
} from "#src/supervisor/workspace-health-journal";
export type { WorkspaceHealthState } from "#src/supervisor/workspace-health-journal";
export { runMachineSupervisor } from "#src/supervisor/run-supervisor";
export type { LifecycleFailure } from "#src/supervisor/machine-supervisor";
export {
  workspaceSocketPath,
  type WorkspaceCloudConnectionReport,
} from "#src/supervisor/workspace-start-outcome";
export {
  holdRunnersUntilQuiescent,
  RUNNER_HOLD_MS,
  RUNNER_HOLD_POLL_MS,
} from "#src/supervisor/runner-hold";
export type {
  RunnerHoldOptions,
  RunnerHoldOutcome,
  RunnerHoldSnapshot,
} from "#src/supervisor/runner-hold";
export { runLaunchdAgent } from "#src/platform/launchd-agent-runner";
export { runContextViewRestoreChildMain } from "#src/agent-context-view/context-view-restore-runner";

export type { AgentRuntimeConfig, AgentSession, AgentSessionOptions } from "@coforge/agent";
export type {
  AgentRuntimeEvent,
  CodeAgentProvider,
  CodeAgentProviderFactory,
} from "@lrm/coforge-anvil";
export { createCodeAgentProvider } from "#src/code-agent/registry";
export { CoforgeProvider } from "#src/code-agent/pi/provider";
export { startDaemonLocalRpcServer } from "#src/local-rpc";
export { startAgentProxy } from "#src/agent-proxy";
export {
  COORDINATOR_SERVICE,
  coordinatorServiceName,
  createDaemonHost,
  LaunchdDaemonHost,
  launchdPlist,
  SystemdUserDaemonHost,
  systemdUserUnit,
  WindowsUserDaemonHost,
  windowsDaemonTaskXml,
  windowsTaskUserId,
} from "#src/daemon-host/index";
export { DetachedDaemonHost, detachedPid, systemdPresent } from "#src/daemon-host/detached";
export {
  clearSupervisorRecord,
  detectSystemdSupervisor,
  externalSupervisorOptIn,
  readSupervisorRecord,
  writeSupervisorRecord,
} from "#src/daemon-host/external-supervisor";
export type { CoordinatorServiceRegistrar } from "#src/daemon-host/launcher";
export {
  DAEMON_SERVICE_MANAGERS,
  DaemonCommandRejectedError,
  LocalDaemonLauncher,
  resolveDaemonExecutablePath,
} from "#src/daemon-host/launcher";
export * from "#src/platform/upgrade-public";
export * from "#src/platform/workspace-process-public";
export { resolveComputerInstallDirectory } from "#src/platform/computer-install-directory";
export {
  acquireProcessLock,
  isLockContention,
  PROCESS_LOCK_CONTENTION_CODES,
  PROCESS_LOCK_STATEMENTS,
} from "#src/platform/process-lock";
export { detectOperatingSystem, OperatingSystemInfo } from "#src/platform/operating-system";
export { writeLoginShellPathProbe } from "#src/platform/login-shell-path";
export {
  readLoginShellPath,
  type LoginShellPathRecord,
} from "#src/platform/login-shell-path-state";
export type { ProcessLock } from "#src/platform/process-lock";
export type {
  DaemonLauncher,
  DaemonServiceDefinition,
  DaemonServiceManager,
  DaemonStarted,
  DaemonCommandRunner,
  DaemonWorkspaceConfig,
} from "#src/daemon-host/launcher";
export { DaemonConfigStore } from "#src/persistence/daemon-config";
export { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
export { agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";
export { AgentStateMachine } from "#src/agent-runtime/agent-state-machine";
export { createAgentActivity } from "@lrm/coforge-anvil";
export type { AgentRuntime, AgentStatus } from "#src/agent-runtime/agent-process-manager";
export type { AgentActivity, AgentActivityLevel } from "@lrm/coforge-anvil";
export type {
  AgentStateEvent,
  AgentStateTransition,
  AgentStatus as AgentStateStatus,
} from "#src/agent-runtime/agent-state-machine";
export { DaemonRuntime, type DaemonConfig } from "#src/daemon-runtime/runtime";
export {
  SystemdWorkspaceInstance,
  workspaceUnit,
} from "#src/supervisor/systemd-workspace-instance";
export { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
export {
  AgentAppInbox,
  type AgentAppItem,
  type MintAppItem,
} from "#src/agent-app-inbox/agent-app-inbox";
export {
  InMemoryDaemonCredentialStore,
  FileDaemonCredentialStore,
  isComputerApiKey,
  isLegacyDaemonApiKey,
  type DaemonCredentialStore,
} from "#src/credentials/credential-store";
export type { AgentMessageHttpClient } from "#src/connection/agent-http-clients";
export { createComputerSelfClient } from "#src/connection/computer-self-client";
export { DaemonConnection } from "#src/connection/daemon-connection";
export type {
  DaemonConnectionClient,
  DaemonConnectionConfig,
  DaemonConnectionClientFactory,
} from "#src/connection/daemon-connection-client";
export { defaultCentrifugeWorkspaceClientFactory } from "#src/connection/centrifuge-workspace-client";
export { COFORGE_DAEMON_SERVER_URL, daemonConnectionEndpoint } from "#src/connection/built-server";
export { runDaemon } from "./daemon-cli";
