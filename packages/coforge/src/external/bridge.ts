import { decodeWakeHint, decodeWakeHints, type WakeHint } from "@lrm/coforge-sdk/agent";
import { CliError } from "../cli-error";
import { acquireBridgeLock } from "./bridge-lock";
import type { FetchLike } from "./device-client";
import type { ProfileStore } from "./profile-store";
import { invalidCredentialError } from "./refusal";
import { serverUrlOf } from "./server-request";

export type BridgeOptions = {
  json: boolean;
  once: boolean;
  expectedAgent?: string;
  wakeEndpoint?: URL;
  pollIntervalMs: number;
};

export type BridgeDeps = {
  store: ProfileStore;
  fetch: FetchLike;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  sleep: (milliseconds: number) => Promise<void>;
  signal: AbortSignal;
  random?: () => number;
};

const USAGE =
  "Usage: coforge agent bridge [--profile <slug>] [--expected-agent <agent-id>] [--json] [--once] [--wake-endpoint <http://127.0.0.1:port/path>] [--poll-interval-ms <n>]";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const STREAM_SILENCE_MS = 75_000;
const WAKE_POST_TIMEOUT_MS = 5_000;
const STREAM_PATH = "/api/agent/v1/wake-hints/stream";
const POLL_PATH = "/api/agent/v1/wake-hints";

const invalidArg = (message: string) =>
  new CliError({ code: "INVALID_ARG", message, retryable: false });

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || LOOPBACK_V4.test(hostname);
}

function parseWakeEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidArg(`--wake-endpoint is not a URL. ${USAGE}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw invalidArg("--wake-endpoint must be an http:// or https:// URL.");
  if (!isLoopbackHost(url.hostname))
    throw new CliError({
      code: "WAKE_ENDPOINT_NOT_LOOPBACK",
      message: "--wake-endpoint must point at this machine (localhost, 127.x.x.x or [::1]).",
      retryable: false,
    });
  return url;
}

export function parseBridgeArgs(
  args: readonly string[],
  env: Record<string, string | undefined>,
): BridgeOptions {
  const options: BridgeOptions = {
    json: false,
    once: false,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  };
  let expected = env.COFORGE_EXPECTED_AGENT_ID?.trim() || undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const [flag, inline] =
      arg.startsWith("--") && arg.includes("=")
        ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
        : [arg, undefined];
    const value = () => {
      const next = inline ?? args[++index];
      if (!next) throw invalidArg(`${flag} needs a value. ${USAGE}`);
      return next;
    };
    if (flag === "--json") options.json = true;
    else if (flag === "--once") options.once = true;
    else if (flag === "--expected-agent") expected = value();
    else if (flag === "--wake-endpoint") options.wakeEndpoint = parseWakeEndpoint(value());
    else if (flag === "--poll-interval-ms") {
      const text = value();
      const parsed = Number(text);
      if (!/^\d+$/.test(text) || !Number.isSafeInteger(parsed) || parsed < 1)
        throw invalidArg("--poll-interval-ms must be a positive integer.");
      options.pollIntervalMs = parsed;
    } else throw invalidArg(`Unknown option ${arg}. ${USAGE}`);
  }
  if (expected) options.expectedAgent = expected;
  return options;
}

class StreamUnavailable extends Error {
  constructor(readonly status: number) {
    super(`wake stream unavailable (${status})`);
  }
}

export function describeHint(hint: WakeHint): string {
  const flags = hint.flags.length ? ` (${hint.flags.join(", ")})` : "";
  const sender = hint.latestSenderName ? `, latest from ${hint.latestSenderName}` : "";
  return `${hint.target ?? hint.channelId}: ${hint.pendingCount} unread${flags}${sender}`;
}

async function resolveSlug(store: ProfileStore, selected: string | undefined): Promise<string> {
  if (selected !== undefined) return selected;
  const all = await store.listProfiles();
  if (all.length === 1) return all[0]!;
  throw new CliError({
    code: all.length === 0 ? "PROFILE_NOT_LOGGED_IN" : "PROFILE_AMBIGUOUS",
    message:
      all.length === 0 ? "No Agent profile exists." : `Several profiles exist (${all.join(", ")}).`,
    retryable: false,
    suggestedNextAction:
      all.length === 0
        ? "Run `coforge agent login --server <url> --workspace <slug> --agent <name>` first."
        : "Pass --profile <slug> or set COFORGE_PROFILE.",
  });
}

export async function runBridge(
  options: BridgeOptions,
  selected: string | undefined,
  deps: BridgeDeps,
): Promise<number> {
  const slug = await resolveSlug(deps.store, selected);
  const profile = await deps.store.readProfile(slug);
  if (!profile)
    throw new CliError({
      code: "PROFILE_NOT_LOGGED_IN",
      message: `Profile "${slug}" has no credential.`,
      retryable: false,
      suggestedNextAction:
        "Run `coforge agent login --server <url> --workspace <slug> --agent <name>` first.",
    });
  if (options.expectedAgent && options.expectedAgent !== profile.agentId)
    throw new CliError({
      code: "AGENT_MISMATCH",
      message: `Profile "${slug}" is Agent ${profile.agentId}, not the expected ${options.expectedAgent}; the bridge did nothing.`,
      retryable: false,
    });
  const release = await acquireBridgeLock(deps.store.pathOf(slug));
  try {
    return await new Bridge(options, profile, deps).run();
  } finally {
    await release();
  }
}

class Bridge {
  private readonly emitted = new Map<string, bigint>();
  private wakeFailed = false;
  private readonly random: () => number;

  constructor(
    private readonly options: BridgeOptions,
    private readonly profile: { serverUrl: string; apiKey: string },
    private readonly deps: BridgeDeps,
  ) {
    this.random = deps.random ?? Math.random;
  }

  async run(): Promise<number> {
    if (this.options.once) {
      try {
        await this.holdStream(true);
      } catch (error) {
        if (error instanceof CliError) throw error;
        await this.poll();
      }
      return this.wakeFailed ? 1 : 0;
    }
    let failures = 0;
    while (!this.deps.signal.aborted) {
      try {
        const received = await this.holdStream(false);
        failures = received ? 0 : failures + 1;
      } catch (error) {
        if (error instanceof CliError) throw error;
        failures += 1;
        if (this.deps.signal.aborted) break;
        try {
          await this.poll();
        } catch (pollError) {
          if (pollError instanceof CliError) throw pollError;
        }
      }
      if (this.deps.signal.aborted) break;
      const backoff = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(failures, 10));
      const delay = Math.min(backoff, this.options.pollIntervalMs);
      await this.deps.sleep(Math.round(delay * (0.8 + this.random() * 0.4)));
    }
    return 0;
  }

  private request(path: string, signal: AbortSignal): Promise<Response> {
    return this.deps.fetch(serverUrlOf(this.profile.serverUrl, path), {
      method: "GET",
      headers: {
        authorization: `Bearer ${this.profile.apiKey}`,
        accept: path === STREAM_PATH ? "text/event-stream" : "application/json",
      },
      redirect: "error",
      signal,
    });
  }

  private async poll(): Promise<void> {
    const signal = AbortSignal.any([this.deps.signal, AbortSignal.timeout(10_000)]);
    const response = await this.request(POLL_PATH, signal);
    if (response.status === 401) throw invalidCredentialError();
    if (!response.ok) throw new StreamUnavailable(response.status);
    for (const hint of decodeWakeHints(await response.json())) await this.deliver(hint);
  }

  private async holdStream(stopAfterSnapshot: boolean): Promise<boolean> {
    const session = new AbortController();
    const abort = () => session.abort();
    this.deps.signal.addEventListener("abort", abort, { once: true });
    let silence: ReturnType<typeof setTimeout> | undefined;
    const watch = () => {
      clearTimeout(silence);
      silence = setTimeout(abort, STREAM_SILENCE_MS);
    };
    try {
      let response: Response;
      try {
        response = await this.request(STREAM_PATH, session.signal);
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw new StreamUnavailable(0);
      }
      if (response.status === 401) throw invalidCredentialError();
      if (!response.ok || !response.body) throw new StreamUnavailable(response.status);
      watch();
      const reader = response.body.getReader();
      session.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), {
        once: true,
      });
      const decoder = new TextDecoder();
      let buffer = "";
      let received = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return received;
          watch();
          buffer += decoder.decode(value, { stream: true });
          for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            received = true;
            if ((await this.handleFrame(block)) && stopAfterSnapshot) return true;
          }
        }
      } catch (error) {
        if (error instanceof CliError) throw error;
        if (session.signal.aborted) return received;
        throw new StreamUnavailable(0);
      } finally {
        await reader.cancel().catch(() => {});
      }
    } finally {
      clearTimeout(silence);
      this.deps.signal.removeEventListener("abort", abort);
    }
  }

  private async handleFrame(block: string): Promise<boolean> {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (event !== "hints" && event !== "hint") return false;
    let payload: unknown;
    try {
      payload = JSON.parse(data.join("\n"));
    } catch {
      return false;
    }
    try {
      const hints = event === "hints" ? decodeWakeHints(payload) : [decodeWakeHint(payload)];
      for (const hint of hints) await this.deliver(hint);
    } catch (error) {
      if (error instanceof CliError) throw error;
      return false;
    }
    return event === "hints";
  }

  private async deliver(hint: WakeHint): Promise<void> {
    const key = `${hint.channelId}|${hint.target ?? ""}`;
    const seq = BigInt(hint.latestSeq);
    const before = this.emitted.get(key);
    if (before !== undefined && before >= seq) return;
    if (this.options.wakeEndpoint) {
      if (!(await this.post(this.options.wakeEndpoint, hint))) {
        this.wakeFailed = true;
        return;
      }
    } else this.deps.stdout(`${this.options.json ? JSON.stringify(hint) : describeHint(hint)}\n`);
    this.emitted.set(key, seq);
  }

  private async post(endpoint: URL, hint: WakeHint): Promise<boolean> {
    try {
      const response = await this.deps.fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(hint),
        redirect: "error",
        signal: AbortSignal.timeout(WAKE_POST_TIMEOUT_MS),
      });
      await response.body?.cancel();
      if (response.ok) return true;
      this.deps.stderr(
        `wake endpoint answered HTTP ${response.status}; will retry on the next hint.\n`,
      );
    } catch {
      this.deps.stderr("wake endpoint could not be reached; will retry on the next hint.\n");
    }
    return false;
  }
}
