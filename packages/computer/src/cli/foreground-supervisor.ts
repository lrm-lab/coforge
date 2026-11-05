import {
  clearSupervisorRecord,
  detectSystemdSupervisor,
  externalSupervisorOptIn,
  writeSupervisorRecord,
} from "@lrm/coforge-daemon";

/**
 * `coforge-computer foreground` under the person's own supervisor (task #538). Declared with
 * `COFORGE_COMPUTER_EXTERNAL_SUPERVISOR=1` and believed only when systemd says this process is
 * that unit's main process; the unit is then recorded so install, attach, upgrade and restart ask
 * it instead of starting a second service. Declared but not verifiable: no record is written (a
 * stale one is removed) and the person is told why, since nothing would then protect them from a
 * second service.
 */
export async function recordExternalSupervisor(
  stateDirectory: string,
  warn: (line: string) => void,
  deps: {
    env?: Record<string, string | undefined>;
    detect?: typeof detectSystemdSupervisor;
  } = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  if (!externalSupervisorOptIn(env)) return;
  const record = await (deps.detect ?? detectSystemdSupervisor)({ env });
  if (!record) {
    await clearSupervisorRecord(stateDirectory);
    warn(
      "COFORGE_COMPUTER_EXTERNAL_SUPERVISOR is set, but this process is not the main process of a systemd service (no INVOCATION_ID, no service cgroup, or the unit's MainPID differs). Not recording a supervisor.",
    );
    return;
  }
  await writeSupervisorRecord(stateDirectory, record);
}
