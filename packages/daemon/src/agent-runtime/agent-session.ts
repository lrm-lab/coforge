import { diagnosticErrorCode, refusalText } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import type { AgentSessionSnapshot, SessionIdentity } from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeRecord, AgentRuntimeState } from "./agent-runtime-state";

const logger = getLogger(["coforge", "daemon", "agent-control"]);

export function isPermanentSessionReportRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; category?: unknown };
  const code = typeof value.code === "number" ? value.code : Number(value.code);
  return (
    (code === 409 && value.category === "superseded") ||
    (code === 403 &&
      (value.category === "session_mismatch" || value.category === "scope_unauthorized"))
  );
}

/** Owns native Session bindings and reliable current-snapshot reporting. */
export class AgentSessions {
  constructor(
    private readonly state: AgentRuntimeState,
    private readonly send: (snapshot: AgentSessionSnapshot) => Promise<void>,
  ) {}

  // Draft operations participate in the caller's existing state.run transaction.
  // They never perform a separate write that could race a control transition.
  beginLaunch(record: AgentRuntimeRecord) {
    delete record.report;
  }

  capture(record: AgentRuntimeRecord, identity: SessionIdentity | undefined) {
    record.identity = identity;
    if (identity && record.launchId && ["running", "stopped"].includes(record.phase))
      record.report = {
        ...record.scope,
        launchId: record.launchId,
        sequence: ++record.sequence,
        identity,
        daemonInstanceId: record.daemonInstanceId,
      };
  }

  clear(record: AgentRuntimeRecord) {
    delete record.identity;
    delete record.report;
  }

  update(agentId: string, launchId: string, identity: SessionIdentity) {
    return this.state.run(agentId, async () => {
      const record = await this.state.store.read(agentId);
      if (!record || record.launchId !== launchId || record.phase !== "running") return;
      this.capture(record, identity);
      await this.state.store.write(agentId, record);
      if (record.report) await this.#sendOrClearReport(record, record.report);
    });
  }

  async replay(agentId?: string) {
    const ids = agentId ? [agentId] : await this.state.store.listAgentIds();
    await Promise.all(
      ids.map((id) =>
        this.state.run(id, async () => {
          const record = await this.state.store.read(id);
          if (record?.report) await this.#sendOrClearReport(record, record.report);
        }),
      ),
    );
  }

  async #sendOrClearReport(
    record: AgentRuntimeRecord,
    report: AgentSessionSnapshot,
  ): Promise<void> {
    try {
      await this.send(report);
    } catch (error) {
      if (!isPermanentSessionReportRejection(error)) return;
      if (record.report === report) {
        delete record.report;
        await this.state.store.write(report.agentId, record);
      }
      logger.warning("Dropped a permanently rejected Agent session snapshot", {
        event: "agent_session:snapshot_dropped",
        agent_id: report.agentId,
        epoch: report.epoch,
        sequence: report.sequence,
        reason: refusalText(error).slice(0, 200),
        error_code: diagnosticErrorCode(error),
        outcome: "dropped",
      });
    }
  }
}
