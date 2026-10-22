import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { decodeProtectedHeader } from "jose";

import { CLIENT, ISSUER, NOW_SECONDS, basic, verified } from "./oidc-token-fixture";
import {
  INSTALLATION_ID,
  OTHER_INSTALLATION_ID,
  RESOURCE,
  credentialsRequest,
  installationEndpoints,
} from "./oidc-installation-token-fixture";
import {
  INSTALLATION_FLAGS,
  installationResource,
  type InstallationTokenFlag,
} from "#src/server/authorization-server/installation-tokens.server";

/**
 * Installation tokens at the token endpoint (RFC 6749 §4.4 with the RFC 8707 resource) and their
 * verification, without a database.
 */

let logs: string[];
let info: ReturnType<typeof spyOn>;
beforeEach(() => {
  logs = [];
  info = spyOn(console, "info").mockImplementation((line: string) => void logs.push(line));
});
afterEach(() => info.mockRestore());

async function refusal(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  return (await response.json()) as { error: string };
}

async function issued(scope = "installation:workspace installation:agent") {
  const e = installationEndpoints();
  const response = await e.tokenEndpoint.exchange(credentialsRequest({ form: { scope } }));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { access_token: string };
  return { e, token: body.access_token };
}

test("an app gets a ten-minute installation token for the groups its Workspace approved", async () => {
  const { tokenEndpoint } = installationEndpoints();
  const response = await tokenEndpoint.exchange(credentialsRequest());

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["access_token", "expires_in", "scope", "token_type"]);
  expect(body).toMatchObject({
    token_type: "Bearer",
    expires_in: 600,
    scope: "installation:workspace installation:agent",
  });
  const token = body.access_token as string;
  expect(decodeProtectedHeader(token)).toEqual({ alg: "ES256", kid: "current", typ: "at+jwt" });
  const { payload } = await verified(token, RESOURCE);
  expect(payload).toEqual({
    iss: ISSUER,
    sub: CLIENT.key,
    aud: RESOURCE,
    client_id: CLIENT.key,
    type: "installation",
    installation_id: INSTALLATION_ID,
    workspace_id: "ws-acme",
    scope: "installation:workspace installation:agent",
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + 600,
    jti: expect.any(String),
  });
});

test("client_secret_post authenticates too, and an empty scope asks for no group", async () => {
  const { tokenEndpoint } = installationEndpoints();
  const response = await tokenEndpoint.exchange(
    credentialsRequest({
      authorization: null,
      form: { client_id: CLIENT.key, client_secret: CLIENT.secret, scope: undefined },
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ scope: "" });
});

test("a group that is declared but not approved, or not declared, is invalid_scope", async () => {
  const { tokenEndpoint } = installationEndpoints();
  for (const scope of [
    "installation:channel",
    "installation:computer",
    "installation:agent installation:channel",
  ]) {
    const response = await tokenEndpoint.exchange(credentialsRequest({ form: { scope } }));
    expect(response.status).toBe(400);
    expect((await refusal(response)).error).toBe("invalid_scope");
  }
});

test("a scope that is not an installation scope is invalid_scope", async () => {
  const { tokenEndpoint } = installationEndpoints();
  const response = await tokenEndpoint.exchange(credentialsRequest({ form: { scope: "openid" } }));
  expect(response.status).toBe(400);
  expect((await refusal(response)).error).toBe("invalid_scope");
});

test("an unknown installation, another app's, a missing or foreign resource is invalid_target", async () => {
  const { tokenEndpoint } = installationEndpoints();
  for (const resource of [
    installationResource(ISSUER, "0192d3a0-0000-7000-8000-0000000000ff"),
    installationResource(ISSUER, OTHER_INSTALLATION_ID),
    installationResource(ISSUER, "not-a-uuid"),
    `https://evil.example/api/app-installations/${INSTALLATION_ID}`,
    undefined,
  ]) {
    const response = await tokenEndpoint.exchange(credentialsRequest({ form: { resource } }));
    expect(response.status).toBe(400);
    expect((await refusal(response)).error).toBe("invalid_target");
  }
});

test("with the flag off for the Workspace the grant is unauthorized_client", async () => {
  const { tokenEndpoint, flag } = installationEndpoints();
  flag.on = false;
  const response = await tokenEndpoint.exchange(credentialsRequest());
  expect(response.status).toBe(400);
  expect((await refusal(response)).error).toBe("unauthorized_client");
});

test("with only the setup flag on, a token with no data group is issued and one asking for data is not", async () => {
  const { tokenEndpoint, installationTokens, flag, clock } = installationEndpoints();
  flag.on = false;
  flag.setup = true;
  const bare = await tokenEndpoint.exchange(credentialsRequest({ form: { scope: undefined } }));
  expect(bare.status).toBe(200);
  const { access_token } = (await bare.json()) as { access_token: string };
  const verify = (name: InstallationTokenFlag) =>
    installationTokens.verify(access_token, INSTALLATION_ID, clock.now, name);
  expect(await verify(INSTALLATION_FLAGS.setup)).toMatchObject({ status: "verified", groups: [] });
  // The same token reads no data while that flag is off.
  expect(await verify(INSTALLATION_FLAGS.data)).toEqual({
    status: "refused",
    error: "invalid_token",
  });
  const data = await tokenEndpoint.exchange(credentialsRequest());
  expect(data.status).toBe(400);
  expect((await refusal(data)).error).toBe("unauthorized_client");
  // And the setup API stops with its flag.
  flag.setup = false;
  expect(await verify(INSTALLATION_FLAGS.setup)).toEqual({
    status: "refused",
    error: "invalid_token",
  });
});

test("a token is issued by the flags and the scope: data groups need the data flag, the setup flag alone allows only an empty scope", async () => {
  const cells = [
    // [data flag, setup flag, scope, expected]
    [false, false, "", "unauthorized_client"],
    [false, false, "installation:workspace", "unauthorized_client"],
    [false, true, "", "issued"],
    [false, true, "installation:workspace", "unauthorized_client"],
    [true, false, "", "issued"],
    [true, false, "installation:workspace", "issued"],
    [true, true, "", "issued"],
    [true, true, "installation:workspace", "issued"],
  ] as const;
  for (const [data, setupOn, scope, expected] of cells) {
    const { tokenEndpoint, flag } = installationEndpoints();
    flag.on = data;
    flag.setup = setupOn;
    const response = await tokenEndpoint.exchange(
      credentialsRequest({ form: { scope: scope || undefined } }),
    );
    const label = `data=${data} setup=${setupOn} scope="${scope}"`;
    if (expected === "issued") {
      expect(response.status, label).toBe(200);
      expect(await response.json(), label).toMatchObject({ scope });
    } else {
      expect(response.status, label).toBe(400);
      expect((await refusal(response)).error, label).toBe(expected);
    }
  }
});

test("a token verifies behind the flag its API names, whatever the other flag says", async () => {
  for (const scope of ["", "installation:workspace"]) {
    for (const data of [false, true]) {
      for (const setupOn of [false, true]) {
        for (const api of Object.values(INSTALLATION_FLAGS)) {
          const e = installationEndpoints();
          const response = await e.tokenEndpoint.exchange(
            credentialsRequest({ form: { scope: scope || undefined } }),
          );
          const { access_token } = (await response.json()) as { access_token: string };
          e.flag.on = data;
          e.flag.setup = setupOn;
          const on = api === INSTALLATION_FLAGS.data ? data : setupOn;
          const result = await e.installationTokens.verify(
            access_token,
            INSTALLATION_ID,
            e.clock.now,
            api,
          );
          const label = `scope="${scope}" data=${data} setup=${setupOn} api=${api}`;
          if (on) expect(result, label).toMatchObject({ status: "verified" });
          else expect(result, label).toEqual({ status: "refused", error: "invalid_token" });
        }
      }
    }
  }
});

test("a wrong secret is invalid_client, and no resource is looked up first", async () => {
  const { tokenEndpoint } = installationEndpoints();
  const response = await tokenEndpoint.exchange(
    credentialsRequest({ authorization: basic(CLIENT.key, "wrong") }),
  );
  expect(response.status).toBe(401);
  expect((await refusal(response)).error).toBe("invalid_client");
});

test("each issue and refusal logs one JSON line naming the app, installation and outcome, never the token", async () => {
  const { e } = await issued();
  await e.tokenEndpoint.exchange(credentialsRequest({ form: { scope: "installation:computer" } }));
  const [first, second] = logs.map((line) => JSON.parse(line));
  expect(first).toEqual({
    event: "authorization_server:installation_token_issued",
    app_key: CLIENT.key,
    installation_id: INSTALLATION_ID,
    groups: ["installation:workspace", "installation:agent"],
    outcome: "issued",
  });
  expect(second).toMatchObject({
    event: "authorization_server:installation_token_refused",
    outcome: "invalid_scope",
  });
});

test("a token verifies for its installation while the approval stands", async () => {
  const { e, token } = await issued();
  expect(
    await e.installationTokens.verify(token, INSTALLATION_ID, e.clock.now, INSTALLATION_FLAGS.data),
  ).toEqual({
    status: "verified",
    installationId: INSTALLATION_ID,
    workspaceId: "ws-acme",
    appKey: CLIENT.key,
    groups: ["workspace", "agent"],
  });
});

test("a token is invalid_token for another installation, garbage, or after it expires", async () => {
  const { e, token } = await issued();
  const later = new Date(e.clock.now.getTime() + 601_000);
  for (const [bearer, id, at] of [
    [token, OTHER_INSTALLATION_ID, e.clock.now],
    ["not.a.jwt", INSTALLATION_ID, e.clock.now],
    [token, INSTALLATION_ID, later],
  ] as const)
    expect(await e.installationTokens.verify(bearer, id, at, INSTALLATION_FLAGS.data)).toEqual({
      status: "refused",
      error: "invalid_token",
    });
});

test("a person's access token is not an installation token", async () => {
  const { e } = await issued();
  const { code } = e.issueCode();
  const response = await e.tokenEndpoint.exchange(
    new Request(`${ISSUER}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basic(CLIENT.key, CLIENT.secret),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://notes.acme.example/cb",
        code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      }).toString(),
    }),
  );
  const { access_token } = (await response.json()) as { access_token: string };
  expect(
    (
      await e.installationTokens.verify(
        access_token,
        INSTALLATION_ID,
        e.clock.now,
        INSTALLATION_FLAGS.data,
      )
    ).status,
  ).toBe("refused");
});

test("narrowing the approval makes a token insufficient_scope at once", async () => {
  const { e, token } = await issued();
  e.installation.current!.approved = ["workspace"];
  expect(
    await e.installationTokens.verify(token, INSTALLATION_ID, e.clock.now, INSTALLATION_FLAGS.data),
  ).toEqual({
    status: "refused",
    error: "insufficient_scope",
  });
  e.installation.current!.approved = ["workspace", "agent"];
  e.installation.current!.declared = ["workspace"];
  expect(
    (
      await e.installationTokens.verify(
        token,
        INSTALLATION_ID,
        e.clock.now,
        INSTALLATION_FLAGS.data,
      )
    ).status,
  ).toBe("refused");
});

test("an uninstalled app's token, or one for a Workspace whose flag went off, is invalid_token", async () => {
  const { e, token } = await issued();
  e.flag.on = false;
  expect(
    await e.installationTokens.verify(token, INSTALLATION_ID, e.clock.now, INSTALLATION_FLAGS.data),
  ).toEqual({
    status: "refused",
    error: "invalid_token",
  });
  e.flag.on = true;
  e.installation.current = undefined;
  expect(
    await e.installationTokens.verify(token, INSTALLATION_ID, e.clock.now, INSTALLATION_FLAGS.data),
  ).toEqual({
    status: "refused",
    error: "invalid_token",
  });
});
