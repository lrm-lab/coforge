import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { AppInstallationSetup } from "#src/server/app-installation-setup/app-installation-setup.server";
import type {
  AppInstallationSetupStore,
  InstallationSetupRow,
} from "#src/server/app-installation-setup/app-installation-setup.server";
import { SetupEndpoint } from "#src/server/authorization-server/setup-endpoint.server";
import { CLIENT, ISSUER, basic } from "./oidc-token-fixture";
import {
  INSTALLATION_ID,
  OTHER_INSTALLATION_ID,
  credentialsRequest,
  installationEndpoints,
} from "./oidc-installation-token-fixture";

/**
 * The installation setup API an app calls: reading and reporting an installation's setup with an
 * installation token, and finding the installation with the client credentials. Real minted
 * tokens and the real domain module over an in-memory store; the SQL is in
 * app-installation-setup.integration.test.ts.
 */

let info: ReturnType<typeof spyOn>;
beforeEach(() => {
  info = spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => info.mockRestore());

const WORKSPACE_ID = "0192d3a0-0000-7000-8000-0000000000aa";
const PAGE = "https://acme.example/setup";

/** Holds the one installation `INSTALLATION_ID`, as the SQL store treats it. */
function memoryStore() {
  const row: InstallationSetupRow = {
    installationId: INSTALLATION_ID,
    appKey: CLIENT.key,
    ownerWorkspaceId: WORKSPACE_ID,
    workspaceId: WORKSPACE_ID,
    workspaceSlug: "acme",
    url: PAGE,
    description: "Connect your account",
    revision: 1,
    completedRevision: null,
    completedAt: null,
  };
  const store: AppInstallationSetupStore = {
    findMember: async () => undefined,
    listInstalled: async () => [{ ...row }],
    findInstalled: async (workspaceId, key) =>
      key === CLIENT.key && workspaceId === WORKSPACE_ID ? { ...row } : undefined,
    findInstallation: async (id) => (id === INSTALLATION_ID ? { ...row } : undefined),
    declare: async () => true,
    async record({ revision, complete, at }) {
      if (row.url === null || row.revision !== revision) return false;
      if (!complete) Object.assign(row, { completedRevision: null, completedAt: null });
      else if (row.completedRevision !== revision)
        Object.assign(row, { completedRevision: revision, completedAt: at });
      return true;
    },
  };
  return { row, store };
}

function setup() {
  const e = installationEndpoints();
  e.flag.on = false;
  e.flag.setup = true;
  e.installation.current!.workspaceId = WORKSPACE_ID;
  const { row, store } = memoryStore();
  const domain = new AppInstallationSetup(
    store,
    async () => e.flag.setup,
    async () => undefined,
    () => e.clock.now,
  );
  const endpoint = new SetupEndpoint(e.installationTokens, domain, e.store, e.options);
  const url = `${ISSUER}/api/app-installations/${INSTALLATION_ID}/setup`;
  return {
    e,
    row,
    endpoint,
    /** A token with no data group, as an app that only reports setup would ask for. */
    async token(scope?: string) {
      const response = await e.tokenEndpoint.exchange(
        credentialsRequest({ form: { scope: scope ?? undefined } }),
      );
      return ((await response.json()) as { access_token: string }).access_token;
    },
    call(method: "GET" | "PUT", token: string | null, body?: unknown, id = INSTALLATION_ID) {
      return endpoint.answer(
        new Request(url, {
          method,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined
            ? {}
            : { body: typeof body === "string" ? body : JSON.stringify(body) }),
        }),
        id,
      );
    },
    lookup(authorization: string | null, body: unknown = { workspace_id: WORKSPACE_ID }) {
      return endpoint.lookup(
        new Request(`${ISSUER}/api/app-installations/lookup`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(authorization ? { authorization } : {}),
          },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
      );
    },
  };
}

const json = async (response: Response) => {
  expect(response.headers.get("cache-control")).toBe("no-store");
  return (await response.json()) as Record<string, unknown>;
};

test("an installation token of no scope reads the setup, with the page's parameters", async () => {
  const s = setup();
  const response = await s.call("GET", await s.token());
  expect(response.status).toBe(200);
  const body = await json(response);
  expect(body).toMatchObject({
    status: "pending",
    description: "Connect your account",
    revision: 1,
    completed_at: null,
  });
  const link = new URL(body.url as string);
  expect(Object.fromEntries(link.searchParams)).toEqual({
    installation_id: INSTALLATION_ID,
    workspace_id: WORKSPACE_ID,
    setup_revision: "1",
  });
});

test("an app with no setup page reads not_required and a null url", async () => {
  const s = setup();
  s.row.url = null;
  expect(await json(await s.call("GET", await s.token()))).toMatchObject({
    status: "not_required",
    url: null,
  });
});

test("without a token the answer is the bare challenge; a bad one names its error", async () => {
  const s = setup();
  const bare = await s.call("GET", null);
  expect(bare.status).toBe(401);
  expect(bare.headers.get("www-authenticate")).toBe(`Bearer realm="${ISSUER}"`);
  expect(bare.headers.get("cache-control")).toBe("no-store");
  const malformed = await s.endpoint.answer(
    new Request("https://x/", { headers: { authorization: "Bearer a b" } }),
    INSTALLATION_ID,
  );
  expect(malformed.status).toBe(400);
  expect(malformed.headers.get("www-authenticate")).toContain('error="invalid_request"');
  const token = await s.token();
  for (const [bearer, id] of [
    ["not.a.jwt", INSTALLATION_ID],
    [token, OTHER_INSTALLATION_ID],
    [token, "not-a-uuid"],
  ] as const) {
    const refused = await s.call("GET", bearer, undefined, id);
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toContain('error="invalid_token"');
  }
});

test("while the flag is off the token is invalid_token, as if the feature were not there", async () => {
  const s = setup();
  const token = await s.token();
  s.e.flag.setup = false;
  for (const method of ["GET", "PUT"] as const) {
    const response = await s.call(method, token, { revision: 1, status: "complete" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  }
  expect(s.row.completedRevision).toBeNull();
});

test("a token whose data group was withdrawn is insufficient_scope", async () => {
  const s = setup();
  s.e.flag.on = true;
  const token = await s.token("installation:workspace");
  s.e.installation.current!.approved = [];
  const response = await s.call("GET", token);
  expect(response.status).toBe(403);
  expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
});

test("reporting complete or pending answers the setup, and repeating it changes nothing", async () => {
  const s = setup();
  const token = await s.token();
  const first = await s.call("PUT", token, { revision: 1, status: "complete" });
  expect(first.status).toBe(200);
  const done = await json(first);
  expect(done).toMatchObject({ status: "complete", revision: 1 });
  expect(typeof done.completed_at).toBe("string");
  const again = await json(await s.call("PUT", token, { revision: 1, status: "complete" }));
  expect(again.completed_at).toBe(done.completed_at);
  expect(await json(await s.call("GET", token))).toMatchObject({ status: "complete" });
  expect(await json(await s.call("PUT", token, { revision: 1, status: "pending" }))).toMatchObject({
    status: "pending",
    completed_at: null,
  });
});

test("a report for a revision the app moved on from is 409, as is one for an app with no page", async () => {
  const s = setup();
  const token = await s.token();
  const stale = await s.call("PUT", token, { revision: 0, status: "complete" });
  expect(stale.status).toBe(409);
  expect(await json(stale)).toMatchObject({ error: "stale_revision" });
  expect(s.row.completedRevision).toBeNull();
  s.row.url = null;
  const none = await s.call("PUT", token, { revision: 1, status: "complete" });
  expect(none.status).toBe(409);
  expect(await json(none)).toMatchObject({ error: "setup_not_required" });
});

test("a report with fields that are not a revision and a status is 400", async () => {
  const s = setup();
  const token = await s.token();
  for (const body of [
    "not json",
    "[]",
    {},
    { revision: -1, status: "complete" },
    { revision: 1.5, status: "complete" },
    { revision: "1", status: "complete" },
    { revision: 1, status: "done" },
    { revision: 1 },
  ]) {
    const response = await s.call("PUT", token, body);
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ error: "invalid_request" });
  }
});

test("an app finds its installation in a Workspace with its client credentials", async () => {
  const s = setup();
  const response = await s.lookup(basic(CLIENT.key, CLIENT.secret));
  expect(response.status).toBe(200);
  expect(await json(response)).toMatchObject({
    installation_id: INSTALLATION_ID,
    workspace_id: WORKSPACE_ID,
    setup: { status: "pending", revision: 1 },
  });
});

test("a lookup needs client_secret_basic; a wrong secret, none, or a secret in the body is 401", async () => {
  const s = setup();
  for (const [authorization, body] of [
    [basic(CLIENT.key, "wrong"), undefined],
    [null, undefined],
    [null, { workspace_id: WORKSPACE_ID, client_id: CLIENT.key, client_secret: CLIENT.secret }],
    [basic("nobody", CLIENT.secret), undefined],
  ] as const) {
    const response = await s.lookup(authorization, body);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(`Basic realm="${ISSUER}"`);
    expect(await json(response)).toMatchObject({ error: "invalid_client" });
  }
});

test("a lookup of a Workspace the app is not installed in, or with the flag off, is 404", async () => {
  const s = setup();
  const authorization = basic(CLIENT.key, CLIENT.secret);
  const other = await s.lookup(authorization, { workspace_id: OTHER_INSTALLATION_ID });
  expect(other.status).toBe(404);
  expect(await json(other)).toMatchObject({ error: "not_found" });
  s.e.flag.setup = false;
  expect((await s.lookup(authorization)).status).toBe(404);
});

test("a lookup without a Workspace id is 400", async () => {
  const s = setup();
  const authorization = basic(CLIENT.key, CLIENT.secret);
  for (const body of ["nope", {}, { workspace_id: "acme" }, { workspace_id: 7 }, []]) {
    const response = await s.lookup(authorization, body);
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ error: "invalid_request" });
  }
});
