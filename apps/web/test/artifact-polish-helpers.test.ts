import { describe, expect, test } from "bun:test";

import { artifactInputs } from "#src/features/artifacts/artifact-inputs";
import { stripLeadingTitleHeading } from "#src/features/artifacts/artifact-preview";
import {
  ARTIFACT_TITLE_MAX,
  withinArtifactTitleLimit,
} from "#src/features/artifacts/artifact-title-limit";

describe("stripLeadingTitleHeading", () => {
  test("strips a leading H1 matching the card title", () => {
    expect(
      stripLeadingTitleHeading(
        "# Q3 Launch Plan\n\nSummary of launch milestones.",
        "Q3 Launch Plan",
      ),
    ).toBe("Summary of launch milestones.");
  });

  test("matches case-insensitively and ignores inline emphasis", () => {
    expect(stripLeadingTitleHeading("# **Q3 `Launch` Plan** #\nBody text", "q3 launch plan")).toBe(
      "Body text",
    );
  });

  test("keeps a leading H1 when it differs from the card title", () => {
    const markdown = "# Overview\n\nBody text";
    expect(stripLeadingTitleHeading(markdown, "Q3 Launch Plan")).toBe(markdown);
  });

  test("falls back to original markdown when stripping leaves nothing", () => {
    const markdown = "# Q3 Launch Plan\n";
    expect(stripLeadingTitleHeading(markdown, "Q3 Launch Plan")).toBe(markdown);
  });
});

describe("artifact title Unicode code point limit", () => {
  test("accepts 300 4-byte emoji code points and rejects 301", () => {
    const maxEmoji = "🚀".repeat(ARTIFACT_TITLE_MAX);
    const overEmoji = "🚀".repeat(ARTIFACT_TITLE_MAX + 1);
    expect(maxEmoji.length).toBe(ARTIFACT_TITLE_MAX * 2);
    expect(withinArtifactTitleLimit(maxEmoji)).toBe(true);
    expect(withinArtifactTitleLimit(overEmoji)).toBe(false);
    expect(artifactInputs.title.safeParse(maxEmoji).success).toBe(true);
    expect(artifactInputs.title.safeParse(overEmoji).success).toBe(false);
  });

  test("rejects empty or whitespace-only titles", () => {
    expect(artifactInputs.title.safeParse("   ").success).toBe(false);
  });
});
