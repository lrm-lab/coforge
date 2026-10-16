import { HostJobError, HostJobs } from "./host-jobs.server";

export function createHostJobHttpHandler(dependencies: { jobs: HostJobs; now: () => Date }) {
  return {
    claim: (request: Request) => claimJob(request, dependencies),
    report: (request: Request, jobId: string) => reportJob(request, jobId, dependencies),
  };
}

async function claimJob(
  request: Request,
  dependencies: { jobs: HostJobs; now: () => Date },
): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return error(401, "invalid host token");
  try {
    const job = await dependencies.jobs.claim({ token });
    return Response.json({ job: job ?? null });
  } catch (cause) {
    return jobError(cause);
  }
}

async function reportJob(
  request: Request,
  jobId: string,
  dependencies: { jobs: HostJobs; now: () => Date },
): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return error(401, "invalid host token");
  const body = await readJson(request);
  if (!body) return error(400, "invalid request");
  try {
    await dependencies.jobs.report({
      token,
      jobId,
      containerId: typeof body.containerId === "string" ? body.containerId : undefined,
      now: dependencies.now(),
    });
    return Response.json({ ok: true });
  } catch (cause) {
    return jobError(cause);
  }
}

function bearerToken(request: Request): string | undefined {
  const match = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "");
  return match?.[1];
}

async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body = (await request.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
    return body as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function error(status: number, message: string): Response {
  return Response.json({ error: { code: status, message } }, { status });
}

function jobError(cause: unknown): Response {
  if (cause instanceof HostJobError) return error(cause.status, cause.message);
  throw cause;
}
