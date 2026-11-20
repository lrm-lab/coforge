import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_CHECK_SHOTS,
  ARTIFACT_CHECK_VIEWPORTS,
  artifactOperationTraits,
  decodeAgentArtifactRequest,
  isArtifactCheckShot,
  isArtifactCheckStatus,
} from "../src/agent";

describe("artifact-checks SDK contract", () => {
  test("defines desktop, phone, and inline check viewports", () => {
    expect(ARTIFACT_CHECK_SHOTS).toEqual(["desktop", "phone", "inline"]);
    expect(ARTIFACT_CHECK_VIEWPORTS.map((v) => [v.shot, v.width, v.height])).toEqual([
      ["desktop", 1280, 800],
      ["phone", 390, 844],
      ["inline", 896, 800],
    ]);
    expect(isArtifactCheckShot("desktop")).toBe(true);
    expect(isArtifactCheckShot("inline")).toBe(true);
    expect(isArtifactCheckShot("tablet")).toBe(false);
    expect(isArtifactCheckStatus("pending")).toBe(true);
    expect(isArtifactCheckStatus("done")).toBe(true);
    expect(isArtifactCheckStatus("unknown")).toBe(false);
  });

  test("decodes check and check-shot operations and rejects invalid shots", () => {
    expect(decodeAgentArtifactRequest({ operation: "check", artifact: "a1" })).toEqual({
      operation: "check",
      artifact: "a1",
    });
    expect(decodeAgentArtifactRequest({ operation: "check", artifact: "a1", version: 3 })).toEqual({
      operation: "check",
      artifact: "a1",
      version: 3,
    });
    expect(
      decodeAgentArtifactRequest({
        operation: "check-shot",
        artifact: "a1",
        version: 3,
        shot: "inline",
      }),
    ).toEqual({
      operation: "check-shot",
      artifact: "a1",
      version: 3,
      shot: "inline",
    });
    expect(
      decodeAgentArtifactRequest({
        operation: "check-shot",
        artifact: "a1",
        shot: "bogus",
      }),
    ).toBeNull();
    expect(artifactOperationTraits("check").repeatable).toBe(true);
    expect(artifactOperationTraits("check-shot").repeatable).toBe(true);
  });
});
