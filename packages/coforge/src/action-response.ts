import { validateAgainstSchema, type AgentManifestAction } from "@lrm/coforge-sdk/agent";
import { isRecord } from "@lrm/coforge-sdk/internal";
import { readCappedText } from "./capped-read";
import { clean, problemLines } from "./manifest-read";
import { REDACTED } from "./app-token-exec";
import { CliError } from "./cli-error";

/** The response body is read up to this many bytes; more is refused. */
export const ACTION_RESPONSE_MAX_BYTES = 1024 * 1024;
/** Characters of a result or of an app's error text shown in text mode. */
const RESULT_TEXT_MAX = 4000;
const APP_MESSAGE_MAX = 300;

export type Failure = {
  retryable?: boolean;
  suggestedNextAction?: string;
  contextText?: string;
  details?: unknown;
  effect?: string;
  exitCode?: number;
};
export type FailFn = (code: string, message: string, extra?: Failure) => CliError;

/** A `CliError` builder for `outputMode`: not retryable unless `extra` says so. */
export const failWith =
  (outputMode: "text" | "json"): FailFn =>
  (code, message, extra = {}) =>
    new CliError({ code, message, retryable: false, outputMode, ...extra });

/** The idempotency key of a call, when its action needs one: shown on failures that leave the
 * outcome open, with the hint to retry under the same key. */
export type CallKey = { value?: string; context: Failure; retryHint: string };

export const callKey = (value: string | undefined): CallKey => ({
  ...(value ? { value } : {}),
  context: value ? { contextText: `Idempotency key: ${value}` } : {},
  retryHint: value ? ` Retry with --idempotency-key ${value} so the action runs at most once.` : "",
});
export type Capped = { text: string } | { tooLarge: true };

/**
 * Hides the token in text that came from the app. Control and format characters go first, so the
 * token cannot be hidden from the match by one inside it; this runs before any cut to a display
 * length, so a token across the cut is never half shown.
 */
export function redactor(token: string) {
  // Strips control and format characters itself, unlike normalizeAgentLaunchText, to keep newlines.
  /** Only the token goes; the text is otherwise as it was (for JSON that must stay JSON). */
  const scrub = (text: string) => text.split(token).join(REDACTED);
  const redact = (text: unknown) =>
    scrub(
      String(text)
        .replace(/[^\P{Cc}\n]/gu, " ")
        .replace(/\p{Cf}/gu, ""),
    );
  return { redact, scrub };
}

/** The response body, or `tooLarge` past the cap. */
export async function readCapped(response: Response): Promise<Capped> {
  const text = await readCappedText(response, ACTION_RESPONSE_MAX_BYTES);
  return text === null ? { tooLarge: true } : { text };
}

/** Already-redacted text, capped for display (a newline stays). */
function cap(plain: string, max = RESULT_TEXT_MAX): string {
  const chars = [...plain];
  return chars.length <= max
    ? plain
    : `${chars.slice(0, max - 1).join("")}… (truncated; use --json for the full result)`;
}

/** The app's own words for a refusal: a JSON `error` or `message` string, else nothing. */
function appMessage(text: string, redact: (text: unknown) => string): string | undefined {
  try {
    const body: unknown = JSON.parse(text);
    if (!isRecord(body)) return undefined;
    for (const candidate of [body.error, body.message, isRecord(body.error) && body.error.message])
      if (typeof candidate === "string" && candidate.trim())
        return clean(redact(candidate), APP_MESSAGE_MAX);
  } catch {
    // Not JSON: the app said nothing usable.
  }
  return undefined;
}

/** The result as text mode shows it: redacted, then cut. */
export function resultText(result: unknown, redact: (text: unknown) => string): string {
  return cap(redact(typeof result === "string" ? result : JSON.stringify(result, null, 2)));
}

export type ResponseContext = {
  response: Response;
  body: Capped;
  action: AgentManifestAction;
  /** The action may change something, so an answer that is not a clean refusal leaves it open. */
  unsafe: boolean;
  outputMode: "text" | "json";
  key: CallKey;
  redaction: ReturnType<typeof redactor>;
};

/** What a successful answer carried: its HTTP status and the parsed (or plain-text) result. */
export type ActionResult = { status: number; result: unknown };

/**
 * Sorts the app's answer: a redirect, an oversize body, a refusal, an outage or a result that does
 * not match the manifest each throw their own `CliError`; a 2xx answer resolves to its result.
 * Nothing the app says is trusted, and the token is redacted from all of it.
 */
export async function classifyResponse(ctx: ResponseContext): Promise<ActionResult> {
  const { response, body, action, unsafe, key } = ctx;
  const { redact, scrub } = ctx.redaction;
  const fail = failWith(ctx.outputMode);
  const keyContext = key.context;
  const retryHint = key.retryHint;
  const { status } = response;
  if (status >= 300 && status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw fail(
      "APP_UNREACHABLE",
      `The app's API answered with a redirect (HTTP ${status}); redirects are not followed, so the token is never sent elsewhere.`,
      {
        retryable: false,
        suggestedNextAction: "Tell the app's publisher that base_url must be the final address.",
      },
    );
  }
  if ("tooLarge" in body)
    throw fail(
      "OUTPUT_INVALID",
      `The app's response is larger than 1 MiB (HTTP ${status}); it was not read.`,
      {
        ...keyContext,
        effect:
          status < 400 && unsafe ? "the request was accepted; the action may have run" : undefined,
        suggestedNextAction: "Ask for less (narrow the input) or tell the app's publisher.",
      },
    );
  const text = body.text;
  const message = appMessage(text, redact);
  if (status === 401 || status === 403)
    throw fail(
      "APP_UNAUTHORIZED",
      `The app refused the token (HTTP ${status})${message ? `: ${message}` : ""}.`,
      {
        suggestedNextAction:
          "Check the app's installation and grants in the Workspace's Apps settings, or ask a Workspace admin.",
      },
    );
  if (status === 429 || status >= 500) {
    const retryAfter = response.headers.get("retry-after");
    const wait = retryAfter ? clean(redact(retryAfter), 40) : undefined;
    throw fail(
      "APP_UNAVAILABLE",
      `The app's API is unavailable (HTTP ${status})${wait ? `; it asks to retry after ${wait}` : ""}.`,
      {
        retryable: true,
        ...keyContext,
        suggestedNextAction: `Wait${wait ? ` ${wait}` : ""} and try again.${retryHint}`,
      },
    );
  }
  if (status < 200 || status >= 300)
    throw fail(
      "APP_REJECTED",
      `The app rejected the request (HTTP ${status}): ${message ?? "no message"}.`,
      {
        ...keyContext,
        suggestedNextAction: "Fix the input as the message says, then run the command again.",
      },
    );

  const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  let result: unknown = text === "" ? null : text;
  if (text !== "" && (type === "application/json" || type.endsWith("+json"))) {
    try {
      result = JSON.parse(text);
    } catch {
      throw fail("OUTPUT_INVALID", `The app answered HTTP ${status} as JSON that does not parse.`, {
        contextText: `Response:\n${cap(redact(text), 1000)}`,
        ...keyContext,
      });
    }
    const outputProblems = action.output_schema
      ? validateAgainstSchema(action.output_schema, result)
      : [];
    if (outputProblems.length > 0)
      throw fail(
        "OUTPUT_INVALID",
        `The app's answer (HTTP ${status}) does not match the action's output_schema (${outputProblems.length} problem${outputProblems.length === 1 ? "" : "s"}).`,
        {
          contextText: `Problems:\n${problemLines(outputProblems)}\nResponse:\n${cap(redact(JSON.stringify(result, null, 2)), 1000)}`,
          details: {
            problems: outputProblems,
            status,
            result: JSON.parse(scrub(JSON.stringify(result))),
          },
          effect: unsafe ? "the request was accepted; the action may have run" : undefined,
        },
      );
  }
  return { status, result };
}
