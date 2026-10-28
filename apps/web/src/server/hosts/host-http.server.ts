import { HostDirectory, HostDirectoryError } from "./host-directory.server";
import { parseHostImageReport, type CloudImageInventory } from "./cloud-image-inventory.server";
import { bearerToken, readJson } from "./host-request.server";

export function createHostHttpHandler(dependencies: {
  directory: HostDirectory;
  now: () => Date;
  images?: Pick<CloudImageInventory, "replace">;
}) {
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
  dependencies: {
    directory: HostDirectory;
    now: () => Date;
    images?: Pick<CloudImageInventory, "replace">;
  },
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
    const snapshot = parseHostImageReport(body);
    if (snapshot && dependencies.images) await dependencies.images.replace(snapshot);
    return Response.json(host);
  } catch (error) {
    return hostError(error);
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
