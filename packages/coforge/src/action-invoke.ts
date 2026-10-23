import {
  buildActionRequest,
  validateAgainstSchema,
  type AgentAppView,
  type AgentManifestAction,
} from "@lrm/coforge-sdk/agent";
import { resolveActionInput, type ActionInputIo } from "./action-input";
import {
  callKey,
  classifyResponse,
  failWith,
  readCapped,
  redactor,
  resultText,
  type Capped,
  type FailFn,
} from "./action-response";
import type { AppInvokeInvocation } from "./app-actions";
import type { AppClient } from "./app-client";
import { APPROVAL_REQUIRED_EXIT_CODE, requestAppToken } from "./app-token-request";
import {
  clean,
  outcomeError,
  problemLines,
  readOutcome,
  SEE_APPS,
  type AppActionsIo,
} from "./manifest-read";

/** The longest the call may take, the response body included, unless `--timeout` says less or more. */
export const ACTION_TIMEOUT_SECONDS = 60;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/;

export type ActionInvokeIo = ActionInputIo &
  AppActionsIo & {
    /** The transport; tests inject one. */
    fetch?: (input: string, init: RequestInit) => Promise<Response>;
    /** Overrides the request timeout, in milliseconds. */
    requestTimeoutMs?: number;
  };

type BuiltRequest = { query: [string, string][]; body?: Record<string, unknown> };

/** A call that passed every check that needs no token: what would be sent, and the key it carries. */
type PreparedCall = {
  app: AgentAppView;
  action: AgentManifestAction;
  url: URL;
  built: BuiltRequest;
  /** The idempotency key to send, when the action needs one. */
  key: string | undefined;
  keyHeader: string | undefined;
};

/** Finds the app and action and checks the input and the key, all before a token is asked for. */
async function prepareCall(
  invocation: AppInvokeInvocation,
  apps: readonly AgentAppView[],
  io: ActionInvokeIo,
  outputMode: "text" | "json",
  fail: FailFn,
): Promise<PreparedCall> {
  const app = apps.find((item) => item.key === invocation.appKey);
  if (!app)
    throw fail(
      "APP_NOT_FOUND",
      `The app ${clean(invocation.appKey, 80)} is not installed in this Workspace.`,
      { suggestedNextAction: SEE_APPS },
    );
  const outcome = await readOutcome(app, io);
  if (outcome.kind !== "valid") throw outcomeError(outcome, app, invocation);
  const { manifest } = outcome;
  if (manifest.execution.mode !== "http_api")
    throw fail(
      "NO_HTTP_ACTIONS",
      `The app ${app.key} declares no HTTP actions: it runs as a local command, ${clean(manifest.execution.command, 64)}.`,
      {
        suggestedNextAction: manifest.docs_url
          ? `Read its documentation at ${clean(manifest.docs_url, 200)}.`
          : "Read the app's own documentation.",
      },
    );
  const action = manifest.actions.find((item) => item.name === invocation.action);
  if (!action)
    throw fail(
      "ACTION_NOT_FOUND",
      `The app ${app.key} has no action named ${clean(invocation.action, 80)}.`,
      {
        suggestedNextAction: `Run coforge app invoke ${app.key} --list-actions to see its actions.`,
      },
    );

  const input = await resolveActionInput(action, invocation, io, outputMode);
  const problems = validateAgainstSchema(action.input_schema, input);
  if (problems.length > 0)
    throw fail(
      "INPUT_INVALID",
      `The input does not match the action's input_schema (${problems.length} problem${problems.length === 1 ? "" : "s"}).`,
      {
        contextText: `Problems:\n${problemLines(problems)}`,
        details: { problems },
        suggestedNextAction: `Run coforge app invoke ${app.key} --list-actions --action ${action.name} to see its input. Patterns are not checked here; the app validates them.`,
      },
    );
  const needsKey = action.idempotency === "key_required";
  if (invocation.idempotencyKey !== undefined && !needsKey)
    throw fail(
      "INPUT_INVALID",
      `--idempotency-key does not apply: ${action.name} is ${action.idempotency}, not key_required.`,
    );
  if (invocation.idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(invocation.idempotencyKey))
    throw fail(
      "INPUT_INVALID",
      "--idempotency-key must be 1 to 128 printable characters without spaces.",
    );
  const built = buildActionRequest(action, input, manifest.execution.base_url);
  if (!built.ok || built.url === undefined)
    throw fail(
      "INPUT_INVALID",
      `The input cannot be sent: ${clean(built.ok ? "no URL" : built.message, 300)}.`,
    );
  const url = new URL(built.url);
  for (const [name, value] of built.query) url.searchParams.append(name, value);
  return {
    app,
    action,
    url,
    built,
    key: needsKey ? (invocation.idempotencyKey ?? crypto.randomUUID()) : undefined,
    keyHeader: needsKey ? action.idempotency_header : undefined,
  };
}

function printPreflight(
  { app, action, url, built, keyHeader }: PreparedCall,
  json: boolean,
  stdout: (chunk: string) => void,
): void {
  const request = {
    method: action.endpoint.method,
    url: url.href.split("?")[0],
    query: built.query,
    ...(built.body ? { body: built.body } : {}),
  };
  stdout(
    json
      ? `${JSON.stringify({ ok: true, data: { app: app.key, action: action.name, preflight: true, request, required_scopes: action.required_scopes, ...(keyHeader ? { idempotency_header: keyHeader } : {}) } })}\n`
      : `${[
          `Would send: ${request.method} ${url.href}`,
          ...(built.body ? [`Body: ${JSON.stringify(built.body)}`] : []),
          `Token scopes needed: ${action.required_scopes.join(", ") || "none"}`,
          ...(keyHeader
            ? [`Idempotency key: generated at send time, in the ${keyHeader} header`]
            : []),
          "Nothing was sent.",
        ].join("\n")}\n`,
  );
}

/**
 * `coforge app invoke <app-key> <action>`: calls one HTTP action of the app's Agent manifest with
 * the app's Bearer token (the one `app token` hands out) and prints its result. The manifest is
 * read afresh and the input validated against `input_schema` before anything is sent; nothing the
 * app returns is trusted, and the token is never printed. Resolves to the exit code (0); every
 * failure is thrown as a `CliError`.
 */
export async function runInvoke(
  invocation: AppInvokeInvocation,
  apps: readonly AgentAppView[],
  client: Pick<AppClient, "appToken">,
  io: ActionInvokeIo & { stdout(chunk: string): void },
): Promise<number> {
  const outputMode = invocation.json ? "json" : "text";
  const fail = failWith(outputMode);
  const call = await prepareCall(invocation, apps, io, outputMode, fail);
  if (invocation.preflight) {
    printPreflight(call, Boolean(invocation.json), io.stdout);
    return 0;
  }
  const { app, action, url, built, key: keyValue, keyHeader } = call;
  const key = callKey(keyValue);
  const unsafe = action.idempotency !== "safe";

  // The token is asked for only now: scopes are not yet part of the token request, so it carries
  // the grant the Agent holds, not the action's `required_scopes`.
  const answer = await requestAppToken(client, app.key, invocation.target);
  if (answer.status === "not_installed")
    throw fail(
      "TOKEN_NOT_INSTALLED",
      `The app ${app.key} is not installed in this Workspace, so there is no token for it.`,
      { suggestedNextAction: SEE_APPS },
    );
  if (answer.status === "approval_required") {
    const card = answer.actionCardMessageId;
    throw fail(
      "TOKEN_APPROVAL_REQUIRED",
      `Using ${app.key} needs a person's approval (request ${answer.requestId}); nothing was sent.`,
      {
        retryable: true,
        effect: "none",
        exitCode: APPROVAL_REQUIRED_EXIT_CODE,
        suggestedNextAction: card
          ? `Ask a Workspace owner or admin, or your creator, to approve the card posted as message ${card}${invocation.target ? ` in ${invocation.target}` : ""}, then run this command again.`
          : "Run this command again with --target <#channel or @person> to post an approval card there, or ask a Workspace owner or admin to approve it in your Apps settings; then run it again.",
      },
    );
  }
  const token = answer.access_token;
  const redaction = redactor(token);
  const { redact, scrub } = redaction;

  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
  };
  if (built.body) headers["content-type"] = "application/json";
  if (keyValue && keyHeader) headers[keyHeader] = keyValue;
  const timeoutMs =
    io.requestTimeoutMs ?? (invocation.timeoutSeconds ?? ACTION_TIMEOUT_SECONDS) * 1000;
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  let body: Capped;
  try {
    response = await (io.fetch ?? ((input, init) => fetch(input, init)))(url.href, {
      method: action.endpoint.method,
      headers,
      ...(built.body ? { body: JSON.stringify(built.body) } : {}),
      redirect: "manual",
      credentials: "omit",
      signal,
    });
    body =
      response.status >= 300 && response.status < 400 ? { text: "" } : await readCapped(response);
  } catch (error) {
    if (signal.aborted && unsafe)
      throw fail(
        "OPERATION_INDETERMINATE",
        `${action.name} did not answer within ${Math.round(timeoutMs / 1000)}s after the request was sent; it may or may not have run.`,
        {
          retryable: false,
          effect: "unknown: the app may have run the action",
          ...key.context,
          suggestedNextAction: `Check the app for the effect before repeating it.${key.retryHint}`,
        },
      );
    const reason = signal.aborted
      ? "it did not answer in time"
      : clean(redact(error instanceof Error ? error.message : error), 200);
    throw fail("APP_UNREACHABLE", `The app's API could not be reached: ${reason}.`, {
      retryable: true,
      ...key.context,
      suggestedNextAction: `Try again; if it keeps failing, tell the Workspace admin.${key.retryHint}`,
    });
  }
  const { status, result } = await classifyResponse({
    response,
    body,
    action,
    unsafe,
    outputMode,
    key,
    redaction,
  });
  io.stdout(
    invocation.json
      ? `${scrub(JSON.stringify({ ok: true, data: { app: app.key, action: action.name, status, result, ...(keyValue ? { idempotency_key: keyValue } : {}) } }))}\n`
      : `${resultText(result, redact)}${keyValue ? `\nIdempotency key: ${keyValue}` : ""}\n`,
  );
  return 0;
}
