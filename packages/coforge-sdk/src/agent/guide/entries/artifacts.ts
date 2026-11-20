import type { FeatureGuideEntry } from "../types";

const ARTIFACTS_GUIDE_BASE = `## Artifacts
Send finished one-off files as attachments (\`coforge attachment upload\`). For work people will review, comment on, or revise — especially Markdown docs or interactive HTML pages — push a directory with \`coforge artifact push <dir> --target '<target>' --title '<t>'\`, then post the printed \`Open:\` link; later edits push only changed files as a new version (\`coforge artifact pull|push\`). To render a compact interactive HTML page directly inline in chat, append \`?embed=1\` to its link on its own line (transparent background, \`--coforge-*\` theme tokens, auto-height 96–800px).`;

const ARTIFACT_CHECK_SENTENCE =
  " After pushing an HTML artifact, run `coforge artifact check <id> --wait` to inspect console/CSP errors, layout overflow, and desktop/phone/inline screenshots before sharing.";

const ARTIFACTS_GUIDE_TAIL = " Details: `coforge manual get artifacts` and `artifact-pages`.";

export const ARTIFACTS_GUIDE_SECTION = `${ARTIFACTS_GUIDE_BASE}${ARTIFACT_CHECK_SENTENCE}${ARTIFACTS_GUIDE_TAIL}`;

export const ARTIFACTS_GUIDE_ENTRY: FeatureGuideEntry = {
  id: "artifacts",
  manualTopics: ["artifacts", "artifact-pages"],
  isEnabled: ({ features }) => features?.artifacts !== false,
  render: ({ features }) =>
    features?.artifactChecks === false
      ? `${ARTIFACTS_GUIDE_BASE}${ARTIFACTS_GUIDE_TAIL}`
      : ARTIFACTS_GUIDE_SECTION,
};
