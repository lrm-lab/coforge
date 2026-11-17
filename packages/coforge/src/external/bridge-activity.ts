import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { isRecord } from "@lrm/coforge-sdk/internal";
import type { FetchLike } from "./device-client";
import { invalidCredentialError } from "./refusal";
import { serverUrlOf } from "./server-request";

export const ACTIVITY_DRAIN_SCHEMA = "coforge-activity-drain.v1";
export const ACTIVITY_INGEST_SCHEMA = "coforge-agent-activity-ingest.v1";
export const DEFAULT_ACTIVITY_DRAIN_LIMIT = 50;
export const ACTIVITY_DRAIN_INTERVAL_MS = 2_000;

const INGEST_PATH = agentApiRoutes.external.activity.path;
const DRAIN_TIMEOUT_MS = 3_000;
const FORWARD_TIMEOUT_MS = 10_000;
const FORWARD_BATCH = 100;
const PENDING_CAP = 1_000;

export function activityDrainBeside(wakeEndpoint: URL): URL {
  const url = new URL(wakeEndpoint);
  url.pathname = "/activity/drain";
  url.search = "";
  url.hash = "";
  return url;
}

export type ActivitySource = { endpoint: URL; limit: number; token?: string };

type Deps = { fetch: FetchLike; stderr: (text: string) => void };

export class ActivityPump {
  private pending: Record<string, unknown>[] = [];

  constructor(
    private readonly source: ActivitySource,
    private readonly server: { serverUrl: string; apiKey: string },
    private readonly deps: Deps,
  ) {}

  async cycle(signal: AbortSignal): Promise<void> {
    const drained = await this.drain(signal);
    if (drained.length) {
      this.pending.push(...drained);
      const excess = this.pending.length - PENDING_CAP;
      if (excess > 0) {
        this.pending.splice(0, excess);
        this.deps.stderr(`activity backlog full; dropped the ${excess} oldest events.\n`);
      }
    }
    if (this.pending.length) await this.forward(signal);
  }

  private async drain(signal: AbortSignal): Promise<Record<string, unknown>[]> {
    const url = new URL(this.source.endpoint);
    url.searchParams.set("max", String(this.source.limit));
    try {
      const response = await this.deps.fetch(url, {
        method: "GET",
        headers: this.source.token ? { "x-coforge-bridge-token": this.source.token } : {},
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(DRAIN_TIMEOUT_MS)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        this.deps.stderr(`activity drain answered HTTP ${response.status}.\n`);
        return [];
      }
      const body: unknown = await response.json();
      if (!isRecord(body) || body.schema !== ACTIVITY_DRAIN_SCHEMA || !Array.isArray(body.events)) {
        this.deps.stderr(`activity drain answer is not ${ACTIVITY_DRAIN_SCHEMA}; ignored.\n`);
        return [];
      }
      if (typeof body.dropped === "number" && body.dropped > 0)
        this.deps.stderr(`the runtime dropped ${body.dropped} activity events.\n`);
      return body.events.filter(isRecord);
    } catch {
      if (!signal.aborted) this.deps.stderr("activity drain could not be reached.\n");
      return [];
    }
  }

  private async forward(signal: AbortSignal): Promise<void> {
    const batch = this.pending.slice(0, FORWARD_BATCH);
    let response: Response;
    try {
      response = await this.deps.fetch(serverUrlOf(this.server.serverUrl, INGEST_PATH), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.server.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ schema: ACTIVITY_INGEST_SCHEMA, events: batch }),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(FORWARD_TIMEOUT_MS)]),
      });
    } catch {
      if (!signal.aborted) this.deps.stderr("activity could not reach the server; will retry.\n");
      return;
    }
    if (response.status === 401) throw invalidCredentialError();
    if (response.ok || response.status === 400) {
      this.pending.splice(0, batch.length);
      if (response.status === 400) {
        const body: unknown = await response.json().catch(() => undefined);
        const code = isRecord(body) && typeof body.code === "string" ? body.code : "invalid";
        this.deps.stderr(`the server refused ${batch.length} activity events (${code}).\n`);
      } else await response.body?.cancel();
      return;
    }
    await response.body?.cancel();
    this.deps.stderr(`activity forward answered HTTP ${response.status}; will retry.\n`);
  }
}
