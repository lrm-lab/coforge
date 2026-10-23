import { describe, expect, test } from "bun:test";

import { resolveAgentManifest } from "#src/features/apps/app-agent-manifest";
import {
  APP_AGENT_MANIFEST_URL_MAX_LENGTH,
  checkAppInput,
  type AppRegistrationInput,
} from "#src/features/apps/app-registration";

describe("an app's Agent manifest location", () => {
  test("is the explicit URL as written, whatever its path", () => {
    expect(
      resolveAgentManifest({
        agentManifestUrl: "https://api.acme.example/agents/guide.json",
        homepageUrl: "https://notes.acme.example/app",
      }),
    ).toEqual({
      agentManifestUrl: "https://api.acme.example/agents/guide.json",
      agentManifestUrlSource: "explicit",
    });
  });

  test("is the well-known path on the homepage's origin when none is set", () => {
    expect(
      resolveAgentManifest({
        agentManifestUrl: null,
        homepageUrl: "https://notes.acme.example/app/home?x=1",
      }),
    ).toEqual({
      agentManifestUrl: "https://notes.acme.example/.well-known/coforge-agent-manifest.json",
      agentManifestUrlSource: "well_known",
    });
  });

  test("is none when it names no URL and has no homepage", () => {
    expect(resolveAgentManifest({ agentManifestUrl: null, homepageUrl: null })).toEqual({
      agentManifestUrl: null,
      agentManifestUrlSource: null,
    });
  });
});

const valid: AppRegistrationInput = {
  key: "acme-notes",
  name: "Acme Notes",
  description: "",
  whenToUse: "",
  homepageUrl: null,
  redirectUris: [],
  category: "other",
  allowedScopes: ["openid", "profile", "identity"],
};

const refused = (agentManifestUrl: unknown) => {
  const outcome = checkAppInput({ ...valid, agentManifestUrl } as AppRegistrationInput, "patch");
  return outcome.ok ? undefined : outcome.field;
};

describe("the Agent manifest URL rule", () => {
  test("accepts none, or a canonical https URL up to 2000 characters", () => {
    for (const url of [
      null,
      "https://acme.example/.well-known/coforge-agent-manifest.json",
      `https://acme.example/${"a".repeat(APP_AGENT_MANIFEST_URL_MAX_LENGTH - 21)}`,
    ])
      expect([url, refused(url)]).toEqual([url, undefined]);
  });

  test("refuses http, user info, a fragment, a blank, a non-canonical form and a long URL", () => {
    for (const url of [
      "http://acme.example/m.json",
      "https://user:pw@acme.example/m.json",
      "https://acme.example/m.json#top",
      "",
      "https://ACME.example/m.json",
      "javascript:alert(1)",
      3,
      `https://acme.example/${"a".repeat(APP_AGENT_MANIFEST_URL_MAX_LENGTH)}`,
    ])
      expect([url, refused(url)]).toEqual([url, "agentManifestUrl"]);
  });

  test("a registration may leave it out", () => {
    expect(checkAppInput(valid, "registration")).toEqual({ ok: true, value: valid });
  });
});
