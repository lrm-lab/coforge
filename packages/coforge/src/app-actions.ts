import {
  checkBaseUrlOrigin,
  type AgentAppView,
  type AgentManifest,
  type AgentManifestAction,
  type AgentManifestProblem,
} from "@lrm/coforge-sdk/agent";
import { isRecord } from "@lrm/coforge-sdk/internal";
import { normalizeAgentLaunchText } from "@lrm/coforge-sdk/internal/agent-launch-apps";
import { CliError } from "./cli-error";
import {
  fetchAgentManifest,
  type FetchAgentManifestOptions,
  type ManifestOutcome,
} from "./manifest-fetch";

/** `coforge app invoke <app-key> --list-actions [--action <name>] [--json]`. */
export type AppInvokeInvocation = {
  command: "app-invoke";
  appKey: string;
  action?: string;
  json?: true;
};

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

const SEE_APPS = "Run coforge app list to see the apps you can use.";
const TEXT_MAX = 500;
const SCHEMA_TEXT_MAX = 4000;

/** Manifest text is the publisher's: one line, no control or format characters, bounded. */
const clean = (text: unknown, max = TEXT_MAX) => normalizeAgentLaunchText(String(text), max);

/** What each failed read of the manifest is told to the Agent as; the message is built from the
 * outcome in `failureMessage`. */
const FAILURES = {
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

type FailedOutcome = Exclude<ManifestOutcome, { kind: "valid" | "absent" }>;

function failureMessage(outcome: FailedOutcome, app: AgentAppView): string {
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

/** The CLI's own typed error (`cli-error.ts`), so `--json` failures share every other command's
 * envelope and exit path. */
function manifestError(invocation: AppInvokeInvocation, error: ManifestError): CliError {
  const problems = (error.problems ?? []).map(
    (p) => `  ${clean(p.path || "/", 200)}: ${clean(p.message, 300)}`,
  );
  return new CliError({
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    suggestedNextAction: error.next_action,
    ...(problems.length > 0
      ? { contextText: `Problems:\n${problems.join("\n")}`, details: { problems: error.problems } }
      : {}),
    outputMode: invocation.json ? "json" : "text",
  });
}

type Property = { name: string; type: string; required: boolean };

function inputFields(action: AgentManifestAction): Property[] {
  const properties = isRecord(action.input_schema.properties) ? action.input_schema.properties : {};
  const required = new Set(
    Array.isArray(action.input_schema.required) ? action.input_schema.required : [],
  );
  return Object.entries(properties).map(([name, schema]) => ({
    name,
    type: isRecord(schema) && typeof schema.type === "string" ? schema.type : "any",
    required: required.has(name),
  }));
}

const field = (property: Property) =>
  `${clean(property.name, 80)} (${clean(property.type, 20)}${property.required ? ", required" : ""})`;

/** A schema as one cleaned, bounded line; `--json` has the full, unmodified one. */
function schemaText(schema: unknown): string {
  const text = JSON.stringify(schema);
  const shown = clean(text, SCHEMA_TEXT_MAX);
  // An uncut schema ends with "}", so a closing "…" is the cleaner's mark that it cut.
  return shown.endsWith("…") ? `${shown} (truncated; use --json for the full schema)` : shown;
}

function formatAction(action: AgentManifestAction, full: boolean): string {
  const lines = [
    clean(action.name, 80),
    `  ${action.effect}  ${action.endpoint.method} ${clean(action.endpoint.path, 512)}  [${action.idempotency}]`,
  ];
  if (action.description) lines.push(`  ${clean(action.description)}`);
  lines.push(
    `  Scopes: ${action.required_scopes.map((scope) => clean(scope, 128)).join(", ") || "none"}`,
  );
  const fields = inputFields(action);
  lines.push(`  Input: ${fields.length > 0 ? fields.map(field).join(", ") : "none"}`);
  if (full) {
    if (action.idempotency_header)
      lines.push(`  Idempotency header: ${clean(action.idempotency_header, 64)}`);
    lines.push(`  Input schema: ${schemaText(action.input_schema)}`);
    if (action.output_schema) lines.push(`  Output schema: ${schemaText(action.output_schema)}`);
  }
  return lines.join("\n");
}

function formatManifest(
  app: AgentAppView,
  manifest: AgentManifest,
  only?: AgentManifestAction,
): string {
  if (manifest.execution.mode === "local_cli")
    return `${app.key} runs as a local command, ${clean(manifest.execution.command, 64)}, and declares no actions to call here. Read its documentation${manifest.docs_url ? ` at ${clean(manifest.docs_url, 200)}` : ""}.`;
  if (only) return formatAction(only, true);
  if (manifest.actions.length === 0) return `${app.key} declares no actions.`;
  return [
    `${app.key} — ${manifest.actions.length} action${manifest.actions.length === 1 ? "" : "s"}`,
    ...manifest.actions.map((action) => formatAction(action, false)),
    "Show one in full with: coforge app invoke <app-key> --list-actions --action <name>",
  ].join("\n\n");
}

/** Reads the app's manifest once; a homepage-derived URL that answers 404/410 is `absent`. */
async function readOutcome(app: AgentAppView, io: AppActionsIo): Promise<ManifestOutcome> {
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

/** Reads the app's manifest afresh and prints its actions (or one in full). Resolves to the exit
 * code (0); every failure is thrown as a `CliError`. An app that publishes no manifest at its
 * well-known URL is a normal answer, not a failure. */
export async function runListActions(
  invocation: AppInvokeInvocation,
  apps: readonly AgentAppView[],
  io: AppActionsIo,
): Promise<number> {
  const fail = (error: Omit<ManifestError, "retryable"> & { retryable?: boolean }) =>
    manifestError(invocation, { retryable: false, ...error });
  const app = apps.find((item) => item.key === invocation.appKey);
  if (!app)
    throw fail({
      code: "APP_NOT_FOUND",
      message: `The app ${clean(invocation.appKey, 80)} is not installed in this Workspace.`,
      next_action: SEE_APPS,
    });
  const outcome = await readOutcome(app, io);
  if (outcome.kind === "absent") {
    io.stdout(
      invocation.json
        ? `${JSON.stringify({ ok: true, data: { app: app.key, manifest: null, actions: [] } })}\n`
        : `The app ${app.key} publishes no Agent manifest (HTTP ${outcome.status}).\n${FAILURES.missing.next_action}\n`,
    );
    return 0;
  }
  if (outcome.kind !== "valid")
    throw fail({
      ...FAILURES[outcome.kind],
      message: failureMessage(outcome, app),
      ...(outcome.kind === "invalid" ? { problems: outcome.problems } : {}),
    });
  const { manifest } = outcome;
  if (invocation.action && manifest.execution.mode === "local_cli")
    throw fail({
      code: "NO_HTTP_ACTIONS",
      message: `The app ${app.key} declares no HTTP actions: it runs as a local command, ${clean(manifest.execution.command, 64)}.`,
      next_action: manifest.docs_url
        ? `Read its documentation at ${clean(manifest.docs_url, 200)}.`
        : "Read the app's own documentation.",
    });
  const only = invocation.action
    ? manifest.actions.find((a) => a.name === invocation.action)
    : undefined;
  if (invocation.action && !only)
    throw fail({
      code: "ACTION_NOT_FOUND",
      message: `The app ${app.key} has no action named ${clean(invocation.action, 80)}.`,
      next_action: `Run coforge app invoke ${app.key} --list-actions to see its actions.`,
    });
  io.stdout(
    invocation.json
      ? `${JSON.stringify({ ok: true, data: { app: app.key, execution: manifest.execution, ...(only ? { action: only } : { actions: manifest.actions }) } })}\n`
      : `${formatManifest(app, manifest, only)}\n`,
  );
  return 0;
}
