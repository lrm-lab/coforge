import { createHash } from "node:crypto";

function imageIds(value: string, allowEmpty: boolean): string[] {
  const ids = [
    ...new Set(
      value
        .trim()
        .split(/[,\s]+/)
        .filter(Boolean),
    ),
  ].sort();
  if ((!ids.length && !allowEmpty) || ids.some((id) => !/^sha256:[a-f0-9]{64}$/.test(id)))
    throw new Error("Retained image configuration is missing or invalid");
  return ids;
}

export function attestRetainedRuntime(input: {
  expected: string;
  actual: string;
  sourceCommit: string;
  expectedPaused?: string;
  actualPaused?: string;
}) {
  const setting = (value: string | undefined) => {
    const normalized = value?.trim() || "false";
    if (normalized !== "true" && normalized !== "false")
      throw new Error("Image maintenance configuration is invalid");
    return normalized === "true";
  };
  const updatesPaused = setting(input.expectedPaused);
  if (updatesPaused !== setting(input.actualPaused))
    throw new Error("Running Web maintenance configuration differs from the deployment");
  const expected = imageIds(input.expected, updatesPaused);
  const actual = imageIds(input.actual, updatesPaused);
  if (!/^[a-f0-9]{40}$/.test(input.sourceCommit))
    throw new Error("Source commit is missing or invalid");
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    throw new Error("Running Web retained image configuration differs from the deployment");
  return {
    sourceCommit: input.sourceCommit,
    updatesPaused,
    retainedConfigured: actual.length,
    retainedImagesSha256: createHash("sha256").update(actual.join("\n")).digest("hex"),
  };
}

if (import.meta.main) {
  const actual: unknown = await Bun.file(process.argv[2] ?? "").json();
  if (
    !actual ||
    typeof actual !== "object" ||
    !("retainedIds" in actual) ||
    !("updatesPaused" in actual) ||
    typeof actual.retainedIds !== "string" ||
    typeof actual.updatesPaused !== "string"
  )
    throw new Error("Running Web configuration is invalid");
  console.log(
    JSON.stringify(
      attestRetainedRuntime({
        actual: actual.retainedIds,
        actualPaused: actual.updatesPaused,
        expectedPaused: process.env.EXPECTED_CLOUD_IMAGE_UPDATES_PAUSED,
        expected: process.env.EXPECTED_RETAINED_CLOUD_IMAGE_IDS ?? "",
        sourceCommit: process.env.GITHUB_SHA ?? "",
      }),
    ),
  );
}
