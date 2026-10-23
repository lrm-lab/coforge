import { createHash } from "node:crypto";

function imageIds(value: string): string[] {
  const ids = [
    ...new Set(
      value
        .trim()
        .split(/[,\s]+/)
        .filter(Boolean),
    ),
  ].sort();
  if (!ids.length || ids.some((id) => !/^sha256:[a-f0-9]{64}$/.test(id)))
    throw new Error("Retained image configuration is missing or invalid");
  return ids;
}

export function attestRetainedRuntime(input: {
  expected: string;
  actual: string;
  sourceCommit: string;
}) {
  const expected = imageIds(input.expected);
  const actual = imageIds(input.actual);
  if (!/^[a-f0-9]{40}$/.test(input.sourceCommit))
    throw new Error("Source commit is missing or invalid");
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    throw new Error("Running Web retained image configuration differs from the deployment");
  return {
    sourceCommit: input.sourceCommit,
    retainedConfigured: actual.length,
    retainedImagesSha256: createHash("sha256").update(actual.join("\n")).digest("hex"),
  };
}

if (import.meta.main) {
  const actual: unknown = await Bun.file(process.argv[2] ?? "").json();
  if (typeof actual !== "string") throw new Error("Running Web configuration is invalid");
  console.log(
    JSON.stringify(
      attestRetainedRuntime({
        actual,
        expected: process.env.EXPECTED_RETAINED_CLOUD_IMAGE_IDS ?? "",
        sourceCommit: process.env.GITHUB_SHA ?? "",
      }),
    ),
  );
}
