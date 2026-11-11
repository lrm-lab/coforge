import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { isRecord, type ChannelOperation } from "@lrm/coforge-sdk/internal";
import { AgentExplainedRefusalError } from "./agent-explained-refusal-error";
import { AgentMessageRequestError } from "./agent-message-request-error";
import { AgentTransportError } from "./agent-transport-error";
import { getLogger } from "@logtape/logtape";

/** Transport helpers shared by the Agent HTTPS clients and the connection lifecycle.
 * Moved verbatim from `daemon-connection.ts`: no behaviour change, only a home. */
const logger = getLogger(["coforge", "daemon", "connection"]);

export const AGENT_RPC_TIMEOUT_MS = 10_000;

export type AgentHttpInput<Request> = {
  url: string;
  agentApiKey: string;
  daemonApiKey: string;
  request: Request;
};
export type HttpFetch = (
  input: string | URL | Request,
  init?: BunFetchRequestInit,
) => Promise<Response>;

/** Answers a key the cloud rejected with a fresh one, or `undefined` when none may be minted.
 * The runtime that owns the Agent key registry installs it once; the wire layer only ever sees
 * the rejected key string, never an Agent id. */
export type AgentApiKeyHealer = (rejectedKey: string) => Promise<string | undefined>;

let agentApiKeyHealer: AgentApiKeyHealer | undefined;

/** Installs (or with `undefined` removes) the Agent API key healer every Agent HTTPS call shares. */
export function setAgentApiKeyHealer(healer: AgentApiKeyHealer | undefined): void {
  agentApiKeyHealer = healer;
}

/** A request body the heal retry can send again; a stream is already consumed. */
function replayableAgentBody(body: RequestInit["body"]): boolean {
  return body === undefined || body === null || !(body instanceof ReadableStream);
}

/**
 * `fetcher` plus one Agent API key heal: a bare 401 is the credential boundary's opaque answer —
 * it cannot say `key_revoked` from `scope_mismatch`, and either way a key another launch's Stop
 * revoked looks identical. When the request carried an Agent key and a healer is installed, the
 * healer gets one chance to mint a replacement and the call retries exactly once with it. A body
 * that cannot be replayed, a `Request` input, or no fresh key leaves the 401 untouched.
 */
export function withAgentApiKeyHeal(fetcher: HttpFetch): HttpFetch {
  return async (input, init) => {
    const response = await fetcher(input, init);
    if (response.status !== 401 || agentApiKeyHealer === undefined) return response;
    if (typeof input !== "string" && !(input instanceof URL)) return response;
    if (!replayableAgentBody(init?.body)) return response;
    const rejected = new Headers(init?.headers).get("x-coforge-agent-api-key");
    const rejectedKey = rejected?.startsWith("Bearer ") ? rejected.slice(7) : undefined;
    if (!rejectedKey) return response;
    const fresh = await agentApiKeyHealer(rejectedKey).catch(() => undefined);
    if (!fresh || fresh === rejectedKey) return response;
    // Release the rejected response's connection before the retry reuses the pool.
    void response.body?.cancel().catch(() => undefined);
    const headers = new Headers(init?.headers);
    headers.set("x-coforge-agent-api-key", `Bearer ${fresh}`);
    return fetcher(input, { ...init, headers });
  };
}

/** `fetch` with the Agent API key heal — the default transport for every Agent HTTPS call. */
export const agentHttpFetch: HttpFetch = withAgentApiKeyHeal((input, init) => fetch(input, init));

/** Maps a channel operation onto its cloud HTTP method and path, given the local target
 * (`create` carries no target: the channel does not exist yet). */
export function channelEndpointFor(
  operation: ChannelOperation,
  target: string | undefined,
): { method: "GET" | "POST" | "PATCH" | "DELETE"; path: string } {
  const routes = agentApiRoutes.cloud.channels;
  switch (operation) {
    case "create":
      return { method: routes.create.method, path: routes.create.path };
    case "info":
      return { method: routes.info.method, path: routes.info.path(target ?? "") };
    case "update":
      return { method: routes.update.method, path: routes.update.path(target ?? "") };
    case "members":
      return { method: routes.members.method, path: routes.members.path(target ?? "") };
    case "add-member":
      return { method: routes.addMember.method, path: routes.addMember.path(target ?? "") };
    case "remove-member":
      return { method: routes.removeMember.method, path: routes.removeMember.path(target ?? "") };
    case "join":
      return { method: routes.join.method, path: routes.join.path(target ?? "") };
    case "leave":
      return { method: routes.leave.method, path: routes.leave.path(target ?? "") };
    case "archive":
      return { method: routes.archive.method, path: routes.archive.path(target ?? "") };
    case "unarchive":
      return { method: routes.unarchive.method, path: routes.unarchive.path(target ?? "") };
  }
}

/** Authorization headers every Agent-scoped HTTP request carries, plus one correlation id per
 * outbound call: the server request log records `x-request-id` as its `request_id`. */
export function agentHeaders(keys: { agentApiKey: string; daemonApiKey: string }, json = false) {
  return {
    authorization: `Bearer ${keys.daemonApiKey}`,
    "x-coforge-agent-api-key": `Bearer ${keys.agentApiKey}`,
    "x-request-id": crypto.randomUUID(),
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

/** How long a repeated request waits before its second attempt: long enough for a reset socket or
 * a proxy's failed upstream to clear, short enough to stay inside the caller's deadline. */
const REPEAT_AFTER_RESET_DELAY_MS = 150;

/** Whether repeating this request cannot double its effect. Only reads: every write that may be
 * repeated already owns its own one-shot repeat — a send settles by its idempotency key
 * (`settleAgentSend`), a reply repeats in the CLI under the key it mints — so repeating here too
 * would spend attempts several times over for one outage. */
function repeatableRequest(init: RequestInit): boolean {
  const method = (init.method ?? "GET").toUpperCase();
  return method === "GET" || method === "HEAD";
}

/** One more attempt after a connection that failed before an answer, or a 5xx, and only when the
 * request is repeatable. The repeat is the same `init` — the same idempotency key — never a new
 * one. The second attempt's outcome stands, whatever it is. */
async function repeatOnce(
  attempt: () => Promise<Response>,
  what: string,
  reason: "reset" | "5xx",
  status?: number,
): Promise<Response> {
  logger.info("Agent HTTP request repeated after a failed answer", {
    event: "agent.http.repeat_after_failed_answer",
    what,
    reason,
    ...(status !== undefined ? { status } : {}),
    attempt: 2,
  });
  await new Promise((resolve) => setTimeout(resolve, REPEAT_AFTER_RESET_DELAY_MS));
  return attempt();
}

/** Invokes the HTTP fetcher, turning any thrown error into a typed pre-response transport failure.
 * Every caller here speaks for an Agent, so the shared key heal applies even when the caller
 * injected a bare `fetch`. A read gets exactly one more attempt when the connection failed before
 * an answer arrived or the server answered 5xx (task #24, Raft 1.0.69 item 3); writes keep their
 * single attempt here because their caller already owns one repeat. */
export async function fetchAgentResponse(
  fetcher: HttpFetch,
  url: string | URL,
  init: RequestInit,
  what: string,
): Promise<Response> {
  const send = async () => {
    try {
      return await withAgentApiKeyHeal(fetcher)(url, init);
    } catch (cause) {
      throw AgentTransportError.preResponseTransport(what, cause);
    }
  };
  const repeatable = repeatableRequest(init) && replayableAgentBody(init.body);
  let first: Response;
  try {
    first = await send();
  } catch (error) {
    if (!repeatable) throw error;
    // The reset happened before any answer: this is the case the repeat exists for.
    return repeatOnce(send, what, "reset");
  }
  if (!repeatable || first.status < 500) return first;
  // A 5xx may still have produced a body: release its connection before the pool is reused.
  void first.body?.cancel().catch(() => undefined);
  return repeatOnce(send, what, "5xx", first.status);
}

/** Reads a response body as text, turning a stream failure into a typed mid-response failure. */
async function readAgentResponseText(response: Response, what: string): Promise<string> {
  try {
    return await response.text();
  } catch (cause) {
    throw AgentTransportError.midResponseTransport(what, response.status, cause);
  }
}

/** Logs a bounded snippet of a 5xx body for local diagnosis. The field is not named `body`:
 * LogTape's JSON sink redacts that key, which hid every prior probe. */
export function logUpstream5xxBody(what: string, status: number, body: string): void {
  if (status < 500) return;
  logger.error("Upstream agent HTTP 5xx body", {
    event: "agent.http.upstream_5xx_body",
    what,
    status,
    upstream_body_length: body.length,
    upstream_body_snippet: body.length > 0 ? body.slice(0, 2000) : "<empty>",
  });
}

/** Throws when the response is a non-2xx: the server's explained refusal, a safe validation
 * message, or a typed transport error. */
export async function assertAgentResponseOk(response: Response, what: string): Promise<void> {
  if (response.ok) return;
  const body = await readAgentResponseText(response, what);
  logUpstream5xxBody(what, response.status, body);
  // A 5xx whose body is exactly the Agent API's refusal shape named its own reason; the caller
  // gets that reason and code instead of a generic proxy failure. Any other 5xx body (a stack
  // trace, a gateway page) stays opaque.
  throw (
    AgentExplainedRefusalError.fromResponse(response.status, body) ??
    AgentMessageRequestError.fromRpc(response.status, body, decodeServerRefusal(body))
  );
}

/** A stable UPPER_SNAKE code: what a caller's own `code` field may hold. */
const STABLE_UPSTREAM_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * The `{ error, code?, retryable? }` a 5xx body names, or undefined. Unlike a 4xx refusal this
 * tolerates other fields (a 5xx body may carry diagnostics beside the reason) but keeps each field
 * to the same strict shape, so arbitrary text never becomes the caller's code.
 */
function decodeServerRefusal(
  body: string,
): { error: string; code?: string; retryable?: boolean } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const fields = parsed as Record<string, unknown>;
  if (typeof fields.error !== "string" || !fields.error.trim()) return undefined;
  return {
    error: fields.error,
    ...(typeof fields.code === "string" && STABLE_UPSTREAM_CODE.test(fields.code)
      ? { code: fields.code }
      : {}),
    ...(typeof fields.retryable === "boolean" ? { retryable: fields.retryable } : {}),
  };
}

/**
 * Decodes a 2xx response body as JSON, turning a decode failure or an optional shape `validate`
 * failure into a typed protocol-mismatch error — the response arrived, but the daemon could not
 * trust it. Never lets a missing required field reach the caller as a silent `undefined`.
 */
export async function readAgentResponseJson<Result>(
  response: Response,
  what: string,
  validate?: (data: unknown) => string | undefined,
): Promise<Result> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw AgentTransportError.protocolMismatch(
      what,
      response.status,
      "response body is not valid JSON",
    );
  }
  const shapeError = validate?.(data);
  if (shapeError) throw AgentTransportError.protocolMismatch(what, response.status, shapeError);
  return data as Result;
}

export { isRecord };

/** GETs `url` with the request's defined `keys` copied into the query string. */
export async function getAgentJson<Result>(
  fetcher: HttpFetch,
  input: Omit<AgentHttpInput<never>, "request"> & {
    query: Record<string, string | number | undefined>;
    what: string;
    validate?: (data: unknown) => string | undefined;
    /** A deadline for the whole request; none when omitted. */
    timeoutMs?: number;
  },
): Promise<Result> {
  const endpoint = new URL(input.url);
  for (const [key, value] of Object.entries(input.query))
    if (value !== undefined) endpoint.searchParams.set(key, String(value));
  const response = await fetchAgentResponse(
    fetcher,
    endpoint,
    {
      method: "GET",
      headers: agentHeaders(input),
      ...(input.timeoutMs !== undefined ? { signal: AbortSignal.timeout(input.timeoutMs) } : {}),
    },
    input.what,
  );
  await assertAgentResponseOk(response, input.what);
  return readAgentResponseJson<Result>(response, input.what, input.validate);
}

/** `getAgentJson`'s counterpart for a route that takes a JSON body: same error contract, same
 * optional shape `validate` and deadline. */
export async function sendAgentJson<Result>(
  fetcher: HttpFetch,
  input: Omit<AgentHttpInput<never>, "request"> & {
    method: "POST" | "DELETE";
    body: unknown;
    what: string;
    validate?: (data: unknown) => string | undefined;
    /** A deadline for the whole request; none when omitted. */
    timeoutMs?: number;
  },
): Promise<Result> {
  const response = await fetchAgentResponse(
    fetcher,
    input.url,
    {
      method: input.method,
      headers: agentHeaders(input, true),
      ...(input.timeoutMs !== undefined ? { signal: AbortSignal.timeout(input.timeoutMs) } : {}),
      body: JSON.stringify(input.body),
    },
    input.what,
  );
  await assertAgentResponseOk(response, input.what);
  return readAgentResponseJson<Result>(response, input.what, input.validate);
}

/**
 * Shared GET helper for a route whose JSON error body is always `{ ok: false, errorCode, error }`
 * (the Manual, `user info`, `profile show` and mention routes). `makeError` turns a well-formed
 * error body into the route family's own typed error; anything else is a genuine transport
 * failure.
 */
export async function getAgentEnvelopeJson<Result extends { ok: true }>(
  fetcher: HttpFetch,
  input: Omit<AgentHttpInput<never>, "request"> & {
    query: Record<string, string | undefined>;
    what: string;
  },
  makeError: (errorCode: string, message: string, status: number) => Error,
): Promise<Result> {
  const endpoint = new URL(input.url);
  for (const [key, value] of Object.entries(input.query))
    if (value !== undefined) endpoint.searchParams.set(key, value);
  const response = await fetchAgentResponse(
    fetcher,
    endpoint,
    { method: "GET", headers: agentHeaders(input) },
    input.what,
  );
  return decodeAgentEnvelopeJson<Result>(response, input.what, makeError);
}

/** Reads the `code` out of an agent API error body; a body that is absent, empty or not JSON is
 * simply a refusal without a named code, which is exactly what the caller already sees. */
export async function readUpstreamErrorCode(
  response: Pick<Response, "json">,
): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { code?: unknown };
    return typeof body.code === "string" && body.code.length > 0 ? body.code : undefined;
  } catch {
    return undefined;
  }
}

/** Same envelope convention as `getAgentEnvelopeJson`, for a route with a JSON body (`profile
 * update` POSTs, `app config` PATCHes). */
export async function postAgentEnvelopeJson<Result extends { ok: true }>(
  fetcher: HttpFetch,
  input: Omit<AgentHttpInput<never>, "request"> & {
    body: unknown;
    what: string;
    method?: "POST" | "PATCH";
  },
  makeError: (errorCode: string, message: string, status: number) => Error,
): Promise<Result> {
  const response = await fetchAgentResponse(
    fetcher,
    input.url,
    {
      method: input.method ?? "POST",
      headers: agentHeaders(input, true),
      body: JSON.stringify(input.body),
    },
    input.what,
  );
  return decodeAgentEnvelopeJson<Result>(response, input.what, makeError);
}

async function decodeAgentEnvelopeJson<Result extends { ok: true }>(
  response: Response,
  what: string,
  makeError: (errorCode: string, message: string, status: number) => Error,
): Promise<Result> {
  let data: unknown;
  try {
    data = await readAgentResponseText(response, what).then((text) => JSON.parse(text));
  } catch {
    throw AgentTransportError.protocolMismatch(
      what,
      response.status,
      "response body is not valid JSON",
    );
  }
  if (!response.ok) {
    const body = data as { errorCode?: unknown; error?: unknown } | null;
    if (body && typeof body.errorCode === "string" && typeof body.error === "string")
      throw makeError(body.errorCode, body.error, response.status);
    throw AgentTransportError.upstreamHttpResponse(what, response.status);
  }
  return data as Result;
}

export const AGENT_SEND_DECISIONS = new Set(["forward", "bypass", "local_hold", "syncing_hold"]);
export const AGENT_SEND_STATES = new Set(["sent", "held"]);
export const AGENT_SEND_RECONCILIATION_STATES = new Set(["committed", "not_found"]);

/** `"a"/"b"/…`, the members of `values` as an error string names them. */
function quotedList(values: ReadonlySet<string>): string {
  return [...values].map((value) => JSON.stringify(value)).join("/");
}

/** Validates the send route's response shape; the incident this module exists to prevent. */
export function validateAgentSendResponseShape(data: unknown): string | undefined {
  if (!isRecord(data)) return "response body is not a JSON object";
  if (typeof data.state !== "string" || !AGENT_SEND_STATES.has(data.state))
    return `response state is not one of ${quotedList(AGENT_SEND_STATES)} (got ${JSON.stringify(data.state)})`;
  if (typeof data.decision !== "string" || !AGENT_SEND_DECISIONS.has(data.decision))
    return `response decision is not one of ${quotedList(AGENT_SEND_DECISIONS)} (got ${JSON.stringify(data.decision)})`;
  if (data.state === "held" && !Array.isArray(data.heldMessages))
    return "response is missing the heldMessages array";
  return undefined;
}

/** Validates a `reconcileOnly` answer: `not_found`, or `committed` naming its message. */
export function validateAgentSendReconciliationShape(data: unknown): string | undefined {
  if (!isRecord(data)) return "response body is not a JSON object";
  if (typeof data.state !== "string" || !AGENT_SEND_RECONCILIATION_STATES.has(data.state))
    return `reconciliation state is not one of ${quotedList(AGENT_SEND_RECONCILIATION_STATES)} (got ${JSON.stringify(data.state)})`;
  if (data.state === "committed" && (typeof data.messageId !== "string" || !data.messageId))
    return "committed response is missing the messageId";
  return undefined;
}

export function validateAgentMessageArrayShape(field: string) {
  return (data: unknown): string | undefined =>
    isRecord(data) && Array.isArray(data[field])
      ? undefined
      : `response is missing the ${field} array`;
}
