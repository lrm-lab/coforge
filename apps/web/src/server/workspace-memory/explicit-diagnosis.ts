import { OPENVIKING_AGENT_PROTOCOL, type OpenVikingDiagnoseResponse } from "@lrm/coforge-sdk/agent";
import type { OpenVikingAdmittedSessionMessage } from "#src/server/openviking/typed-session-extract.server";

export type DiagnosisScope = {
  requestId: string;
  conversationId: string;
  targetAgentId: string;
  question: string;
  messages: readonly OpenVikingAdmittedSessionMessage[];
};

export type DiagnosisResult = {
  status: "running" | "completed" | "failed";
  reason?: string;
  report?: Record<string, unknown>;
  report_uri?: string;
  content_hash?: string;
};

export function createExplicitMemoryDiagnosis(deps: {
  resolve(input: {
    workspaceId: string;
    agentId: string;
    messageId: string;
  }): Promise<DiagnosisScope>;
  run(workspaceId: string, scope: DiagnosisScope): Promise<DiagnosisResult>;
  notifyFailure?(input: {
    workspaceId: string;
    agentId: string;
    scope: DiagnosisScope;
    reason: string;
  }): Promise<string>;
  publish(input: {
    workspaceId: string;
    agentId: string;
    scope: DiagnosisScope;
    result: DiagnosisResult;
    body: string;
  }): Promise<{ duplicate: boolean; messageId: string }>;
}) {
  return async (input: {
    workspaceId: string;
    agentId: string;
    messageId: string;
    operationId: string;
  }): Promise<OpenVikingDiagnoseResponse> => {
    const scope = await deps.resolve(input);
    const result = await deps.run(input.workspaceId, scope);
    const response: OpenVikingDiagnoseResponse = {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "diagnose",
      operationId: input.operationId,
      duplicate: false,
      status: result.status,
      published: false,
      ...(result.reason ? { reason: result.reason } : {}),
    };
    if (result.status === "failed" && deps.notifyFailure) {
      const messageId = await deps.notifyFailure({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        scope,
        reason: result.reason ?? "diagnosis_failed",
      });
      return { ...response, messageId };
    }
    if (result.status !== "completed") return response;
    if (!result.report || !result.report_uri || !result.content_hash)
      throw new Error("diagnosis_report_missing");
    const report = result.report.report;
    if (
      !report ||
      typeof report !== "object" ||
      !("reason" in report) ||
      typeof report.reason !== "string"
    )
      throw new Error("diagnosis_report_invalid");
    const body = `四角色诊断完成（Builder → Critic/Refiner → Reader）。\n${report.reason}\n\n证据范围：截至求助消息的有界群聊快照；未包含 task 的完整私有工具轨迹。未提供已验证的任务成败，不自动执行修复。\n报告：${result.report_uri}`;
    const published = await deps.publish({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      scope,
      result,
      body,
    });
    return {
      ...response,
      published: true,
      duplicate: published.duplicate,
      messageId: published.messageId,
    };
  };
}
