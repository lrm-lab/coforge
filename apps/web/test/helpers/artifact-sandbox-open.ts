import type { ArtifactSandbox } from "#src/server/artifacts/artifact-sandbox.server";

export const FRAME = { "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Site": "cross-site" };

export const subresource = (dest: string) => ({
  "Sec-Fetch-Dest": dest,
  "Sec-Fetch-Site": "same-origin",
});

export async function openLink(service: ArtifactSandbox, url: string): Promise<Response> {
  return service.serve(new Request(url, { headers: FRAME }));
}

export async function openPage(
  service: ArtifactSandbox,
  url: string,
): Promise<{ filesUrl: string; response: Response }> {
  const redirect = await openLink(service, url);
  if (redirect.status !== 302) throw new Error(`open answered ${redirect.status}`);
  const location = new URL(redirect.headers.get("location")!, url);
  const response = await service.serve(new Request(location, { headers: FRAME }));
  const filesUrl = location.href.slice(
    0,
    location.href.indexOf("/", location.href.indexOf("/_f/") + 4) + 1,
  );
  return { filesUrl, response };
}

export const fileRequest = (
  filesUrl: string,
  path: string,
  dest = "image",
  init: RequestInit = {},
) => new Request(`${filesUrl}${path}`, { ...init, headers: subresource(dest) });
