import { decodeWakeHint, decodeWakeHints, type WakeHint } from "@lrm/coforge-sdk/agent";
import { CliError } from "../cli-error";
import {
  ACTIVITY_DRAIN_INTERVAL_MS,
  ActivityPump,
  DEFAULT_ACTIVITY_DRAIN_LIMIT,
  activityDrainBeside,
} from "./bridge-activity";
import { acquireBridgeLock } from "./bridge-lock";
import { isLoopbackHost } from "./loopback";
import type { FetchLike } from "./device-client";
import type { ProfileStore } from "./profile-store";
import { selectedOrOnlyProfile } from "./profile-select";
import { invalidCredentialError, profileNotLoggedInError } from "./refusal";
import { serverUrlOf } from "./server-request";

export type BridgeOptions = {
  json: boolean;
  once: boolean;
  expectedAgent?: string;
  wakeEndpoint?: URL;
  pollIntervalMs: number;
  activityEndpoint?: URL;
  activityDrainLimit: number;
  channelToken?: string;
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
  "Usage: coforge agent bridge [--profile <slug>] [--expected-agent <agent-id>] [--json] [--once] [--wake-endpoint <http://127.0.0.1:port/path>] [--poll-interval-ms <n>] [--activity-endpoint <http://127.0.0.1:port/path>] [--activity-drain-limit <n>]";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const STREAM_SILENCE_MS = 75_000;
const WAKE_POST_TIMEOUT_MS = 5_000;
const STREAM_PATH = "/api/agent/v1/wake-hints/stream";
const POLL_PATH = "/api/agent/v1/wake-hints";

const invalidArg = (message: string) =>
  new CliError({ code: "INVALID_ARG", message, retryable: false });

function parseLoopbackUrl(flag: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidArg(`${flag} is not a URL. ${USAGE}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw invalidArg(`${flag} must be an http:// or https:// URL.`);
  if (!isLoopbackHost(url.hostname))
    throw new CliError({
      code: "WAKE_ENDPOINT_NOT_LOOPBACK",
      message: `${flag} must point at this machine (localhost, 127.x.x.x or [::1]).`,
      retryable: false,
    });
  return url;
}

function positiveInteger(flag: string, text: string): number {
  const parsed = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(parsed) || parsed < 1)
    throw invalidArg(`${flag} must be a positive integer.`);
  return parsed;
}

export function parseBridgeArgs(
  args: readonly string[],
  env: Record<string, string | undefined>,
): BridgeOptions {
  const options: BridgeOptions = {
    json: false,
    once: false,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    activityDrainLimit: DEFAULT_ACTIVITY_DRAIN_LIMIT,
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
    else if (flag === "--wake-endpoint") options.wakeEndpoint = parseLoopbackUrl(flag, value());
    else if (flag === "--activity-endpoint")
      options.activityEndpoint = parseLoopbackUrl(flag, value());
    else if (flag === "--poll-interval-ms") options.pollIntervalMs = positiveInteger(flag, value());
    else if (flag === "--activity-drain-limit")
      options.activityDrainLimit = positiveInteger(flag, value());
    else throw invalidArg(`Unknown option ${arg}. ${USAGE}`);
  }
  if (expected) options.expectedAgent = expected;
  if (!options.activityEndpoint && options.wakeEndpoint)
    options.activityEndpoint = activityDrainBeside(options.wakeEndpoint);
  const token = env.COFORGE_CHANNEL_TOKEN?.trim();
  if (token) options.channelToken = token;
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

export async function runBridge(
  options: BridgeOptions,
  selected: string | undefined,
  deps: BridgeDeps,
): Promise<number> {
  const slug = await selectedOrOnlyProfile(deps.store, selected);
  if (slug === undefined) throw profileNotLoggedInError();
  const profile = await deps.store.readProfile(slug);
  if (!profile) throw profileNotLoggedInError(slug);
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
  private readonly stop = new AbortController();
  private readonly signal: AbortSignal;
  private readonly pump?: ActivityPump;

  constructor(
    private readonly options: BridgeOptions,
    private readonly profile: { serverUrl: string; apiKey: string },
    private readonly deps: BridgeDeps,
  ) {
    this.random = deps.random ?? Math.random;
    this.signal = AbortSignal.any([deps.signal, this.stop.signal]);
    if (options.activityEndpoint)
      this.pump = new ActivityPump(
        {
          endpoint: options.activityEndpoint,
          limit: options.activityDrainLimit,
          ...(options.channelToken ? { token: options.channelToken } : {}),
        },
        profile,
        deps,
      );
  }

  async run(): Promise<number> {
    if (this.options.once) {
      try {
        await this.holdStream(true);
      } catch (error) {
        if (error instanceof CliError) throw error;
        await this.poll();
      }
      await this.pump?.cycle(this.signal);
      return this.wakeFailed ? 1 : 0;
    }
    const halt = (error: unknown) => {
      this.stop.abort();
      throw error;
    };
    const results = await Promise.allSettled([
      this.receive().catch(halt),
      this.pumpActivity().catch(halt),
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    return 0;
  }

  private async pumpActivity(): Promise<void> {
    if (!this.pump) return;
    while (!this.signal.aborted) {
      await this.pump.cycle(this.signal);
      if (this.signal.aborted) break;
      await this.deps.sleep(ACTIVITY_DRAIN_INTERVAL_MS);
    }
  }

  private async receive(): Promise<void> {
    let failures = 0;
    while (!this.signal.aborted) {
      try {
        const received = await this.holdStream(false);
        failures = received ? 0 : failures + 1;
      } catch (error) {
        if (error instanceof CliError) throw error;
        failures += 1;
        if (this.signal.aborted) break;
        try {
          await this.poll();
        } catch (pollError) {
          if (pollError instanceof CliError) throw pollError;
        }
      }
      if (this.signal.aborted) break;
      const backoff = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(failures, 10));
      const delay = Math.min(backoff, this.options.pollIntervalMs);
      await this.deps.sleep(Math.round(delay * (0.8 + this.random() * 0.4)));
    }
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
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(10_000)]);
    const response = await this.request(POLL_PATH, signal);
    if (response.status === 401) throw invalidCredentialError();
    if (!response.ok) throw new StreamUnavailable(response.status);
    for (const hint of decodeWakeHints(await response.json())) await this.deliver(hint);
  }

  private async holdStream(stopAfterSnapshot: boolean): Promise<boolean> {
    const session = new AbortController();
    const abort = () => session.abort();
    this.signal.addEventListener("abort", abort, { once: true });
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
      this.signal.removeEventListener("abort", abort);
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
