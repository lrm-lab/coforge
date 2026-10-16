import { HostDirectory, HostDirectoryError } from "./host-directory.server";

export function createHostHttpHandler(dependencies: { directory: HostDirectory; now: () => Date }) {
  return {
    register: (request: Request) => registerHost(request, dependencies),
    heartbeat: (request: Request) => heartbeatHost(request, dependencies),
  };
}

async function registerHost(
  request: Request,
  dependencies: { directory: HostDirectory; now: () => Date },
): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return invalidHostToken();
  const body = await readJson(request);
  if (!body) return invalidRequest();
  try {
    const host = await dependencies.directory.register({
      token,
      nodeKey: typeof body.nodeKey === "string" ? body.nodeKey : "",
      name: typeof body.name === "string" ? body.name : "",
      now: dependencies.now(),
    });
    return Response.json(host);
  } catch (error) {
    return hostError(error);
  }
}

async function heartbeatHost(
  request: Request,
  dependencies: { directory: HostDirectory; now: () => Date },
): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return invalidHostToken();
  const body = await readJson(request);
  if (!body || typeof body.accepting !== "boolean") return invalidRequest();
  try {
    const host = await dependencies.directory.heartbeat({
      token,
      accepting: body.accepting,
      now: dependencies.now(),
    });
    return Response.json(host);
  } catch (error) {
    return hostError(error);
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

function invalidHostToken(): Response {
  return Response.json({ error: { code: 401, message: "invalid host token" } }, { status: 401 });
}

function invalidRequest(): Response {
  return Response.json({ error: { code: 400, message: "invalid request" } }, { status: 400 });
}

function hostError(error: unknown): Response {
  if (error instanceof HostDirectoryError) {
    return Response.json(
      { error: { code: error.status, message: error.message } },
      { status: error.status },
    );
  }
  throw error;
}
