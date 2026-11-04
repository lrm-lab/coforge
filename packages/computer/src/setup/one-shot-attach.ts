import { setupError } from "#src/errors";

/**
 * The one-shot attach (task #417 step 3): `attach --one-shot` reports this machine, prints the
 * short code and approval link for a person to check, polls until they approve or refuse, and
 * hands the single-use `attach_token` back as the credential `computer:register` consumes for
 * an `sk_computer`. Fallback to the OAuth login happens only where the server names
 * `attach.session-fallback` — a timeout, a 5xx, or a dropped connection is an error, never a
 * silent fallback.
 */
export type AttachStart = {
  sessionId: string;
  deviceCode: string;
  userCode: string;
  approveUrl: string;
  expiresInSeconds: number;
};

export class OneShotAttachFailedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** `true` only where the server named `attach.session-fallback`. */
    readonly sessionFallback = false,
  ) {
    super(message);
    this.name = "OneShotAttachFailedError";
  }
}

const post = async (
  serverUrl: string,
  path: string,
  body: unknown,
  fetchImplementation: typeof fetch,
): Promise<Response> => {
  const origin = new URL(serverUrl).origin;
  return fetchImplementation(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
};

async function attachStart(
  serverUrl: string,
  machine: { machineName: string; hostname: string; os: string },
  fetchImplementation: typeof fetch,
): Promise<AttachStart> {
  let response: Response;
  try {
    response = await post(serverUrl, "/api/computer/attach/start", machine, fetchImplementation);
  } catch (error) {
    throw new OneShotAttachFailedError(
      "ATTACH_NETWORK",
      `Could not reach the server: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok)
    throw new OneShotAttachFailedError(
      "ATTACH_START_FAILED",
      `attach/start answered ${response.status}.`,
    );
  const body = (await response.json().catch(() => undefined)) as
    | {
        sessionId?: string;
        deviceCode?: string;
        userCode?: string;
        approveUrl?: string;
        expiresInSeconds?: number;
      }
    | undefined;
  if (!body?.sessionId || !body.deviceCode || !body.userCode || !body.approveUrl)
    throw new OneShotAttachFailedError(
      "ATTACH_START_FAILED",
      "attach/start answered without the session it promised.",
    );
  return {
    sessionId: body.sessionId,
    deviceCode: body.deviceCode,
    userCode: body.userCode,
    approveUrl: body.approveUrl,
    expiresInSeconds: body.expiresInSeconds ?? 600,
  };
}

const POLL_INTERVAL_MS = 3_000;

async function attachPoll(
  serverUrl: string,
  deviceCode: string,
  fetchImplementation: typeof fetch,
  write: (line: string) => void,
  sleep: (ms: number) => Promise<void>,
  /** The session's own expiry: polling ends on it plus a minute's margin, so a dropped poll,
   * a 429 or a run of 5xx never retries past when the token could still come (task #417). */
  expiresInSeconds: number,
): Promise<string> {
  let interval = POLL_INTERVAL_MS;
  const deadline = Date.now() + (expiresInSeconds + 60) * 1000;
  let consecutiveServerErrors = 0;
  for (;;) {
    if (Date.now() >= deadline)
      throw new OneShotAttachFailedError(
        "ATTACH_EXPIRED",
        "The attach session expired; run attach again for a fresh link.",
      );
    await sleep(interval);
    let response: Response;
    try {
      response = await post(
        serverUrl,
        "/api/computer/attach/poll",
        { deviceCode },
        fetchImplementation,
      );
    } catch {
      // A dropped poll is retried — the device code is a bearer secret, so a retry is safe.
      continue;
    }
    const body = (await response.json().catch(() => undefined)) as
      | { error?: string; attachToken?: string }
      | undefined;
    if (response.ok && body?.attachToken) return body.attachToken;
    if (response.status >= 500) {
      consecutiveServerErrors += 1;
      if (consecutiveServerErrors >= 5)
        throw new OneShotAttachFailedError(
          "ATTACH_START_FAILED",
          "attach/poll answered a server error repeatedly.",
        );
      continue;
    }
    consecutiveServerErrors = 0;
    switch (body?.error) {
      case "attach_pending":
        break;
      case "slow_down":
        interval += POLL_INTERVAL_MS;
        break;
      case "access_denied":
        throw new OneShotAttachFailedError(
          "ATTACH_DENIED",
          "The attach was refused on the approval page.",
        );
      case "expired_token":
        throw new OneShotAttachFailedError(
          "ATTACH_EXPIRED",
          "The attach session expired; run attach again for a fresh link.",
        );
      case "attach.session-fallback":
        throw new OneShotAttachFailedError(
          "ATTACH_SESSION_FALLBACK",
          "The server asked for the login flow.",
          true,
        );
      default:
        // Any other answer keeps polling — an unrecognized status is not a reason to fall back.
        break;
    }
  }
}

/**
 * The one-shot attach: report the machine, show the person the code and link, poll until they
 * decide, and answer the credential `computer:register` exchanges for an `sk_computer`. Only a
 * server's explicit `attach.session-fallback` sends the caller back to `login` + `setup`.
 */
export async function oneShotAttach(
  input: {
    serverUrl: string;
    machineName: string;
    hostname: string;
    os: string;
    write?: (line: string) => void;
    /** The poll's wait — injectable so a test does not sleep real seconds. */
    sleep?: (ms: number) => Promise<void>;
  },
  fetchImplementation: typeof fetch = fetch,
): Promise<{ accessToken: string; tokenType: string }> {
  const write = input.write ?? (() => {});
  const started = await attachStart(
    input.serverUrl,
    { machineName: input.machineName, hostname: input.hostname, os: input.os },
    fetchImplementation,
  );
  write(`Approve this computer at ${started.approveUrl}`);
  write(`and confirm the code it shows matches: ${started.userCode}`);
  const attachToken = await attachPoll(
    input.serverUrl,
    started.deviceCode,
    fetchImplementation,
    write,
    input.sleep ?? Bun.sleep,
    started.expiresInSeconds,
  );
  return { accessToken: attachToken, tokenType: "Bearer" };
}
