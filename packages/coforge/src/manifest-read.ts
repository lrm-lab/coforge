import {
  checkBaseUrlOrigin,
  type AgentAppView,
  type AgentManifestProblem,
} from "@lrm/coforge-sdk/agent";
import { normalizeAgentLaunchText } from "@lrm/coforge-sdk/internal/agent-launch-apps";
import { CliError } from "./cli-error";
import {
  fetchAgentManifest,
  type FetchAgentManifestOptions,
  type ManifestOutcome,
} from "./manifest-fetch";

export type ManifestErrorCode =
  | "APP_NOT_FOUND"
  | "MANIFEST_NOT_CONFIGURED"
  | "MANIFEST_MISSING"
  | "MANIFEST_UNAVAILABLE"
  | "MANIFEST_UNREACHABLE"
  | "MANIFEST_INVALID"
  | "ACTION_NOT_FOUND"
  | "NO_HTTP_ACTIONS";

export type ManifestError = {
  code: ManifestErrorCode;
  message: string;
  problems?: AgentManifestProblem[];
  retryable: boolean;
  next_action: string;
};

export type AppActionsIo = {
  stdout(chunk: string): void;
  /** Reads a manifest; tests inject one. */
  fetchManifest?: (options: FetchAgentManifestOptions) => Promise<ManifestOutcome>;
};

export const SEE_APPS = "Run coforge app list to see the apps you can use.";
const TEXT_MAX = 500;

/** Manifest text is the publisher's: one line, no control or format characters, bounded. */
export const clean = (text: unknown, max = TEXT_MAX) => normalizeAgentLaunchText(String(text), max);

/** What each failed read of the manifest is told to the Agent as; the message is built from the
 * outcome in `failureMessage`. */
export const FAILURES = {
  not_configured: {
    code: "MANIFEST_NOT_CONFIGURED",
    retryable: false,
    next_action: "Read the app's own documentation, or ask the Workspace admin who installed it.",
  },
  missing: {
    code: "MANIFEST_MISSING",
    retryable: false,
    next_action: "Read the app's own documentation; it has no listed actions.",
  },
  unavailable: { code: "MANIFEST_UNAVAILABLE", retryable: true, next_action: "Try again later." },
  unreachable: {
    code: "MANIFEST_UNREACHABLE",
    retryable: true,
    next_action: "Try again; if it keeps failing, tell the Workspace admin.",
  },
  invalid: {
    code: "MANIFEST_INVALID",
    retryable: false,
    next_action: "Do not use the manifest. Tell the app's publisher or the Workspace admin.",
  },
} as const satisfies Record<string, Omit<ManifestError, "message" | "problems">>;

export type FailedOutcome = Exclude<ManifestOutcome, { kind: "valid" | "absent" }>;

export function failureMessage(outcome: FailedOutcome, app: AgentAppView): string {
  switch (outcome.kind) {
    case "not_configured":
      return `The app ${app.key} names no Agent manifest URL and has no homepage to derive one from.`;
    case "missing":
      return `The app ${app.key} publishes no Agent manifest (HTTP ${outcome.status}).`;
    case "unavailable":
      return `The app's manifest server answered HTTP ${outcome.status}${outcome.retryAfter ? ` and asked to retry after ${clean(outcome.retryAfter, 40)}` : ""}.`;
    case "unreachable":
      return `The app's manifest could not be read: ${clean(outcome.message, 200)}.`;
    case "invalid":
      return `The app's Agent manifest is invalid (${outcome.problems.length} problem${outcome.problems.length === 1 ? "" : "s"}).`;
  }
}

/** Problems as indented `path: message` lines, each cleaned and bounded. */
export const problemLines = (problems: readonly AgentManifestProblem[]) =>
  problems.map((p) => `  ${clean(p.path || "/", 200)}: ${clean(p.message, 300)}`).join("\n");

/** The CLI's own typed error (`cli-error.ts`), so `--json` failures share every other command's
 * envelope and exit path. */
export function manifestError(invocation: { json?: true }, error: ManifestError): CliError {
  const problems = error.problems ? problemLines(error.problems) : "";
  return new CliError({
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    suggestedNextAction: error.next_action,
    ...(problems
      ? { contextText: `Problems:\n${problems}`, details: { problems: error.problems } }
      : {}),
    outputMode: invocation.json ? "json" : "text",
  });
}

/** The error for a manifest that could not be used. `absent` is a 404/410 at the derived URL, which
 * is fine to list but a dead end for a call, so here it reads as `missing`. */
export function outcomeError(
  outcome: Exclude<ManifestOutcome, { kind: "valid" }>,
  app: AgentAppView,
  invocation: { json?: true },
): CliError {
  const failed: FailedOutcome =
    outcome.kind === "absent" ? { kind: "missing", status: outcome.status } : outcome;
  return manifestError(invocation, {
    ...FAILURES[failed.kind],
    message: failureMessage(failed, app),
    ...(failed.kind === "invalid" ? { problems: failed.problems } : {}),
  });
}

/** Reads the app's manifest once; a homepage-derived URL that answers 404/410 is `absent`. */
export async function readOutcome(app: AgentAppView, io: AppActionsIo): Promise<ManifestOutcome> {
  const url = app.agentManifestUrl;
  if (!url) return { kind: "not_configured" };
  const outcome = await (io.fetchManifest ?? fetchAgentManifest)({
    url,
    derived: app.agentManifestUrlSource === "well_known",
  });
  if (outcome.kind !== "valid") return outcome;
  const problem = checkBaseUrlOrigin(outcome.manifest, {
    homepageUrl: app.homepageUrl,
    manifestUrl: url,
  });
  return problem ? { kind: "invalid", problems: [problem] } : outcome;
}
