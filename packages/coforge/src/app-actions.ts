import type { AgentAppView, AgentManifest, AgentManifestAction } from "@lrm/coforge-sdk/agent";
import { isRecord } from "@lrm/coforge-sdk/internal";
import {
  clean,
  FAILURES,
  manifestError,
  outcomeError,
  readOutcome,
  SEE_APPS,
  type AppActionsIo,
  type ManifestError,
} from "./manifest-read";

const SCHEMA_TEXT_MAX = 4000;

/** `coforge app invoke <app-key> --list-actions [--action <name>] [--json]`, or
 * `coforge app invoke <app-key> <action> [inputs] [options]` to call one action. */
export type AppInvokeInvocation = {
  command: "app-invoke";
  appKey: string;
  action?: string;
  listActions?: true;
  json?: true;
  /** Calling only: where an approval card is posted, and the request timeout. */
  target?: string;
  timeoutSeconds?: number;
  /** Calling only: the input, as `--param key=value` pairs or one JSON document. */
  params?: string[];
  dataJson?: string;
  dataFile?: string;
  /** Stop after validating the input and print the request that would be sent. */
  preflight?: true;
  idempotencyKey?: string;
};

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
  if (outcome.kind !== "valid") throw outcomeError(outcome, app, invocation);
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
