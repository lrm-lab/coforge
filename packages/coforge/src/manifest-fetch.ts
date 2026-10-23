import {
  AGENT_MANIFEST_LIMITS,
  httpsUrlProblem,
  parseAgentManifest,
  type AgentManifest,
  type AgentManifestProblem,
} from "@lrm/coforge-sdk/agent";

/** What reading an app's Agent manifest came to. `absent` is a 404/410 at the URL the CLI derived
 * from the homepage: the app publishes none, which is fine. `missing` is the same answer at a URL
 * the app named explicitly: that is a broken promise. */
export type ManifestOutcome =
  | { kind: "valid"; manifest: AgentManifest }
  | { kind: "absent"; status: number }
  | { kind: "missing"; status: number }
  | { kind: "unavailable"; status: number; retryAfter?: string }
  | { kind: "invalid"; problems: AgentManifestProblem[] }
  | { kind: "unreachable"; message: string }
  | { kind: "not_configured" };

export const MANIFEST_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

export type FetchAgentManifestOptions = {
  url: string;
  /** The URL was derived from the homepage, not named by the app: a 404/410 then means `absent`. */
  derived?: boolean;
  timeoutMs?: number;
  /** The transport; tests inject one. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
};

/** The URL to fetch, or why it may not be: the manifest's own https rule. */
function checkFetchable(raw: string): URL | string {
  const problem = httpsUrlProblem(raw);
  return problem ? `the manifest URL ${problem}` : new URL(raw);
}

/** Drops an unread body so the connection is released. */
const discard = (response: Response) => response.body?.cancel().catch(() => undefined);

const invalid = (message: string): ManifestOutcome => ({
  kind: "invalid",
  problems: [{ path: "", message }],
});

/** Reads the body, refusing more than the cap by `content-length` and again while streaming. */
async function readCapped(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > AGENT_MANIFEST_LIMITS.maxBytes) {
    await discard(response);
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > AGENT_MANIFEST_LIMITS.maxBytes) return null;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Cancelling also covers a read that threw or timed out; after a full read it is a no-op.
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * GETs and validates the manifest at `url`, every time (nothing is cached). Redirects are followed
 * by hand so that every hop stays https without credentials; the whole read, body included, shares
 * one timeout.
 */
export async function fetchAgentManifest(
  options: FetchAgentManifestOptions,
): Promise<ManifestOutcome> {
  const transport = options.fetch ?? ((input, init) => fetch(input, init));
  const signal = AbortSignal.timeout(options.timeoutMs ?? MANIFEST_TIMEOUT_MS);
  try {
    let target = options.url;
    for (let hop = 0; ; hop++) {
      const url = checkFetchable(target);
      if (typeof url === "string")
        return {
          kind: "unreachable",
          message:
            hop === 0
              ? url
              : "the manifest URL redirected to a non-https or credential-bearing URL",
        };
      const response = await transport(url.href, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "manual",
        signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || hop >= MAX_REDIRECTS)
          return { kind: "unreachable", message: "too many redirects, or one without a location" };
        try {
          target = new URL(location, url).href;
        } catch {
          return { kind: "unreachable", message: "the manifest redirect has an invalid location" };
        }
        await discard(response);
        continue;
      }
      return await classify(response, options.derived === true);
    }
  } catch (error) {
    const timedOut = signal.aborted;
    return {
      kind: "unreachable",
      message: timedOut
        ? "the manifest did not arrive in time"
        : error instanceof Error
          ? error.message
          : String(error),
    };
  }
}

async function classify(response: Response, derived: boolean): Promise<ManifestOutcome> {
  const { status } = response;
  if (status === 404 || status === 410) {
    await discard(response);
    return { kind: derived ? "absent" : "missing", status };
  }
  if (status === 429 || status >= 500) {
    await discard(response);
    const retryAfter = response.headers.get("retry-after");
    return { kind: "unavailable", status, ...(retryAfter ? { retryAfter } : {}) };
  }
  if (status < 200 || status >= 300) {
    await discard(response);
    return invalid(`the manifest URL answered HTTP ${status}`);
  }
  const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json" && !type.endsWith("+json")) {
    await discard(response);
    return invalid(`the manifest must be served as JSON, not "${type || "no content type"}"`);
  }
  const text = await readCapped(response);
  if (text === null) return invalid("the manifest is larger than 1 MiB");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalid("the manifest is not valid JSON");
  }
  const parsed = parseAgentManifest(value);
  return parsed.ok
    ? { kind: "valid", manifest: parsed.manifest }
    : { kind: "invalid", problems: parsed.problems };
}
