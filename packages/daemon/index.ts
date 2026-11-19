export * from "./src/daemon-public-api";
export { daemonAgentProxyRuntime } from "./src/agent-proxy-daemon-runtime";
export { createWorkbenchCodex } from "./src/pi-chat/workbench-codex";
export {
  listMachineRunningProcJobs,
  removeWorkspaceProcJobLedger,
  stopMachineRunningProcJobs,
  type RunningProcJobSummary,
  type StopMachineProcJobsResult,
} from "./src/proc-jobs/proc-job-ledger";
export {
  readRuntimeCliDowngrades,
  recordRuntimeCliObservations,
  runtimeCliVersionsPath,
  type RuntimeCliDowngrade,
  type RuntimeCliVersionObservation,
} from "./src/code-agent/runtime-version-tracker";
export type { WorkspaceCrashHistory } from "./src/supervisor/workspace-health-journal";
export { processStartedAt } from "./src/daemon-host/detached";
import { runDaemon } from "./src/daemon-public-api";

// Standalone source/development harness; releases enter through Computer.
if (import.meta.main) await runDaemon(Bun.argv.slice(2));
