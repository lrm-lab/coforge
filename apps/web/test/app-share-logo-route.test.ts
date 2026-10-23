import { expect, test } from "bun:test";

import { AppError } from "#src/lib/app-error";
import {
  Route,
  handleSharedLogoDownload,
  type SharedLogoRouteDependencies,
} from "#src/routes/api/apps/share/$token/logo";

/** The share page's logo route: a thin adapter that serves the bytes uncached, only to a signed-in
 * person holding a live token (the module decides). */
const url = "https://coforge.test/api/apps/share/tok/logo";
const dependencies = (
  overrides: Partial<SharedLogoRouteDependencies> = {},
): SharedLogoRouteDependencies => ({
  authenticate: async () => ({ id: "user-1" }),
  installations: () => ({
    sharedLogo: async (token) => {
      expect(token).toBe("tok");
      return { objectKey: "k", contentType: "image/png" };
    },
  }),
  open: async () => ({ body: new Blob([new Uint8Array([7])]) }),
  ...overrides,
});

test("a live token serves the bytes, never cached", async () => {
  const response = await handleSharedLogoDownload(
    new Request(url),
    { token: "tok" },
    dependencies(),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([7]));
});

test("signed out, a dead token or a missing object gets no logo", async () => {
  const signedOut = dependencies({ authenticate: async () => null });
  expect(
    (await handleSharedLogoDownload(new Request(url), { token: "tok" }, signedOut)).status,
  ).toBe(401);
  const dead = dependencies({
    installations: () => ({
      sharedLogo: async () => {
        throw new AppError("NOT_FOUND");
      },
    }),
  });
  expect((await handleSharedLogoDownload(new Request(url), { token: "tok" }, dead)).status).toBe(
    404,
  );
  const missing = dependencies({ open: async () => null });
  expect((await handleSharedLogoDownload(new Request(url), { token: "tok" }, missing)).status).toBe(
    404,
  );
});

test("the route takes no upload", () => {
  expect(Object.keys(Route.options.server?.handlers ?? {})).toEqual(["GET"]);
});
