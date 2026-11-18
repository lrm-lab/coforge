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
import { runDaemon } from "./src/daemon-public-api";

// Standalone source/development harness; releases enter through Computer.
if (import.meta.main) await runDaemon(Bun.argv.slice(2));
