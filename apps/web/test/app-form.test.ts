import { describe, expect, test } from "bun:test";

import { EMPTY_APP_DRAFT, draftOf, inputOf } from "#src/features/apps/app-draft";
import { appFormProblem } from "#src/features/apps/app-form";
import type { AppRegistrationInput } from "#src/features/apps/app-registration";
import { AppError } from "#src/lib/app-error";
import {
  AppRegistry,
  type AppRegistryStore,
  type AppView,
} from "#src/server/apps/app-registry.server";

/**
 * What the Settings → Applications form makes of a refusal: the field to show it beside, read from
 * the registry's own errors, so the form and the server cannot name a field differently.
 */
const valid: AppRegistrationInput = {
  key: "acme-notes",
  name: "Acme Notes",
  description: "",
  whenToUse: "",
  homepageUrl: "https://notes.acme.example/",
  redirectUris: ["https://notes.acme.example/cb"],
  category: "other",
  allowedScopes: ["openid", "profile", "identity"],
};

/** One value each field's rule refuses. */
const refused: { [Field in keyof AppRegistrationInput]: AppRegistrationInput[Field] } = {
  key: "Acme",
  name: "",
  description: "x".repeat(501),
  whenToUse: "two\nlines",
  homepageUrl: "http://notes.acme.example/",
  redirectUris: ["https://notes.acme.example/cb", "https://notes.acme.example/cb"],
  category: "games" as AppRegistrationInput["category"],
  allowedScopes: ["openid"],
};

const actor = { workspaceId: "workspace-1", actorUserId: "owner" };

function registry({ keyTaken = false } = {}) {
  const app: AppView = {
    ...valid,
    agentManifestUrl: null,
    ownerWorkspaceId: actor.workspaceId,
    developer: "Acme",
    logoObjectKey: null,
    publishStatus: "private",
    secretRotatedAt: null,
    createdAt: new Date("2026-10-20T00:00:00.000Z"),
    updatedAt: new Date("2026-10-20T00:00:00.000Z"),
  };
  const store: AppRegistryStore = {
    findMember: async () => ({ role: "owner", workspaceSlug: "acme" }),
    listForWorkspace: async () => [],
    find: async () => app,
    create: async () => (keyTaken ? undefined : app),
    update: async () => app,
    delete: async () => ({ logoObjectKey: null }),
    replaceLogo: async () => true,
    findLogo: async () => undefined,
  };
  return new AppRegistry(store, {
    storage: async () => {
      throw new Error("no image store in these tests");
    },
    removalFailed: () => {},
  });
}

async function refusal(attempt: Promise<unknown>): Promise<unknown> {
  try {
    await attempt;
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
}

describe("an app form's problem", () => {
  test("names the field the registry refused, for every field", async () => {
    for (const field of Object.keys(refused) as (keyof AppRegistrationInput)[]) {
      const cause = await refusal(
        registry().registerApp(actor, { ...valid, [field]: refused[field] }),
      );
      expect([field, appFormProblem(cause).field]).toEqual([field, field]);
    }
  });

  test("names the field after the server function carried the refusal as a plain error", () => {
    const sent = new Error("COFORGE_APP_ERROR:INVALID_INPUT:app-redirect-uris-invalid");
    expect(appFormProblem(sent).field).toBe("redirectUris");
  });

  test("puts a taken key beside the key, saying so rather than that it is malformed", async () => {
    const taken = appFormProblem(
      await refusal(registry({ keyTaken: true }).registerApp(actor, valid)),
    );
    const malformed = appFormProblem(
      await refusal(registry().registerApp(actor, { ...valid, key: refused.key })),
    );
    expect(taken.field).toBe("key");
    expect(taken.message).not.toBe(malformed.message);
  });

  test("belongs to no field when the refusal is not about the input", () => {
    for (const cause of [
      new AppError("ACCESS_DENIED"),
      new AppError("NOT_FOUND"),
      new Error("network down"),
    ])
      expect(appFormProblem(cause).field).toBeNull();
    expect(appFormProblem(new AppError("ACCESS_DENIED")).message).not.toBe(
      appFormProblem(new Error("network down")).message,
    );
  });
});

describe("an app form's homepage", () => {
  test("left blank, sends none", () => {
    expect(inputOf({ ...EMPTY_APP_DRAFT, name: "Acme", homepageUrl: "  " }).homepageUrl).toBeNull();
    expect(inputOf({ ...EMPTY_APP_DRAFT, homepageUrl: " https://a.example/ " }).homepageUrl).toBe(
      "https://a.example/",
    );
  });

  test("of an app without one, opens empty", () => {
    const app = {
      ...valid,
      agentManifestUrl: null,
      homepageUrl: null,
      logoUrl: null,
      owned: true,
      listed: false,
      developer: "Acme",
      createdAt: "2026-10-20T00:00:00.000Z",
    };
    expect(draftOf(app).homepageUrl).toBe("");
  });
});
