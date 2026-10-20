import { expect, test } from "bun:test";

import { AppError } from "#src/lib/app-error";
import {
  Route,
  handleAppLogoDownload,
  type AppLogoRouteDependencies,
} from "#src/routes/api/workspaces/$workspaceId/apps/$appKey/logo";

/**
 * The app logo's route, which only serves it (where there is no image CDN): a thin adapter over
 * the registry, which decides who may. Uploads go through `uploadWorkspaceAppLogo`.
 */
const WORKSPACE = "0199f0c4-6d6a-7000-8000-000000000001";
const params = { workspaceId: WORKSPACE, appKey: "acme-notes" };
const url = `https://coforge.test/api/workspaces/${WORKSPACE}/apps/acme-notes/logo`;

function dependencies(overrides: Partial<AppLogoRouteDependencies> = {}): AppLogoRouteDependencies {
  return {
    authenticate: async () => ({ id: "user-1" }),
    registry: () => ({
      readAppLogo: async (viewerUserId, workspaceId, key) => {
        expect([viewerUserId, workspaceId, key]).toEqual(["user-1", WORKSPACE, "acme-notes"]);
        return { body: new Blob([new Uint8Array([7])]), contentType: "image/gif" };
      },
    }),
    ...overrides,
  };
}

test("a read serves the bytes inline as the stored type", async () => {
  const response = await handleAppLogoDownload(new Request(url), params, dependencies());
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/gif");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([7]));
});

test("a signed-out viewer, a malformed path or a refused viewer gets no logo", async () => {
  const signedOut = dependencies({ authenticate: async () => null });
  expect((await handleAppLogoDownload(new Request(url), params, signedOut)).status).toBe(401);
  const malformed = { ...params, workspaceId: "nope" };
  expect((await handleAppLogoDownload(new Request(url), malformed, dependencies())).status).toBe(
    404,
  );
  const refusing = dependencies({
    registry: () => ({
      readAppLogo: async () => {
        throw new AppError("NOT_FOUND");
      },
    }),
  });
  expect((await handleAppLogoDownload(new Request(url), params, refusing)).status).toBe(404);
});

test("the route takes no upload", () => {
  expect(Object.keys(Route.options.server?.handlers ?? {})).toEqual(["GET"]);
});
