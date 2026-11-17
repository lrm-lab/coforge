export const UI_EVIDENCE_FIX =
  "Add a `UI-Evidence:` section to the commit message listing screenshot attachment/link, `light`, `dark` and `phone (390px)` checks, and `break-ui: <what ran and what was found>` (or `UI-Evidence: exempt — <reason>` when screenshots cannot be captured). Pure `refactor` and `test` commits are exempt; see .agents/skills/ui-delivery/SKILL.md.";

const UI_COMMIT_TITLE = /^(?:feat|fix)(?:\([^()\s][^()]*\))?!?: \S/;
const UI_EVIDENCE_HEADER = /^UI-Evidence:[ \t]*(.*)$/;
const TRAILER_BOUNDARY =
  /^(?:Revert-effect|Reviewed-in|Granularity-exempt|Co-authored-by|Signed-off-by|Fixes|Closes|Refs):[ \t]/i;

const EXEMPT_HEADER = /^exempt(?:[ \t]*(?:—|--|-|:|：)[ \t]*|[ \t]+)?(.*)$/i;
const SCREENSHOT_EVIDENCE =
  /\b(?:https?:\/\/\S+|[^\s,()]+\.(?:png|jpe?g|webp|gif|avif)|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|attachment[:\s#]+[A-Za-z0-9_-]{4,})\b/i;
const LIGHT_EVIDENCE = /\blight\b|浅色/i;
const DARK_EVIDENCE = /\bdark\b|深色/i;
const PHONE_EVIDENCE = /\b(?:phone|mobile|390\s*px|390x\d+)\b|手机/i;
const BREAK_UI_LINE = /\bbreak-ui\b[ \t]*[:：—-]?[ \t]*(\S.*)$/im;
const PLACEHOLDERS = new Set(["none", "n/a", "na", "todo", "tbd", "skip", "skipped", "no", "-"]);

const SERVER_OR_GENERATED_PREFIXES = [
  "apps/web/src/server/",
  "apps/web/src/generated/",
  "apps/web/src/paraglide/",
  "apps/web/src/routes/api/",
];

const PLUMBING_ENTRIES = new Set(["apps/web/src/client.tsx", "apps/web/src/router.tsx"]);

export function isUiFilePath(path: string): boolean {
  if (!path.startsWith("apps/web/src/")) return false;
  if (PLUMBING_ENTRIES.has(path)) return false;
  if (SERVER_OR_GENERATED_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  if (path.startsWith("apps/web/src/routes/api.")) return false;
  if (/\/(?:test|tests|__tests__)\//.test(path)) return false;
  if (/\.(?:server|functions|gen|test|spec|e2e|integration)\.[^/]+$/.test(path)) return false;
  if (path.endsWith(".d.ts")) return false;
  return /\.(?:tsx|css)$/.test(path);
}

export function requiresUiEvidenceTitle(message: string): boolean {
  const title = message.split("\n").find((line) => !line.startsWith("#"));
  return title !== undefined && UI_COMMIT_TITLE.test(title);
}

function extractUiEvidenceBlock(message: string): string | undefined {
  const lines = message.split("\n").filter((line) => !line.startsWith("#"));
  const startIndex = lines.findIndex((line) => UI_EVIDENCE_HEADER.test(line));
  if (startIndex < 0) return undefined;
  const firstRemainder = UI_EVIDENCE_HEADER.exec(lines[startIndex]!)?.[1] ?? "";
  const collected = firstRemainder ? [firstRemainder] : [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (TRAILER_BOUNDARY.test(line)) break;
    collected.push(line);
  }
  return collected.join("\n");
}

function normalizeReason(raw: string): string {
  return raw
    .trim()
    .replace(/[.。!！;；,，]+$/g, "")
    .toLowerCase();
}

export function uiEvidenceExemptReason(message: string): string | undefined {
  const block = extractUiEvidenceBlock(message);
  if (block === undefined) return undefined;
  const firstLine = block
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;
  const match = EXEMPT_HEADER.exec(firstLine);
  if (!match) return undefined;
  const raw = match[1]?.trim() ?? "";
  const normalized = normalizeReason(raw);
  if (normalized.length < 3 || PLACEHOLDERS.has(normalized)) return undefined;
  return raw;
}

function isMalformedExempt(block: string): boolean {
  const firstLine = block
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine !== undefined && EXEMPT_HEADER.test(firstLine);
}

function hasValidBreakUiConclusion(block: string): boolean {
  const match = BREAK_UI_LINE.exec(block);
  if (!match) return false;
  const normalized = normalizeReason(match[1]!);
  return normalized.length >= 3 && !PLACEHOLDERS.has(normalized);
}

export function uiEvidenceIssues(message: string): string[] {
  const block = extractUiEvidenceBlock(message);
  if (block === undefined) return ["no UI-Evidence section"];
  if (uiEvidenceExemptReason(message) !== undefined) return [];
  if (isMalformedExempt(block))
    return ["exempt requires a non-empty reason (UI-Evidence: exempt — <reason>)"];
  const issues: string[] = [];
  if (!SCREENSHOT_EVIDENCE.test(block)) issues.push("missing screenshot attachment or link");
  if (!LIGHT_EVIDENCE.test(block)) issues.push("missing light theme check");
  if (!DARK_EVIDENCE.test(block)) issues.push("missing dark theme check");
  if (!PHONE_EVIDENCE.test(block)) issues.push("missing phone (390px) check");
  if (!hasValidBreakUiConclusion(block)) issues.push("missing break-ui conclusion");
  return issues;
}

function gitText(args: string[], cwd?: string): string {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe", cwd });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

function nonDeletedUiPaths(nameStatusZ: string): string[] {
  const fields = nameStatusZ.split("\0");
  const paths: string[] = [];
  for (let i = 0; i + 1 < fields.length;) {
    const status = fields[i++]!;
    const path = /^[RC]/.test(status) ? (i++, fields[i++]!) : fields[i++]!;
    if (!status.startsWith("D") && isUiFilePath(path)) paths.push(path);
  }
  return [...new Set(paths)];
}

function formatMissingEvidence(uiPaths: string[], issues: string[]): string {
  const shown = uiPaths.slice(0, 3).join(", ");
  const suffix = uiPaths.length > 3 ? ` (+${uiPaths.length - 3} more)` : "";
  if (issues[0] === "no UI-Evidence section")
    return `touches UI files (${shown}${suffix}) without a UI-Evidence section`;
  return `UI-Evidence is incomplete (${issues.join(", ")})`;
}

export type UiEvidenceViolation = {
  rule: "ui-evidence";
  location: string;
  found: string;
};

export type UiEvidenceExemption = {
  sha: string;
  reason: string;
};

export function rangeUiEvidence(
  base: string,
  head: string,
  sinceRevs: readonly string[] = [],
  cwd?: string,
): { violations: UiEvidenceViolation[]; exemptions: UiEvidenceExemption[] } {
  const excluded = [...new Set([base, ...sinceRevs])].map((rev) => `^${rev}`);
  const shas = gitText(
    [
      "rev-list",
      "--reverse",
      "--no-merges",
      "--extended-regexp",
      "--grep=^(feat|fix)(\\([^()]+\\))?!?: ",
      head,
      ...excluded,
    ],
    cwd,
  )
    .split("\n")
    .map((sha) => sha.trim())
    .filter(Boolean);
  const violations: UiEvidenceViolation[] = [];
  const exemptions: UiEvidenceExemption[] = [];
  for (const sha of shas) {
    const message = gitText(["show", "-s", "--format=%B", sha], cwd);
    if (!requiresUiEvidenceTitle(message)) continue;
    const exempt = uiEvidenceExemptReason(message);
    if (exempt !== undefined) {
      const uiPaths = nonDeletedUiPaths(
        gitText(["show", "--format=", "--name-status", "-z", "-M", "-l0", sha], cwd),
      );
      if (uiPaths.length > 0) exemptions.push({ sha: sha.slice(0, 9), reason: exempt });
      continue;
    }
    const issues = uiEvidenceIssues(message);
    if (issues.length === 0) continue;
    const uiPaths = nonDeletedUiPaths(
      gitText(["show", "--format=", "--name-status", "-z", "-M", "-l0", sha], cwd),
    );
    if (uiPaths.length === 0) continue;
    violations.push({
      rule: "ui-evidence",
      location: sha.slice(0, 9),
      found: formatMissingEvidence(uiPaths, issues),
    });
  }
  return { violations, exemptions };
}

export async function uiEvidenceFor(
  base: string,
  head: string,
  sinceRevs: readonly string[] = [],
): Promise<UiEvidenceViolation[]> {
  const result = rangeUiEvidence(base, head, sinceRevs);
  if (result.exemptions.length > 0) {
    const lines = result.exemptions.map((entry) => `- \`${entry.sha}\`: ${entry.reason}`);
    const text = `UI-Evidence exemptions used:\n${lines.join("\n")}`;
    console.log(`::warning::${text}`);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) {
      const file = Bun.file(summary);
      const existing = (await file.exists()) ? await file.text() : "";
      await Bun.write(summary, `${existing}${text}\n\n`).catch(() => {});
    }
  }
  return result.violations;
}

export function stagedUiEvidenceError(message: string, cwd?: string): string | undefined {
  if (!requiresUiEvidenceTitle(message)) return undefined;
  const exempt = uiEvidenceExemptReason(message);
  if (exempt !== undefined) {
    const uiPaths = nonDeletedUiPaths(
      gitText(["diff", "--cached", "--name-status", "-z", "-M", "-l0"], cwd),
    );
    if (uiPaths.length > 0) console.error(`UI-Evidence exempt: ${exempt}`);
    return undefined;
  }
  const issues = uiEvidenceIssues(message);
  if (issues.length === 0) return undefined;
  const uiPaths = nonDeletedUiPaths(
    gitText(["diff", "--cached", "--name-status", "-z", "-M", "-l0"], cwd),
  );
  if (uiPaths.length === 0) return undefined;
  return `commit-msg: ${formatMissingEvidence(uiPaths, issues)}.\n${UI_EVIDENCE_FIX}`;
}
