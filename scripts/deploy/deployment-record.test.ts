import { describe, expect, test } from "bun:test";

import { InvalidImageError, type DeploymentRecord, renderAuditRecord } from "./deployment";
import { registryImage } from "./deploy-test-support";

describe("renderAuditRecord", () => {
  const startedAt = "2026-08-31T02:00:00.000Z";
  const completedAt = "2026-08-31T02:05:00.000Z";
  const baseRecord: DeploymentRecord = {
    deployment_id: "d4d5e6f7-0000-4000-8000-000000000001",
    source_commit: "493a0c5",
    track: "cloud",
    artifact_identity: registryImage,
    environment: "staging",
    workflow_run: "https://github.com/lrm-lab/coforge/actions/runs/33350525525",
    previous_digest: null,
    rollback_target: null,
    health_result: "healthy",
    approval: null,
    executor: "agent",
    started_at: startedAt,
    completed_at: completedAt,
    outcome: "healthy",
  };

  test("renders exactly one JSON line", () => {
    const line = renderAuditRecord(baseRecord);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(line)).toEqual(baseRecord);
  });

  test("renders a fixed key order", () => {
    const keys = Object.keys(JSON.parse(renderAuditRecord(baseRecord)));
    expect(keys).toEqual([
      "deployment_id",
      "source_commit",
      "track",
      "artifact_identity",
      "environment",
      "workflow_run",
      "previous_digest",
      "rollback_target",
      "health_result",
      "approval",
      "executor",
      "started_at",
      "completed_at",
      "outcome",
    ]);
  });

  test("refuses a record that carries an approval", () => {
    expect(() => renderAuditRecord({ ...baseRecord, approval: "frank" })).toThrow();
  });

  test("refuses an unknown outcome", () => {
    expect(() => renderAuditRecord({ ...baseRecord, outcome: "unknown" as never })).toThrow();
  });

  test("refuses a mutable artifact identity", () => {
    expect(() =>
      renderAuditRecord({ ...baseRecord, artifact_identity: "coforge/web:main" }),
    ).toThrow(InvalidImageError);
  });
});
