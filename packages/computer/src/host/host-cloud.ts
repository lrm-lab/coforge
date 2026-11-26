import { z } from "zod";

export type HostJobOperation = "create" | "delete" | "attach" | "update" | "runtime";

export type HostHeartbeatReport = {
  accepting: boolean;
  image?: { id: string; version?: string };
  computers?: Array<{ computerId: string; imageId: string }>;
};

export type ClaimedContainerJob = {
  jobId: string;
  operation: HostJobOperation;
  computerId: string;
  workspaceId: string;
  workspaceSlug: string;
  name: string;
  daemonApiKey: string | null;
  /** The cloud refused this binding's credential: the attach must replace whatever key the
   * container stores, including an sk_computer that may itself be revoked. */
  replaceCredential?: boolean;
};

type HostFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class HttpHostCloud {
  constructor(
    private readonly fetchImpl: HostFetch,
    serverUrl: string,
  ) {
    this.origin = serverUrl.replace(/\/+$/, "");
  }

  private readonly origin: string;

  async register(input: { token: string; nodeKey: string; name: string }): Promise<void> {
    await this.post("/api/hosts/register", input.token, {
      nodeKey: input.nodeKey,
      name: input.name,
    });
  }

  async heartbeat(token: string, report: HostHeartbeatReport): Promise<void> {
    await this.post("/api/hosts/heartbeat", token, report);
  }

  async claim(token: string): Promise<ClaimedContainerJob | null> {
    const body = (await this.post("/api/hosts/jobs/claim", token)) as { job?: unknown };
    if (body.job == null) return null;
    return claimedJob(body.job);
  }

  async report(token: string, jobId: string, containerId?: string): Promise<void> {
    await this.post(
      `/api/hosts/jobs/${encodeURIComponent(jobId)}/report`,
      token,
      containerId ? { containerId } : {},
    );
  }

  private async post(
    path: string,
    token: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.fetchImpl(`${this.origin}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(text || `host request failed (${response.status})`);
    if (!text) return {};
    return JSON.parse(text) as unknown;
  }
}

const nonEmptyString = z.string().min(1);

const claimedContainerJobSchema = z.object({
  jobId: nonEmptyString,
  operation: z.enum(["create", "delete", "attach", "update", "runtime"]),
  computerId: nonEmptyString,
  workspaceId: nonEmptyString,
  workspaceSlug: nonEmptyString,
  name: nonEmptyString,
  daemonApiKey: nonEmptyString.nullish().transform((value) => value ?? null),
  replaceCredential: z.unknown().transform((value) => value === true),
});

function claimedJob(value: unknown): ClaimedContainerJob {
  const parsed = claimedContainerJobSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid claimed job");
  return parsed.data;
}
